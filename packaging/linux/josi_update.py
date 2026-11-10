#!/usr/bin/env python3
"""Josi's root-side updater on Linux. Runs under systemd, never from the web.

    josi_update.py check     read the release feed and record what is available
    josi_update.py request   act on the request the web service left behind

The web service (an unprivileged account) can only write a small JSON request
into /var/lib/josi/data/state/update-request: {"operation":"check"} or
{"operation":"update","version":"1.2.3"}. Root decides everything else: the
feed address comes from /etc/josi/update.json, the package must be the one the
feed names for this distribution and processor, and its SHA-256 must match the
feed before the package manager sees it. The result goes to
/var/lib/josi/data/state/update-status.json, which the web service reads.
"""
import fcntl
import grp
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import secrets
import shutil
import stat
import subprocess
import sys
import time
import urllib.parse
import urllib.request

ROOT = Path('/var/lib/josi')
STATE = ROOT / 'data/state'
REQUEST = STATE / 'update-request'
STATUS = STATE / 'update-status.json'
WORK = ROOT / 'updates'
LOCK = ROOT / 'update.lock'
CONFIG = Path('/etc/josi/update.json')
DEFAULT_FEED = 'https://github.com/vaxman14/josi-ce/releases/latest/download/linux-latest.json'
VERSION = re.compile(r'^\d+\.\d+\.\d+(?:-[a-z0-9.]+)?$')
NAME = re.compile(r'^[A-Za-z0-9._+-]{1,200}$')
ENV = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C.UTF-8', 'LC_ALL': 'C.UTF-8',
       'DEBIAN_FRONTEND': 'noninteractive'}
# Wait for another apt or unattended-upgrades instead of failing at once.
APT_LOCK = ['-o', 'DPkg::Lock::Timeout=600']
MAX_FEED = 256 * 1024
MAX_PACKAGE = 4 * 1024 ** 3
MAX_STATUS = 64 * 1024


def now():
    return time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())


def current_version():
    return json.loads((ROOT / 'data/config/runtime.json').read_text())['version']


def newer(left, right):
    """Semantic-version order: 1.2.8-beta.2 < 1.2.8-beta.10 < 1.2.8."""
    def key(value):
        head, _, tail = value.partition('-')
        numbers = tuple(int(part) for part in head.split('.'))
        if not tail:
            return numbers, 1, ()
        # Numeric identifiers sort below names and among themselves by value.
        parts = tuple((0, int(part), '') if part.isdigit() else (1, 0, part) for part in tail.split('.'))
        return numbers, 0, parts
    return key(left) > key(right)


def read_status():
    """The status file lives in a folder the web account can write, so it is
    read without following links, without blocking on a FIFO, only as a
    regular file and only up to a small size."""
    try:
        descriptor = os.open(STATUS, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except OSError:
        return {}
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_STATUS:
            return {}
        body = os.read(descriptor, MAX_STATUS + 1)
        if len(body) > MAX_STATUS:
            return {}
        value = json.loads(body)
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}
    finally:
        os.close(descriptor)


def update_lock(wait):
    """One updater at a time: a check never runs beside an update. Returns the
    held descriptor, or None when wait is False and another run holds it."""
    descriptor = os.open(LOCK, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    info = os.fstat(descriptor)
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_nlink != 1:
        os.close(descriptor)
        raise SystemExit('Unsafe updater lock ' + str(LOCK))
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX | (0 if wait else fcntl.LOCK_NB))
    except BlockingIOError:
        os.close(descriptor)
        return None
    return descriptor


def write_status(**fields):
    """Replace the status file without following anything the web account made."""
    value = {**read_status(), **fields, 'currentVersion': current_version()}
    temporary = STATE / ('.update-status.' + secrets.token_hex(8))
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o640)
    try:
        os.write(descriptor, (json.dumps(value, sort_keys=True) + '\n').encode())
        os.fsync(descriptor)
        os.fchown(descriptor, 0, grp.getgrnam('josi-ce-app').gr_gid)
        os.fchmod(descriptor, 0o640)
    finally:
        os.close(descriptor)
    os.replace(temporary, STATUS)
    return value


