#!/usr/bin/env python3
"""Pure helpers for the portable Linux GUI installer."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import shutil
from urllib.parse import urljoin


FAMILY_IDS = {
    'arch': {'arch', 'cachyos', 'endeavouros', 'manjaro'},
    'debian': {'debian', 'linuxmint', 'pop', 'ubuntu'},
    'rpm': {'almalinux', 'centos', 'fedora', 'rhel', 'rocky'},
}

APPIMAGE_ENVIRONMENT = (
    'APPDIR', 'APPIMAGE', 'ARGV0', 'OWD', 'PYTHONHOME', 'PYTHONPATH',
    'GI_TYPELIB_PATH', 'GSETTINGS_SCHEMA_DIR', 'FONTCONFIG_PATH',
    'FONTCONFIG_FILE', 'GDK_BACKEND', 'LD_LIBRARY_PATH', 'SSL_CERT_FILE',
    'XDG_DATA_DIRS',
)


def host_environment(environment: dict[str, str] | None = None) -> dict[str, str]:
    """Remove the portable runtime from a process launched on the host desktop."""
    result = dict(os.environ if environment is None else environment)
    for key in APPIMAGE_ENVIRONMENT:
        result.pop(key, None)
    for key in ('GDK_BACKEND', 'LD_LIBRARY_PATH', 'SSL_CERT_FILE', 'XDG_DATA_DIRS'):
        original = result.pop('JOSI_HOST_' + key, '')
        if original:
            result[key] = original
    for key in tuple(result):
        if key.startswith('JOSI_HOST_'):
            result.pop(key)
    return result


def read_os_release(path: Path = Path('/etc/os-release')) -> dict[str, str]:
    values: dict[str, str] = {}
    for raw in path.read_text(encoding='utf-8').splitlines():
        if not raw or raw.lstrip().startswith('#') or '=' not in raw:
            continue
        key, value = raw.split('=', 1)
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
            value = value[1:-1]
        values[key] = value.replace(r'\"', '"').replace(r'\\', '\\')
    return values


def distro_family(values: dict[str, str]) -> str:
    candidates = [values.get('ID', '').lower()]
    candidates.extend(values.get('ID_LIKE', '').lower().split())
    for family, names in FAMILY_IDS.items():
        if any(candidate in names for candidate in candidates):
            return family
    raise ValueError('This Linux distribution is not supported yet')


def architecture(machine: str) -> str:
    if machine.lower() in {'amd64', 'x86_64'}:
        return 'x86_64'
    raise ValueError('Only x86_64 Linux is supported by this acceptance build')


def load_manifest(path: Path) -> dict:
    manifest = json.loads(path.read_text(encoding='utf-8'))
    if not re.fullmatch(r'[0-9A-Za-z._-]+', manifest.get('version', '')):
        raise ValueError('Installer manifest version is invalid')
    base_url = manifest.get('baseUrl', '')
    if not isinstance(base_url, str) or not base_url.startswith(('https://', 'http://')):
        raise ValueError('Installer manifest source is invalid')
    packages = manifest.get('packages')
    if not isinstance(packages, dict) or set(packages) != {'arch', 'debian', 'rpm'}:
        raise ValueError('Installer manifest package set is invalid')
    for package in packages.values():
        if not re.fullmatch(r'[0-9A-Za-z._+-]+', package.get('name', '')):
            raise ValueError('Installer package name is invalid')
        if not re.fullmatch(r'[a-f0-9]{64}', package.get('sha256', '')):
            raise ValueError('Installer package checksum is invalid')
    return manifest


def package_url(manifest: dict, family: str) -> str:
    package = manifest['packages'][family]
    return urljoin(manifest['baseUrl'].rstrip('/') + '/', package['name'])


def package_command(family: str, package: Path) -> list[str]:
    package = package.resolve()
    if family == 'arch':
        executable = shutil.which('pacman') or '/usr/bin/pacman'
        return [executable, '-U', '--noconfirm', str(package)]
    if family == 'debian':
        executable = shutil.which('apt-get') or '/usr/bin/apt-get'
        return [executable, 'install', '-y', str(package)]
    if family == 'rpm':
        executable = shutil.which('dnf') or shutil.which('yum') or '/usr/bin/dnf'
        return [executable, 'install', '-y', str(package)]
    raise ValueError('Unsupported package family')


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()
