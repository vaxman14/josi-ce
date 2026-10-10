"""Run the bundled native lifecycle without touching host accounts or systemd."""
import importlib.util
import json
from pathlib import Path
import sys

sys.dont_write_bytecode = True


def main(runtime: Path, root: Path) -> None:
    lifecycle_path = runtime / 'app/native/lifecycle.py'
    spec = importlib.util.spec_from_file_location('josi_linux_lifecycle_acceptance', lifecycle_path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    lifecycle = module.Lifecycle(runtime.resolve(), root.resolve(), isolated=True)
    try:
        transaction = lifecycle.install(interactive_uid=None)
        status = json.loads((root / 'status.json').read_text())
        print(json.dumps({'result': 'PASS', 'transaction': str(transaction), 'status': status}))
    finally:
        lifecycle.stop()


if __name__ == '__main__':
    if len(sys.argv) != 3:
        raise SystemExit('usage: test-isolated-install.py RUNTIME ISOLATED_ROOT')
    main(Path(sys.argv[1]), Path(sys.argv[2]))