def settings():
    try:
        value = json.loads(CONFIG.read_text())
    except (OSError, ValueError):
        value = {}
    feed = value.get('feed') if isinstance(value.get('feed'), str) else DEFAULT_FEED
    allow_http = value.get('allowHttp') is True
    scheme = urllib.parse.urlsplit(feed).scheme
    if scheme != 'https' and not (allow_http and scheme == 'http'):
        raise ValueError('The update feed in /etc/josi/update.json must use https.')
    return feed, allow_http


def fetch(url, limit, allow_http, target=None):
    scheme = urllib.parse.urlsplit(url).scheme
    if scheme != 'https' and not (allow_http and scheme == 'http'):
        raise ValueError('Refusing a non-https download.')
    request = urllib.request.Request(url, headers={'User-Agent': 'josi-linux-updater/1'})
    with urllib.request.urlopen(request, timeout=60) as response:
        final = urllib.parse.urlsplit(response.geturl()).scheme
        if final != 'https' and not (allow_http and final == 'http'):
            raise ValueError('The download was redirected away from https.')
        if target is None:
            body = response.read(limit + 1)
            if len(body) > limit:
                raise ValueError('The update feed is too large.')
            return body
        digest, size = hashlib.sha256(), 0
        with open(target, 'wb') as stream:
            for block in iter(lambda: response.read(1024 * 1024), b''):
                size += len(block)
                if size > limit:
                    raise ValueError('The package is too large.')
                digest.update(block)
                stream.write(block)
            stream.flush()
            os.fsync(stream.fileno())
        return digest.hexdigest()


def family():
    if Path('/usr/bin/pacman').exists():
        return 'arch'
    if Path('/usr/bin/apt-get').exists():
        return 'debian'
    raise RuntimeError('This updater supports pacman and apt only.')


def machine():
    value = {'x86_64': 'x86_64', 'amd64': 'x86_64', 'aarch64': 'aarch64', 'arm64': 'aarch64'}.get(platform.machine())
    if not value:
        raise RuntimeError('Unsupported processor.')
    return value


def read_feed():
    feed, allow_http = settings()
    value = json.loads(fetch(feed, MAX_FEED, allow_http))
    version = value.get('version')
    if not isinstance(version, str) or not VERSION.match(version):
        raise ValueError('The update feed names no valid version.')
    key = family() + '-' + machine()
    package = (value.get('packages') or {}).get(key)
    if package is not None:
        if not isinstance(package, dict) or not NAME.match(str(package.get('file', ''))) \
                or not re.fullmatch(r'[a-f0-9]{64}', str(package.get('sha256', ''))):
            raise ValueError('The update feed entry for this computer is malformed.')
        package = {'file': package['file'], 'sha256': package['sha256'],
                   'url': urllib.parse.urljoin(feed, urllib.parse.quote(package['file']))}
    release = {
        'version': version,
        'name': str(value.get('name') or f'Josi {version}')[:160],
        'notes': str(value.get('notes') or '')[:8000],
        'url': str(value.get('url') or '')[:500],
        'publishedAt': str(value.get('publishedAt') or '')[:40],
    }
    return release, package, allow_http


def check():
    try:
        release, package, _ = read_feed()
    except Exception as error:  # Recorded for the web page; nothing is changed.
        return write_status(checkedAt=now(), lastCheckOk=False, checkError=str(error)[:200])
    available = release if package and newer(release['version'], current_version()) else None
    state = read_status().get('state')
    return write_status(checkedAt=now(), lastCheckOk=True, checkError=None, available=available,
        state=state if state in ('running', 'failed', 'complete') else 'idle',
        message=read_status().get('message') or '')


