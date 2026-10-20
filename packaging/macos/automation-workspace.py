"""Private encrypted-image operations for the native workspace owner.

Not an authority service: the signed native coordinator must obtain a current
Vault projection and local consent before calling this process. It accepts one
bounded stdin request, never resolves credentials itself, never writes a secret
or invokes a shell, and never deletes an image or forces an unmount.
"""
import fcntl
import json
import os
from pathlib import Path
import plistlib
import pwd
import re
import stat
import subprocess
import sys
import time
import uuid

LIMIT = 16 * 1024
RESERVE = 8 * 1024**3
TOOLS = {'PATH': '/usr/bin:/bin:/usr/sbin:/sbin', 'LC_ALL': 'C'}


class Refusal(Exception):
    def __init__(self, code):
        self.code = code


def private_directory(path, create=False):
    if create:
        try:
            path.mkdir(mode=0o700)
        except FileExistsError:
            pass
    info = path.lstat()
    if (not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid()
            or stat.S_IMODE(info.st_mode) & 0o077 or path.resolve() != path):
        raise Refusal('unsafe_storage')
    return info


def parent_directories(home, create, allow_missing=False):
    # An environment variable or request cannot redirect the managed root.
    target = home / 'Library/Application Support/Josi/Automation'
    for path in reversed((target, *target.parents)):
        if path == Path('/'):
            continue
        if not path.exists() and create and (path == home or home in path.parents):
            path.mkdir(mode=0o700)
        if allow_missing and not path.exists() and not path.is_symlink():
            return target
        info = path.lstat()
        if (not stat.S_ISDIR(info.st_mode) or info.st_uid not in (0, os.getuid())
                or stat.S_IMODE(info.st_mode) & 0o022 or path.resolve() != path):
            raise Refusal('unsafe_storage')
    private_directory(target)
    return target


def regular(path):
    info = path.lstat()
    if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
            or stat.S_IMODE(info.st_mode) & 0o077 or info.st_nlink != 1):
        raise Refusal('unsafe_storage')
    return info


def tool(args, password=None, timeout=120):
    # hdiutil remains the compatibility route on supported macOS 14.2+.
    # Its newer deprecation notice is not forwarded as a product diagnostic.
    supplied = bytearray(password.encode('ascii') + b'\0') if password is not None else None
    try:
        result = subprocess.run(['/usr/bin/hdiutil', *args], input=supplied,
                                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                env=TOOLS, cwd='/', timeout=timeout, check=False)
    except (OSError, subprocess.TimeoutExpired):
        raise Refusal('disk_operation_unconfirmed') from None
    finally:
        if supplied is not None:
            supplied[:] = b'\0' * len(supplied)
    if result.returncode != 0 or len(result.stdout) > 4 * 1024 * 1024:
        raise Refusal('disk_operation_unconfirmed')
    return result.stdout


