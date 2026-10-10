"""Run the bundled native lifecycle without touching host accounts or systemd."""
import importlib.util
import json
from pathlib import Path
import socket
import sys

sys.dont_write_bytecode = True


def main(runtime: Path, root: Path) -> None:
    lifecycle_path = runtime / 'app/native/lifecycle.py'
    spec = importlib.util.spec_from_file_location('josi_linux_lifecycle_acceptance', lifecycle_path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    lifecycle = module.Lifecycle(runtime.resolve(), root.resolve(), isolated=True)
    probes = []
    try:
        for _ in range(5):
            probe = socket.socket()
            probe.bind(('127.0.0.1', 0))
            probes.append(probe)
        ports = tuple(probe.getsockname()[1] for probe in probes)
        for probe in probes:
            probe.close()
        probes.clear()
        transaction = lifecycle.install(ports=ports, interactive_uid=None)
        status = json.loads((root / 'status.json').read_text())
        print(json.dumps({'result': 'PASS', 'transaction': str(transaction), 'status': status}))
    finally:
        for probe in probes:
            probe.close()
        lifecycle.stop()


if __name__ == '__main__':
    if len(sys.argv) != 3:
        raise SystemExit('usage: test-isolated-install.py RUNTIME ISOLATED_ROOT')
    main(Path(sys.argv[1]), Path(sys.argv[2]))
