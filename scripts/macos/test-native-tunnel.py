"""Compile the native Tunnel sources with a test main and check them: the Noise and
framing vectors, tamper refusal, code normalization, then pairing, HTTP, streaming,
rotation and refusal against the reference TunnelHost in packages/tunnel. A second
build compiles the whole app and runs the same fixture through the real JosiAPI.

Uses a throwaway Keychain service that the test removes. No real server, relay,
account or secret is involved.
"""
import json
from pathlib import Path
import subprocess
import sys
import tempfile

repo = Path(__file__).resolve().parents[2]
source = repo / 'apps/macos-native/Sources'
scratch = Path(tempfile.mkdtemp(prefix='josi-native-tunnel-', dir='/private/tmp'))
flags = ['xcrun', 'swiftc', '-swift-version', '6', '-parse-as-library', '-target', 'arm64-apple-macos14.2',
         '-module-cache-path', str(scratch / 'module-cache')]
main = str(repo / 'scripts/macos/test-native-tunnel.swift')
automation = repo / 'apps/automation-macos/Sources'


def fixture():
    host = scratch / 'host.cjs'
    subprocess.run([str(repo / 'node_modules/.bin/esbuild'), str(repo / 'scripts/macos/test-native-tunnel-host.mjs'),
                    '--bundle', '--platform=node', '--format=esm', '--log-level=warning',
                    '--banner:js=import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
                    '--outfile=' + str(host.with_suffix('.mjs'))], check=True, timeout=120, cwd=repo)
    process = subprocess.Popen(['node', str(host.with_suffix('.mjs'))], stdout=subprocess.PIPE, text=True)
    return process, json.loads(process.stdout.readline())


def run(name, sources, defines, urls, vectors):
    binary = scratch / name
    subprocess.run([*flags, *defines, '-o', str(binary), *sources, main], check=True, timeout=600)
    subprocess.run([str(binary), str(vectors), urls['control'], urls['relay']], check=True, timeout=180)


vectors = repo / 'packages/tunnel/test/vectors'
tunnel_sources = [str(p) for p in sorted(source.glob('Tunnel*.swift'))]
process, urls = fixture()
try:
    run('tunnel', tunnel_sources, [], urls, vectors)
finally:
    process.kill()

app = scratch / 'JosiApp.swift'
app.write_text((source / 'JosiApp.swift').read_text().replace('@main struct JosiNativeApp', 'struct JosiNativeApp'))
app_sources = [*[str(p) for p in sorted(source.glob('*.swift')) if p.name != 'JosiApp.swift'], str(app),
               str(repo / 'packaging/macos/NativeAuthorization.swift'),
               *[str(automation / name) for name in (
                   'GuestLinkWire.swift', 'CurrentDesktopEnvironment.swift', 'GuestDesktopEngine.swift',
                   'GuestExecutionAuthority.swift', 'GuestBrowserIPC.swift', 'GuestBrowserProfiles.swift',
                   'GuestBrowserProjection.swift', 'GuestBrowserSession.swift', 'GuestPhotoReader.swift')]]
process, urls = fixture()
try:
    run('tunnel-app', app_sources, ['-D', 'JOSI_TUNNEL_APP'], urls, vectors)
finally:
    process.kill()
print(json.dumps({'nativeTunnel': 'passed', 'evidence': str(scratch)}), flush=True)