class WorkspaceImage:
    def __init__(self, identifier, create=False):
        if os.getuid() == 0 or os.getuid() != os.geteuid():
            raise Refusal('gui_owner_required')
        self.identifier = identifier
        home = Path(pwd.getpwuid(os.getuid()).pw_dir)
        self.root = parent_directories(home, create) / identifier
        private_directory(self.root, create=create)
        self.image = self.root / 'Workspace.sparsebundle'
        self.mount = self.root / 'Mounted'
        self.journal = self.root / 'storage.json'
        flags = os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC
        self.lock = os.open(self.root / 'storage.lock', flags, 0o600)
        try:
            regular(self.root / 'storage.lock')
            fcntl.flock(self.lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except (OSError, Refusal):
            os.close(self.lock)
            raise Refusal('workspace_busy_or_unsafe') from None

    def close(self):
        os.close(self.lock)

    def record(self):
        if not self.journal.exists():
            if self.journal.is_symlink() or self.image.exists() or self.image.is_symlink():
                raise Refusal('storage_needs_repair')
            return None
        if regular(self.journal).st_size > LIMIT:
            raise Refusal('storage_needs_repair')
        value = json.loads(self.journal.read_bytes())
        if (not isinstance(value, dict)
                or set(value) != {'schemaVersion', 'workspaceId', 'capacityGiB', 'imageCreated', 'state', 'updatedAt'}
                or type(value['schemaVersion']) is not int or value['schemaVersion'] != 1 or value['workspaceId'] != self.identifier
                or type(value['capacityGiB']) is not int or not 64 <= value['capacityGiB'] <= 512
                or type(value['imageCreated']) is not bool
                or type(value['updatedAt']) is not int or value['updatedAt'] < 0
                or value['state'] not in {'creating', 'image_ready', 'attaching', 'mounted', 'detaching', 'needs_repair'}):
            raise Refusal('storage_needs_repair')
        return value

    def save(self, value, state):
        data = {**value, 'state': state, 'updatedAt': int(time.time())}
        if self.journal.exists() or self.journal.is_symlink():
            regular(self.journal)
        temporary = self.root / ('.storage-' + str(uuid.uuid4()))
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
        try:
            with os.fdopen(fd, 'wb') as stream:
                stream.write(json.dumps(data, separators=(',', ':')).encode())
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, self.journal)
        finally:
            temporary.unlink(missing_ok=True)
        return data

    def attachments(self):
        data = plistlib.loads(tool(['info', '-plist']))
        if not isinstance(data, dict) or not isinstance(data.get('images'), list) or len(data['images']) > 1024:
            raise Refusal('storage_inventory_unavailable')
        matches = []
        for entry in data['images']:
            if not isinstance(entry, dict):
                raise Refusal('storage_inventory_unavailable')
            path = entry.get('image-path')
            if isinstance(path, str) and os.path.realpath(path) == str(self.image):
                matches.append(entry)
        if len(matches) > 1:
            raise Refusal('storage_needs_repair')
        if not matches:
            if self.mount.exists() and self.mount.stat().st_dev != self.root.stat().st_dev:
                raise Refusal('storage_needs_repair')
            return None
        mounted = [entity for entity in matches[0].get('system-entities', []) if entity.get('mount-point')]
        if len(mounted) != 1 or mounted[0].get('mount-point') != str(self.mount):
            raise Refusal('storage_needs_repair')
        info = self.mount.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_dev == self.root.stat().st_dev:
            raise Refusal('storage_needs_repair')
        return info

    def validate_image(self):
        private_directory(self.image)
        count = 0
        def unreadable(_error):
            raise Refusal('unsafe_storage')
        for root, directories, files in os.walk(self.image, followlinks=False, onerror=unreadable):
            for name in directories + files:
                count += 1
                if count > 131072:
                    raise Refusal('unsupported_image')
                path = Path(root) / name
                info = path.lstat()
                if (info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o022
                        or not (stat.S_ISREG(info.st_mode) or stat.S_ISDIR(info.st_mode))
                        or stat.S_ISREG(info.st_mode) and info.st_nlink != 1):
                    raise Refusal('unsafe_storage')

    def status(self):
        record = self.record()
        if record and record['imageCreated']:
            private_directory(self.image)
        mounted = self.attachments()
        state = record['state'] if record else 'uninitialized'
        if state in {'creating', 'attaching', 'detaching'}:
            state = 'needs_repair'
        return {'schemaVersion': 1, 'workspaceId': self.identifier,
                'capacityGiB': record['capacityGiB'] if record else None,
                'imageCreated': bool(record and record['imageCreated']),
                'mounted': mounted is not None, 'volumeDevice': mounted.st_dev if mounted else None,
                'state': state}

    def create(self, capacity, password):
        if self.record() is not None or self.image.exists() or self.image.is_symlink() or self.attachments():
            raise Refusal('workspace_already_exists')
        free = os.statvfs(self.root)
        if free.f_bavail * free.f_frsize < 64 * 1024**3 + RESERVE:
            raise Refusal('insufficient_storage')
        record = self.save({'schemaVersion': 1, 'workspaceId': self.identifier,
                            'capacityGiB': capacity, 'imageCreated': False}, 'creating')
        try:
            tool(['create', '-size', str(capacity) + 'g', '-fs', 'APFS', '-type', 'SPARSEBUNDLE',
                  '-volname', 'Josi Automation', '-encryption', 'AES-256', '-stdinpass',
                  '-nospotlight', str(self.image)], password, timeout=180)
            self.validate_image()
            if self.attachments():
                raise Refusal('storage_needs_repair')
            self.save({**record, 'imageCreated': True}, 'image_ready')
        except Exception:
            self.save(record, 'needs_repair')
            raise
        return self.status()

    def attach(self, password):
        record = self.record()
        if not record or not record['imageCreated'] or record['state'] != 'image_ready':
            raise Refusal('storage_needs_repair')
        self.validate_image()
        if self.attachments():
            raise Refusal('workspace_already_mounted')
        private_directory(self.mount, create=True)
        if any(self.mount.iterdir()):
            raise Refusal('unsafe_storage')
        free = os.statvfs(self.root)
        if free.f_bavail * free.f_frsize < RESERVE:
            raise Refusal('insufficient_storage')
        self.save(record, 'attaching')
        try:
            tool(['attach', '-stdinpass', '-nobrowse', '-noautoopen', '-mountpoint',
                  str(self.mount), str(self.image)], password)
            mounted = self.attachments()
            if not mounted or mounted.st_uid != os.getuid():
                raise Refusal('storage_needs_repair')
            self.mount.chmod(0o700)
            private_directory(self.mount)
            self.save(record, 'mounted')
        except Exception:
            self.save(record, 'needs_repair')
            raise
        return self.status()

    def detach(self):
        record = self.record()
        if not record:
            raise Refusal('workspace_missing')
        self.save(record, 'detaching')
        try:
            if self.attachments():
                # The private managed mount point avoids a stale /dev/diskN
                # name. No force flag, unrelated volume or recursive cleanup.
                tool(['detach', str(self.mount)])
            if self.attachments():
                raise Refusal('storage_needs_repair')
            self.save(record, 'image_ready' if record['imageCreated'] else 'needs_repair')
        except Exception:
            self.save(record, 'needs_repair')
            raise
        return self.status()


