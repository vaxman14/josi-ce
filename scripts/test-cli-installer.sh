#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ORIGINAL_PATH="$PATH"
REAL_SHA256SUM="$(command -v sha256sum 2>/dev/null || true)"
REAL_SHASUM="$(command -v shasum 2>/dev/null || true)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
BIN="$TMP/bin"; FIX="$TMP/fixtures"; DEST="$TMP/dest"; mkdir -p "$BIN" "$FIX" "$DEST" "$TMP/stage"
printf '#!/bin/sh\necho installed-fixture\n' > "$TMP/stage/josi"; chmod 755 "$TMP/stage/josi"
tar -czf "$FIX/josi-cli-1.2.3-linux-amd64.tar.gz" -C "$TMP/stage" josi
real_hash(){ if command -v sha256sum >/dev/null; then command sha256sum "$1" | awk '{print $1}'; else command shasum -a 256 "$1" | awk '{print $1}'; fi; }
printf '%s  %s\n' "$(real_hash "$FIX/josi-cli-1.2.3-linux-amd64.tar.gz")" 'josi-cli-1.2.3-linux-amd64.tar.gz' > "$FIX/josi-cli-1.2.3-checksums.txt"
printf 'signature\n' > "$FIX/josi-cli-1.2.3-checksums.txt.sig"; printf 'certificate\n' > "$FIX/josi-cli-1.2.3-checksums.txt.pem"
cat > "$FIX/cosign" <<'EOF'
#!/bin/sh
[ "${FAKE_SIGNATURE_OK:-1}" = 1 ]
EOF
chmod 700 "$FIX/cosign"
cat > "$BIN/uname" <<'EOF'
#!/bin/sh
[ "${1:-}" = -m ] && echo x86_64 || echo Linux
EOF
cat > "$BIN/curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
out=''; url="${@: -1}"
for ((i=1;i<=$#;i++)); do [[ "${!i}" == --output ]] && { j=$((i+1)); out="${!j}"; }; done
name="${url##*/}"
case "$name" in
  cosign-linux-amd64) cp "$FAKE_FIX/cosign" "$out";;
  josi-cli-1.2.3-linux-amd64.tar.gz) cp "$FAKE_FIX/$name" "$out"; if [[ "${FAKE_TAMPER:-0}" == 1 ]]; then printf x >> "$out"; fi;;
  *) cp "$FAKE_FIX/$name" "$out";;
esac
EOF
cat > "$BIN/sha256sum" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
f="${@: -1}"
if [[ "$f" == */cosign ]]; then echo '8b24b946dd5809c6bd93de08033bcf6bc0ed7d336b7785787c080f574b89249b  cosign'
elif [[ -n "${REAL_SHA256SUM:-}" ]]; then "$REAL_SHA256SUM" "$f"
else "$REAL_SHASUM" -a 256 "$f"; fi
EOF
chmod +x "$BIN/"*
export PATH="$BIN:$ORIGINAL_PATH" FAKE_FIX="$FIX" REAL_SHA256SUM REAL_SHASUM
INSTALLER="$ROOT/get.""hey""josi.com""/install.sh"
pass=0; ok(){ pass=$((pass+1)); echo "ok $pass - $1"; }; bad(){ echo "not ok - $1" >&2; exit 1; }
sh "$INSTALLER" --version 1.2.3 --install-dir "$DEST" --non-interactive >/dev/null
[[ -x "$DEST/josi" ]] || bad valid; ok 'valid signed/checksummed noninteractive install succeeds'
rm -f "$DEST/josi"; FAKE_TAMPER=1 sh "$INSTALLER" --version 1.2.3 --install-dir "$DEST" --yes >/dev/null 2>&1 && bad tamper
[[ ! -e "$DEST/josi" ]] || bad tamper-write; ok 'archive tampering fails closed before install'
FAKE_SIGNATURE_OK=0 sh "$INSTALLER" --version 1.2.3 --install-dir "$DEST" --yes >/dev/null 2>&1 && bad signature
[[ ! -e "$DEST/josi" ]] || bad signature-write; ok 'detached signature failure refuses installation'
sh "$INSTALLER" --install-dir "$DEST" --yes >/dev/null 2>&1 && bad version
ok 'missing explicit version is rejected'
sh "$INSTALLER" --version latest --install-dir "$DEST" --yes >/dev/null 2>&1 && bad latest
ok 'moving latest version is rejected'
echo "installer tests passed: $pass"
