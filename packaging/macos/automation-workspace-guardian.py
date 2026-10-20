"""Bounded parent-loss cleanup for one managed encrypted image.

No Vault access, password, VM input, forced unmount, arbitrary path, shell,
network listener or persistent token. The native VM owner still has to stop
its VM first on normal close. A busy volume stays in needs-repair state.
"""
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import select
import sys
import time
import uuid


def emit(value):
    try:
        print(json.dumps(value, separators=(',', ':')), flush=True)
    except (BrokenPipeError, OSError):
        # A dead parent cannot receive status, but cleanup must still run.
        pass


def module():
    path = Path(__file__).resolve().with_name('automation-workspace.py')
    spec = importlib.util.spec_from_file_location('josi_managed_image', path)
    if spec is None or spec.loader is None:
        raise RuntimeError()
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


def inspect(storage, identifier):
    image = storage.WorkspaceImage(identifier)
    try:
        return image.status()
    finally:
        image.close()


def cleanup(storage, identifier):
    deadline = time.monotonic() + 45
    for _ in range(15):
        image = None
        try:
            image = storage.WorkspaceImage(identifier)
            state = image.detach(timeout=5)
            if not state['mounted'] and state['state'] == 'image_ready':
                emit({'closed': True})
                return
        except Exception:
            pass
        finally:
            if image:
                image.close()
        if time.monotonic() >= deadline:
            break
        time.sleep(2)
    emit({'closed': False, 'code': 'storage_needs_repair'})


def main():
    os.umask(0o077)
    guard = None
    admitted = False
    try:
        if sys.platform != 'darwin' or len(sys.argv) != 2 or os.isatty(0) or os.getuid() == 0 or os.getuid() != os.geteuid():
            raise RuntimeError()
        identifier = sys.argv[1]
        if str(uuid.UUID(identifier)) != identifier:
            raise RuntimeError()
        storage = module()
        image = storage.WorkspaceImage(identifier)
        try:
            initial = image.status()
            if initial['state'] != 'image_ready' or not initial['imageCreated'] or initial['mounted']:
                raise RuntimeError()
            path = image.root / 'guardian.lock'
            guard = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
            storage.regular(path)
            fcntl.flock(guard, fcntl.LOCK_EX | fcntl.LOCK_NB)
        finally:
            image.close()
        parent = os.getppid()
        if parent <= 1:
            raise RuntimeError()
        admitted = True
        emit({'ready': True})
        pending = b''
        last_wall = time.time()
        wall_deadline = last_wall + 10
        deadline = time.monotonic() + 10
        while os.getppid() == parent:
            now = time.time()
            if now < last_wall or now >= wall_deadline or time.monotonic() >= deadline:
                break
            last_wall = now
            readable, _, _ = select.select([0], [], [], 0.5)
            if not readable:
                continue
            chunk = os.read(0, 128)
            if not chunk:
                break
            pending += chunk
            if len(pending) > 128:
                break
            invalid = False
            while b'\n' in pending:
                line, pending = pending.split(b'\n', 1)
                if line == b'closed':
                    state = inspect(storage, identifier)
                    if not state['mounted'] and state['state'] == 'image_ready':
                        emit({'closed': True})
                        return
                    invalid = True
                    break
                if line != b'alive':
                    invalid = True
                    break
                now = time.time()
                if now < last_wall or now >= wall_deadline or time.monotonic() >= deadline:
                    invalid = True
                    break
                last_wall = now
                wall_deadline = last_wall + 10
                deadline = time.monotonic() + 10
            if invalid:
                break
        cleanup(storage, identifier)
    except Exception:
        if admitted:
            cleanup(storage, identifier)
        else:
            emit({'ready': False, 'code': 'storage_guard_unavailable'})
    finally:
        if guard is not None:
            os.close(guard)


if __name__ == '__main__':
    main()
