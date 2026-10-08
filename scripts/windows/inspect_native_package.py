"""Inspect current payload bytes and reject a bundled antivirus or containers."""
import hashlib
import json
from pathlib import Path
import re
import sys

REPO = Path(__file__).resolve().parents[2]
BASE = REPO / 'artifacts/windows-native'


def main():
    if sys.platform != 'win32' or Path(sys.executable).resolve() != (BASE / 'tools/python-3.12.15/python/python.exe').resolve():
        raise ValueError('Use the pinned private Windows Python')
    app = json.loads((BASE / 'evidence/application-build.json').read_text(encoding='utf-8-sig'))
    runtime = json.loads((BASE / 'evidence/runtime-build.json').read_text(encoding='utf-8-sig'))
    total = 0
    for build, inventory in (
        (app, Path(app['build']) / 'reports/payload-inventory.json'),
        (runtime, Path(runtime['reports']) / 'file-inventory.json'),
    ):
        payload = Path(build['payload'])
        entries = json.loads(inventory.read_text(encoding='utf-8-sig'))
        seen = set()
        for item in entries:
            name = item['path']
            if re.search(r'clamav|clamscan|freshclam|libclam|clamd|josiDefinitions|windows_scanner|\.cv[dl](?:\.|$)|\.cld$|Dockerfile|docker-compose|compose\.ya?ml$', name, re.I):
                raise ValueError('A prohibited native payload component remains: ' + name)
            path = payload / name
            if (name in seen or not path.resolve().is_relative_to(payload) or path.is_symlink()
                    or not path.is_file() or path.stat().st_nlink != 1 or path.stat().st_size != item['size']):
                raise ValueError('Payload inventory is invalid')
            with path.open('rb') as stream:
                if hashlib.file_digest(stream, 'sha256').hexdigest() != item['sha256']:
                    raise ValueError('Payload bytes changed')
            seen.add(name)
        actual = {path.relative_to(payload).as_posix() for path in payload.rglob('*') if path.is_file()}
        if seen != actual:
            raise ValueError('Unlisted payload files remain')
        total += len(seen)
    if not (Path(app['payload']) / 'app/services/scanner/windows_amsi.py').is_file():
        raise ValueError('Explicit Windows scan entry is missing')
    for relative in ('Services.psm1', 'DataLayout.psm1', 'Configuration.psm1', 'Runtime.mjs', 'Payloads.psm1', 'upstream-lock.json'):
        content = (REPO / 'packaging/windows' / relative).read_text(encoding='utf-8-sig')
        if re.search(r'clamav|clamscan|freshclam|libclam|clamd|JosiDefinitions|13310', content, re.I):
            raise ValueError('A removed engine/service/download/port remains in native packaging')
    cleanup_file = BASE / 'evidence/native-test-revision.json'
    cleanup = json.loads(cleanup_file.read_text(encoding='utf-8-sig')) if cleanup_file.exists() else {}
    cleanup_verified = (cleanup.get('passed') is True and cleanup.get('engineRemoved') is True
                        and cleanup.get('definitionsRemoved') is True and cleanup.get('retiredServiceAbsent') is True
                        and cleanup.get('installationId') == 'b5a3b94c72624209908a5a965bf6867d')
    report = {'passed': True, 'filesVerified': total, 'bundledAntivirus': False,
              'signatureDatabases': False, 'antivirusDownloads': False, 'antivirusService': False,
              'antivirusNetworkPort': False, 'containerRecipes': False, 'scanner': 'windows-amsi',
              'applicationSourceHash': app['sourceInventorySha256'], 'runtimeInventoryHash': runtime['inventorySha256'],
              'historicalPayloadsAccepted': False, 'installedTestCleanupVerified': cleanup_verified,
              'installedCleanupEvidence': 'evidence/native-test-revision.json' if cleanup_verified else None}
    (BASE / 'evidence/native-package-inspection.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
