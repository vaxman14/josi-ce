"""The architecture a Linux build is for, and the name each tool gives it.

JOSI_LINUX_ARCH names the target (x86_64 or aarch64; amd64 and arm64 are
accepted). Unset, the build is for the machine it runs on. A target other than
the build machine is compiled in an emulated container (see LINUX_RELEASE.md).
"""
import os
import platform

_ALIASES = {'x86_64': 'x86_64', 'amd64': 'x86_64', 'aarch64': 'aarch64', 'arm64': 'aarch64'}
_NAMES = {
    'x86_64': {'deb': 'amd64', 'node': 'x64', 'go': 'amd64', 'triplet': 'x86_64-linux-gnu',
               'docker': 'linux/amd64', 'elf': 'Advanced Micro Devices X86-64',
               'image': 'local/josi-ce-linux-package-build:debian12'},
    'aarch64': {'deb': 'arm64', 'node': 'arm64', 'go': 'arm64', 'triplet': 'aarch64-linux-gnu',
                'docker': 'linux/arm64', 'elf': 'AArch64',
                'image': 'local/josi-ce-linux-package-build:debian12-arm64'},
}
ARCHITECTURES = tuple(_NAMES)


def normalize(value: str) -> str:
    try:
        return _ALIASES[value.strip().lower()]
    except KeyError:
        raise ValueError('Unsupported Linux architecture: ' + value) from None


def host() -> str:
    return normalize(platform.machine())


def architecture() -> str:
    return normalize(os.environ.get('JOSI_LINUX_ARCH') or platform.machine())


def name(kind: str, arch: str = '') -> str:
    """kind is deb, node, go, triplet, docker, elf or image."""
    return _NAMES[arch or architecture()][kind]


def emulated() -> bool:
    return architecture() != host()


if __name__ == '__main__':
    import sys
    print(name(sys.argv[1]) if sys.argv[1:] else architecture())
