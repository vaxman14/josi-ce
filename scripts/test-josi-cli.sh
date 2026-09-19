#!/usr/bin/env bash
set -euo pipefail
ROOT_SRC="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
BIN="$TMP/bin"; INSTALL="$TMP/install"; STATE="$TMP/fake"; mkdir -p "$BIN" "$INSTALL/secrets" "$STATE"
cp "$ROOT_SRC/docker-compose.release.yml" "$INSTALL/docker-compose.yml"
cp "$ROOT_SRC/.env.example" "$INSTALL/.env"
sed -i.bak 's/^JOSI_TAG=.*/JOSI_TAG=0.1.0/; s#^JOSI_APP_URL=.*#JOSI_APP_URL=http://josi.test#' "$INSTALL/.env"; rm -f "$INSTALL/.env.bak"
printf 'master-key-canary-abcdefghijklmnopqrstuvwxyz123456\n' > "$INSTALL/secrets/master.key"
printf 'db-password-canary-123456789\n' > "$INSTALL/secrets/db_password"
chmod 700 "$INSTALL/secrets"; chmod 600 "$INSTALL/secrets/"*
printf '#!/bin/sh\nexit "${FAKE_PREFLIGHT_RC:-0}"\n' > "$INSTALL/preflight.sh"; chmod +x "$INSTALL/preflight.sh"
printf '#!/bin/sh\nexit 0\n' > "$INSTALL/install.sh"; chmod +x "$INSTALL/install.sh"
cat > "$BIN/docker" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
S="${FAKE_STATE:?}"
printf '%q ' "$@" >> "$S/calls"; printf '\n' >> "$S/calls"
[[ "${1:-}" == version ]] && { [[ "${2:-}" == --format ]] && echo 26.1.0 || echo 'Docker version 26.1.0'; exit 0; }
[[ "${1:-}" == info ]] && exit 0
[[ "${1:-}" == system && "${2:-}" == df ]] && { echo 'TYPE TOTAL ACTIVE SIZE RECLAIMABLE'; exit 0; }
[[ "${1:-}" == inspect ]] && { id="${@: -1}"; svc="${id#id-}"; st=$(cat "$S/$svc" 2>/dev/null || echo running/healthy); if [[ "$*" == *RestartCount* ]]; then echo "0|0|${st#*/}|docker.io/romanvaxman/josi-ce:0.1.0|sha256:$svc"; elif [[ "$*" == *Config.Image* ]]; then tag=$(sed -n 's/^JOSI_TAG=//p' "${FAKE_ROOT:?}/.env" | tail -1); echo "docker.io/romanvaxman/josi-ce:${tag:-0.1.0}"; else echo "$st"; fi; exit 0; }
[[ "${1:-}" == compose ]] || exit 1
shift
while [[ "${1:-}" == --project-directory || "${1:-}" == -f ]]; do shift 2; done
case "${1:-}" in
  version) [[ "${2:-}" == --short ]] && echo 2.30.0 || echo 'Docker Compose version v2.30.0';;
  config)
    [[ "${FAKE_CONFIG_FAIL:-0}" == 1 ]] && exit 1
    case "${2:-}" in --services) printf '%s\n' attachment-init db migrate web worker caddy;; --volumes) printf '%s\n' db_data josi_backups josi_diagnostics;; --images) printf '%s\n' 'docker.io/romanvaxman/josi-ce:0.1.0';; -q) :;; *) cat "${FAKE_ROOT:?}/docker-compose.yml";; esac;;
  ps) svc="${@: -1}"; [[ "$*" == *'-q'* ]] || { echo '[]'; exit; }; [[ -f "$S/missing-$svc" ]] && exit 0; echo "id-$svc";;
  exec)
    svc="${3:-}"
    if [[ "$svc" == web ]]; then [[ -f "$S/health-fail" ]] && exit 1; exit 0; fi
    if [[ "$svc" == db && "$*" == *pg_dump* ]]; then printf '%s\n' '-- synthetic database' 'CREATE TABLE test(id int);'; exit 0; fi
    if [[ "$svc" == db && "$*" == *psql* ]]; then [[ "$*" == *schema_migrations* ]] && printf '0001\n0002\n'; [[ "$*" == *'from jobs'* ]] && printf 'assistant.turn=2\n'; [[ "$*" == *'select 1'* ]] && printf '1\n'; exit 0; fi;;
  logs) svc="${@: -1}"; printf '2026-01-01T00:00:00Z %s request_id=req-1 token=CANARY_TOKEN password=hunter2 Authorization: Bearer abc.def\n' "$svc"; printf '2026-01-01T00:00:01Z %s receipt_id=rec-1 event_id=evt-1 ok\n' "$svc";;
  up)
    for a in "$@"; do case "$a" in attachment-init|db|migrate|web|worker|caddy) printf 'running/healthy\n' > "$S/$a"; rm -f "$S/missing-$a";; esac; done
    if grep -q '^JOSI_TAG=9.9.9$' "${FAKE_ROOT:?}/.env" 2>/dev/null; then touch "$S/health-fail"; exit 1
    elif [[ "${FAKE_REGRESS_ON_UP:-0}" == 1 && ! -f "$S/regressed-once" ]]; then touch "$S/health-fail" "$S/regressed-once"
    else rm -f "$S/health-fail"; fi;;
  restart) if [[ "${FAKE_AI_REGRESS_ON_RESTART:-0}" == 1 ]]; then touch "$S/health-fail"; else rm -f "$S/public-fail"; fi;;
  pull|down) :;; *) :;;
