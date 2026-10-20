"""Upgrade an existing Josi server after the signed unified package is installed.

A new/remote-only installation only installs the app. Never start a second
server or manufacture an installation receipt. The normal lifecycle owns the
cold recovery copy, migration, service activation and recovery journal.
"""
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import uuid

APP = Path('/Applications/Josi.app')
RECEIPT = Path('/Library/Application Support/Josi CE Server/status.json')


def main():
    if os.getuid() != 0 or Path(__file__).resolve() != APP / 'Contents/Resources/runtime/app/native/unified-postinstall.py':
        raise PermissionError('Run only from the installed unified package')
    if not RECEIPT.exists():
        print('Josi installed. Open Josi to choose local hosting or a remote connection.')
        return
    for parent in RECEIPT.parents:
        info = parent.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise PermissionError('Unprotected installation directory; server was not updated')
    fd = os.open(RECEIPT, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022 or info.st_nlink != 1 or info.st_size > 8192:
            raise PermissionError('Unprotected installation record; server was not updated')
        receipt = json.loads(os.read(fd, 8193))
    finally:
        os.close(fd)
    if receipt.get('installed') is not True:
        print('Josi installed. Retained data is available through Set Up on This Mac.')
        return
    runtime = APP / 'Contents/Resources/runtime'
    # The driver verifies the installed Socal-signed app itself before any
    # lifecycle mutation. A failure remains an Installer failure, not success.
    subprocess.run([str(runtime / 'python/bin/python3.11'), '-I', '-B',
                    str(runtime / 'app/native/pkg-driver.py'), 'install', str(uuid.uuid4())],
                   check=True, env={'PATH': '/usr/bin:/bin:/usr/sbin:/sbin'})


if __name__ == '__main__':
    main()
