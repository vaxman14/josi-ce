#!/usr/bin/env python3
"""Synthetic echo-only native host. No files, credentials, network or execution API."""
import json
import struct
import sys

LIMIT = 64 * 1024


def exact(stream, count):
    data = bytearray()
    while len(data) < count:
        chunk = stream.read(count - len(data))
        if not chunk:
            raise ValueError("truncated frame")
        data.extend(chunk)
    return bytes(data)


def main():
    while True:
        first = sys.stdin.buffer.read(1)
        if not first:
            return
        length = struct.unpack('=I', first + exact(sys.stdin.buffer, 3))[0]
        if not 0 < length <= LIMIT:
            raise ValueError("invalid frame length")
        request = json.loads(exact(sys.stdin.buffer, length))
        if (not isinstance(request, dict) or set(request) != {'version', 'method', 'nonce'}
                or type(request['version']) is not int or request['version'] != 1
                or request['method'] != 'probe' or not isinstance(request['nonce'], str)
                or not 1 <= len(request['nonce']) <= 128):
            raise ValueError("unsupported probe request")
        response = json.dumps(request, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
        sys.stdout.buffer.write(struct.pack('=I', len(response)) + response)
        sys.stdout.buffer.flush()


if __name__ == '__main__':
    try:
        main()
    except (ValueError, UnicodeError, struct.error):
        # Never log request bodies; even a fixture may be called incorrectly.
        print('Native probe rejected an invalid frame.', file=sys.stderr)
        raise SystemExit(2)
