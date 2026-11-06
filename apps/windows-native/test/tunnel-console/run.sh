#!/bin/sh
# The Windows tunnel code against the published vectors and the real TypeScript
# host. Needs a .NET 8 SDK and Node. Runs on any platform: only the tunnel files
# are compiled here, not the WPF app. Add --million for the long RFC 7748 vector.
set -e
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../../../.." && pwd)
out=${TMPDIR:-/tmp}/josi-tunnel-test
"$root/node_modules/.bin/esbuild" "$here/interop/harness.ts" --bundle --platform=node --format=esm --target=node22 \
  --outfile="$out/harness.mjs" --log-level=warning \
  --banner:js="import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);"
dotnet build "$here/TunnelTest.csproj" -c Release -o "$out/bin"
dotnet "$out/bin/TunnelTest.dll" "$root/packages/tunnel/test/vectors" "$here/generated.json" "$out/harness.mjs" "$@"