def main():
    os.umask(0o077)
    request = sys.stdin.buffer.read(LIMIT + 1)
    image = None
    try:
        if sys.platform != 'darwin' or len(sys.argv) != 1 or len(request) > LIMIT:
            raise Refusal('invalid_request')
        value = json.loads(request)
        if not isinstance(value, dict) or type(value.get('schemaVersion')) is not int or value['schemaVersion'] != 1:
            raise Refusal('invalid_request')
        operation = value.get('operation')
        fields = {'schemaVersion', 'operation', 'workspaceId'}
        if operation in {'create', 'attach'}:
            fields.add('imagePassword')
            if not isinstance(value.get('imagePassword'), str) or not re.fullmatch(r'[A-Za-z0-9_-]{43,128}', value['imagePassword']):
                raise Refusal('invalid_projection')
        if operation == 'create':
            fields.add('capacityGiB')
            if type(value.get('capacityGiB')) is not int or not 64 <= value['capacityGiB'] <= 512:
                raise Refusal('invalid_capacity')
        if operation not in {'create', 'attach', 'detach', 'status'} or set(value) != fields:
            raise Refusal('invalid_request')
        identifier = value.get('workspaceId')
        if not isinstance(identifier, str) or str(uuid.UUID(identifier)) != identifier:
            raise Refusal('invalid_request')
        if operation == 'status':
            if os.getuid() == 0 or os.getuid() != os.geteuid():
                raise Refusal('gui_owner_required')
            home = Path(pwd.getpwuid(os.getuid()).pw_dir)
            target = parent_directories(home, False, allow_missing=True) / identifier
            if not target.exists() and not target.is_symlink():
                print(json.dumps({'ok': True, 'storage': {'schemaVersion': 1, 'workspaceId': identifier,
                    'capacityGiB': None, 'imageCreated': False, 'mounted': False, 'volumeDevice': None,
                    'state': 'uninitialized'}}, separators=(',', ':')))
                return
        image = WorkspaceImage(identifier, create=operation == 'create')
        if operation == 'create':
            result = image.create(value['capacityGiB'], value['imagePassword'])
        elif operation == 'attach':
            result = image.attach(value['imagePassword'])
        elif operation == 'detach':
            result = image.detach()
        else:
            result = image.status()
        print(json.dumps({'ok': True, 'storage': result}, separators=(',', ':')))
    except Exception as error:
        # Never forward input, OS diagnostics, raw exception text or keys.
        print(json.dumps({'ok': False, 'code': error.code if isinstance(error, Refusal) else 'storage_unavailable'}))
    finally:
        if image:
            image.close()


if __name__ == '__main__':
    main()