esac
EOF
chmod +x "$BIN/docker"
printf '#!/usr/bin/env bash\n[[ -f "${FAKE_STATE:?}/health-fail" || -f "${FAKE_STATE:?}/public-fail" ]] && { printf 500; exit 22; }; printf "%%s" "${FAKE_PUBLIC_CODE:-200}"\n' > "$BIN/curl"; chmod +x "$BIN/curl"
printf '#!/bin/sh\necho "127.0.0.1 josi.test"\n' > "$BIN/getent"; chmod +x "$BIN/getent"
export PATH="$BIN:$PATH" FAKE_STATE="$STATE" FAKE_ROOT="$INSTALL" JOSI_DOCKER_BIN="$BIN/docker" JOSI_CURL_BIN="$BIN/curl" JOSI_NOW='2026-09-19T00:00:00Z' JOSI_HEALTH_TIMEOUT=1 JOSI_DISK_FREE_BYTES=9999999999 JOSI_MEMORY_BYTES=4294967296
CLI="$ROOT_SRC/scripts/josi --root $INSTALL"
PASS=0
ok(){ PASS=$((PASS+1)); printf 'ok %02d - %s\n' "$PASS" "$1"; }
fail(){ printf 'not ok - %s\n' "$1" >&2; exit 1; }
run(){ bash -c "$CLI $*"; }
run status --json | grep -q '"direct":"pass"' || fail status; ok 'status reports direct/public readiness and containers'
runtime_out=$(JOSI_DOCKER_BIN="$TMP/missing-docker" "$ROOT_SRC/scripts/josi" --root "$INSTALL" doctor --check-only 2>&1 || true); [[ "$runtime_out" == *'runtime'* && "$runtime_out" == *'Docker Engine or Compose v2 unavailable'* ]] || fail runtime-blocker; ok 'doctor reports a precise runtime blocker when Docker/Compose is unavailable'
: > "$STATE/calls"; (export FAKE_PREFLIGHT_RC=1; run install --yes >/dev/null 2>&1) && fail install-preflight; ! grep -q 'compose .* up ' "$STATE/calls" || fail install-mutated; ok 'install fails before mutation when preflight blocks'
run install --yes >/dev/null; grep -q 'compose .* up ' "$STATE/calls" || fail install-start; ok 'clean install reuses preflight/secret machinery and reaches readiness'
chmod 644 "$INSTALL/secrets/master.key"; preflight_json=$(cd "$INSTALL" && bash "$ROOT_SRC/scripts/preflight.sh" --json 2>/dev/null || true); [[ "$preflight_json" == *'"check":"master key permissions","status":"pass"'* ]] || fail preflight-compose-secret; chmod 600 "$INSTALL/secrets/master.key"; ok 'preflight accepts Compose-readable secrets only inside an owner-only directory'
out=$(run logs --since 30m); [[ "$out" != *CANARY_TOKEN* && "$out" != *hunter2* && "$out" == *'[REDACTED]'* ]] || fail redaction; ok 'logs are bounded, timestamped, and redact secret canaries'
B1="$TMP/bundle1"; B2="$TMP/bundle2"; run support bundle "$B1" --since 30m >/dev/null; run doctor --export-ai-context "$B2" --check-only >/dev/null || true
cmp "$B1/manifest.json" "$B2/manifest.json" >/dev/null || { diff -u "$B1/manifest.json" "$B2/manifest.json" >&2 || true; fail deterministic; }
! grep -R -E 'CANARY_TOKEN|hunter2|master-key-canary|db-password-canary' "$B1" >/dev/null || fail bundle-redaction
grep -q 'josi.support.v1' "$B1/manifest.json" || fail bundle-schema
grep -q 'request_id=req-1' "$B1/correlations.txt" && grep -q 'receipt_id=rec-1' "$B1/correlations.txt" || fail correlation
ok 'support and doctor use the same deterministic versioned collector with redaction/correlation'
(export JOSI_MAX_LOG_BYTES=80; run support bundle "$TMP/capped" >/dev/null); grep -R -q '^\[TRUNCATED:' "$TMP/capped/logs" || fail truncation; grep -q '"truncated":true' "$TMP/capped/manifest.json" || fail truncation-manifest; ok 'collector enforces byte caps and records truncation'
touch "$STATE/missing-worker"; run support bundle "$TMP/partial" >/dev/null; grep -q '"service":"worker","state":"missing"' "$TMP/partial/manifest.json" || fail partial; ok 'missing services produce a partial bundle instead of aborting'
rm -f "$STATE/missing-worker"; printf 'exited/unhealthy\n' > "$STATE/worker"; : > "$STATE/calls"; dry_out=$(run doctor --dry-run 2>&1 || true); [[ "$dry_out" == *'docker compose up -d worker'* && "$(cat "$STATE/worker")" == exited/unhealthy ]] || fail doctor-dry-run; ! grep -q 'compose .* up ' "$STATE/calls" || fail doctor-dry-run-write; ok 'doctor dry-run prints an exact plan without writing'
run doctor --yes >/dev/null; [[ "$(cat "$STATE/worker")" == running/healthy ]] || fail doctor-repair; run doctor --yes | grep -q 'healthy: no repairs required' || fail doctor-idempotent; ok 'doctor safely repairs a stopped service and is idempotent'
printf 'exited/unhealthy\n' > "$STATE/worker"; rollback_out=$(export FAKE_REGRESS_ON_UP=1; run doctor --yes 2>&1); [[ "$rollback_out" == *'restoring exact pre-repair'* ]] || fail doctor-rollback; [[ ! -f "$STATE/health-fail" ]] || fail doctor-rollback-health; ok 'doctor rolls back when a repair regresses readiness'
(export FAKE_CONFIG_FAIL=1; run doctor --check-only >/dev/null 2>&1) && fail check-only; ok 'doctor check-only is read-only and reports precise blockers'
ai_out=$(export FAKE_CONFIG_FAIL=1 JOSI_AI_PROVIDER=adapter; run doctor --ai-repair --yes 2>&1 || true); [[ "$ai_out" == *'--allow-ai'* ]] || fail ai-consent; ok 'AI repair refuses without separate consent even when --yes is present'
ai_out=$(export FAKE_CONFIG_FAIL=1 JOSI_AI_PROVIDER=adapter JOSI_AI_TEST_ADAPTER=1 JOSI_AI_ADAPTER="$TMP/not-present"; run doctor --ai-repair --allow-ai 2>&1 || true); [[ "$ai_out" == *'unavailable'* ]] || fail ai-provider; ok 'AI repair fails closed when configured provider is unavailable'
cat > "$TMP/adapter-ok" <<'EOF'
#!/bin/sh
printf 'docker compose restart web\n' > "$2"
EOF
cat > "$TMP/adapter-bad" <<'EOF'
#!/bin/sh
printf 'rm -rf /\n' > "$2"
EOF
chmod +x "$TMP/adapter-ok" "$TMP/adapter-bad"
touch "$STATE/public-fail"; ai_out=$(export JOSI_AI_PROVIDER=adapter JOSI_AI_TEST_ADAPTER=1 JOSI_AI_ADAPTER="$TMP/adapter-ok"; run doctor --ai-repair --allow-ai 2>&1 || true); [[ "$ai_out" == *'second approval'* && -f "$STATE/public-fail" ]] || fail ai-second-approval; ok 'AI plan is shown but not executed without second approval'
(export JOSI_AI_PROVIDER=adapter JOSI_AI_TEST_ADAPTER=1 JOSI_AI_ADAPTER="$TMP/adapter-ok"; run doctor --ai-repair --allow-ai --approve-ai-plan >/dev/null); [[ ! -f "$STATE/public-fail" ]] || fail ai-success; ok 'approved allowlisted AI repair is postcondition-verified'
touch "$STATE/public-fail"; ai_out=$(export JOSI_AI_PROVIDER=adapter JOSI_AI_TEST_ADAPTER=1 JOSI_AI_ADAPTER="$TMP/adapter-ok" FAKE_AI_REGRESS_ON_RESTART=1; run doctor --ai-repair --allow-ai --approve-ai-plan 2>&1 || true); [[ "$ai_out" == *'AI repair regressed readiness'* && ! -f "$STATE/health-fail" ]] || fail ai-rollback; rm -f "$STATE/public-fail"; ok 'AI repair rolls back its snapshot when readiness regresses'
touch "$STATE/public-fail"; (export JOSI_AI_PROVIDER=adapter JOSI_AI_TEST_ADAPTER=1 JOSI_AI_ADAPTER="$TMP/adapter-bad"; run doctor --ai-repair --allow-ai --approve-ai-plan >/dev/null 2>&1) && fail ai-scope; rm -f "$STATE/public-fail"; ok 'AI execution rejects commands outside the allowlist'
run backup > "$TMP/backup.out"; b=$(tail -1 "$TMP/backup.out"); gzip -t "$b"; test -s "$b.sha256" || fail backup; ok 'backup is compressed, checksummed, and verified'
run update 9.9.9 --yes >/dev/null 2>&1 && fail update-should-rollback
[[ "$(sed -n 's/^JOSI_TAG=//p' "$INSTALL/.env")" == 0.1.0 ]] || fail update-rollback; ok 'failed update rolls back to prior pin after verified backup'
: > "$STATE/calls"; run uninstall --yes >/dev/null; ! grep -q -- '--volumes' "$STATE/calls" || fail uninstall-data; ok 'uninstall defaults to keeping volumes and user data'
run uninstall --purge-data >/dev/null 2>&1 && fail purge-refusal; ok 'data purge requires an explicit destructive confirmation phrase'
printf 'CLI tests passed: %d\n' "$PASS"
