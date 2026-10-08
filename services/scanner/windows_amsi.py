"""Explicit, bounded AMSI requests to the machine's registered antivirus.

No antivirus engine, definitions, file writes, network listener or shell. Only
fixed status codes leave the private inherited pipes; document bytes and provider
messages never enter logs. Windows/provider errors never become clean results.
"""
import ctypes as c
import importlib.util
import json
import os
from pathlib import Path
import struct
import sys

MAX_BYTES = 32 * 1024 * 1024


def classify(hresult, result):
    code = hresult & 0xffffffff
    if code:
        return 'unavailable' if code in (0x80040154, 0x80004001, 0x80004002, 0x80070032) else 'error'
    if result >= 32768 or 16384 <= result <= 20479:
        return 'blocked'
    # Provider-specific elevated risk values are not a known clean verdict.
    return 'clean' if result in (0, 1) else 'error'


class Amsi:
    def __init__(self):
        self.context = c.c_void_p()
        if os.name != 'nt':
            raise OSError('Windows scanning unavailable')
        self.api = c.WinDLL(str(Path(os.environ['SystemRoot']) / 'System32/amsi.dll'))
        for name, arguments, result in (
            ('AmsiInitialize', [c.c_wchar_p, c.POINTER(c.c_void_p)], c.c_long),
            ('AmsiUninitialize', [c.c_void_p], None),
            ('AmsiScanBuffer', [c.c_void_p, c.c_void_p, c.c_ulong, c.c_wchar_p, c.c_void_p, c.POINTER(c.c_int)], c.c_long),
        ):
            function = getattr(self.api, name)
            function.argtypes, function.restype = arguments, result
        code = self.api.AmsiInitialize('Josi CE', c.byref(self.context))
        self.status = classify(code, 0) if code else ('clean' if self.context.value else 'unavailable')

    def scan(self, data):
        if self.status != 'clean':
            return self.status
        if len(data) > MAX_BYTES:
            return 'error'
        # A non-null buffer is passed even for empty input. S_OK plus an actual
        # provider verdict is required; no special-case clean shortcut exists.
        memory = c.create_string_buffer(data)
        verdict = c.c_int(-1)
        code = self.api.AmsiScanBuffer(self.context, memory, len(data), 'Josi document', None, c.byref(verdict))
        return classify(code, verdict.value)

    def close(self):
        if self.context.value:
            self.api.AmsiUninitialize(self.context)
            self.context = c.c_void_p()


def emit(value):
    sys.stdout.write(json.dumps(value, separators=(',', ':')) + '\n')
    sys.stdout.flush()


def read_exact(length):
    output = bytearray()
    while len(output) < length:
        block = sys.stdin.buffer.read(length - len(output))
        if not block:
            raise ValueError('Incomplete scan request')
        output.extend(block)
    return bytes(output)


def main():
    scanner = None
    try:
        spec = importlib.util.spec_from_file_location('josi_windows_limits', Path(__file__).resolve().parents[1] / 'voice-box/windows_limits.py')
        limits = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(limits)
        limits.apply_resource_limits(memory_gib=1, cpu_cores=2, processes=1)
        try:
            scanner = Amsi()
        except (OSError, KeyError, AttributeError):
            emit({'ready': False, 'provider': 'windows-amsi', 'status': 'unavailable'})
            return
        emit({'ready': scanner.status == 'clean', 'provider': 'windows-amsi', 'status': scanner.status})
        if scanner.status != 'clean':
            return
        while header := sys.stdin.buffer.read(4):
            if len(header) != 4:
                raise ValueError('Incomplete scan header')
            size = struct.unpack('>I', header)[0]
            if size > MAX_BYTES:
                raise ValueError('Scan bound exceeded')
            emit({'status': scanner.scan(read_exact(size))})
    except Exception:
        emit({'status': 'error'})
    finally:
        if scanner:
            scanner.close()


if __name__ == '__main__':
    main()