def package_install(path):
    if family() == 'arch':
        command = ['/usr/bin/pacman', '-U', '--noconfirm', '--needed', str(path)]
    else:
        # Finish a dpkg run an earlier interruption left half-configured.
        subprocess.run(['/usr/bin/dpkg', '--configure', '-a'], env=ENV, capture_output=True, timeout=1200)
        subprocess.run(['/usr/bin/apt-get', *APT_LOCK, 'update', '-qq'], env=ENV, capture_output=True, timeout=1200)
        command = ['/usr/bin/apt-get', *APT_LOCK, 'install', '-y', '-q', str(path)]
    result = subprocess.run(command, env=ENV, capture_output=True, text=True, timeout=2400)
    if result.returncode:
        raise RuntimeError('The package manager refused the update: ' + (result.stderr or result.stdout)[-300:])


def update(version):
    before = current_version()
    write_status(state='running', targetVersion=version, startedAt=now(), finishedAt=None,
        message='Downloading and checking the package.')
    try:
        release, package, allow_http = read_feed()
        if release['version'] != version or not package:
            raise RuntimeError('That release is no longer the available update. Check again.')
        if not newer(version, before):
            raise RuntimeError('That version is not newer than the installed one.')
        if WORK.exists():
            shutil.rmtree(WORK)
        WORK.mkdir(mode=0o700)
        target = WORK / package['file']
        if fetch(package['url'], MAX_PACKAGE, allow_http, target) != package['sha256']:
            raise RuntimeError('The downloaded package did not match the release checksum. Nothing was installed.')
        write_status(message='Installing the package. Josi will restart in a moment.')
        package_install(target)
        write_status(message='Backing up the data and moving it to the new version.')
        result = subprocess.run(['/usr/bin/josi-ce-server-install', '--upgrade'], env=ENV,
            capture_output=True, text=True, timeout=3000)
        if result.returncode:
            raise RuntimeError((result.stderr or 'The new version did not start.').strip()[-300:])
        shutil.rmtree(WORK, ignore_errors=True)
        write_status(state='complete', finishedAt=now(), available=None,
            message=f'Updated from {before} to {current_version()}.')
    except Exception as error:
        # Bring back whatever is installed. Units are only rewritten once the
        # new version is ready to start, so before that this is the old one.
        # A failure during the data migration first puts back the snapshot
        # (maintenance.py recover <transaction>); without it the next start
        # would refuse the half-migrated data and Josi would stay down.
        subprocess.run(['/usr/bin/josi-ce-server-install', '--recover'], env=ENV, capture_output=True,
            timeout=3600)
        subprocess.run(['/usr/bin/systemctl', 'start', 'josi.service'], env=ENV, capture_output=True, timeout=300)
        write_status(state='failed', finishedAt=now(), message=str(error)[:300])


def take_request():
    """Read and remove the request without following links the web account made."""
    try:
        descriptor = os.open(REQUEST, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        return None
    except OSError:
        REQUEST.unlink(missing_ok=True)
        return None
    try:
        info = os.fstat(descriptor)
        body = os.read(descriptor, 1025) if (info.st_mode & 0o170000) == 0o100000 else b''
    finally:
        os.close(descriptor)
        REQUEST.unlink(missing_ok=True)
    try:
        value = json.loads(body) if 0 < len(body) <= 1024 else None
    except ValueError:
        value = None
    return value if isinstance(value, dict) else None


def main():
    if os.geteuid() != 0:
        raise SystemExit('josi_update.py runs as root under systemd.')
    command = sys.argv[1:]
    if command == ['check']:
        # The twice-a-day check skips while an update runs; it would read a
        # status the update is about to replace and write the old one back.
        lock = update_lock(wait=False)
        if lock is not None:
            check()
    elif command == ['request']:
        value = take_request()
        if not value:
            return
        if value.get('operation') == 'check':
            lock = update_lock(wait=False)
            if lock is not None:
                check()
        elif value.get('operation') == 'update' and isinstance(value.get('version'), str) and VERSION.match(value['version']):
            # Holding the lock means no other update runs; a "running" left by
            # one that died (power loss) is stale, so this one goes ahead.
            update_lock(wait=True)
            if value['version'] != current_version():  # a repeat request for what just installed
                update(value['version'])
    else:
        raise SystemExit('usage: josi_update.py check|request')


if __name__ == '__main__':
    main()
