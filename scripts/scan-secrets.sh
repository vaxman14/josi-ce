#!/usr/bin/env bash
# Refuse to let commercial material or credentials into the public-facing CE repo.
#
# This exists because CE is derived from a private commercial codebase that
# contains real customer phone numbers, production endpoints and live API keys.
# A .gitignore stops files; this stops *strings* that get pasted, templated or
# copied into a file that is otherwise perfectly innocent.
#
#   scripts/scan-secrets.sh            scan tracked + staged files
#   scripts/scan-secrets.sh <path...>  scan specific paths (used by tests)
#
# Exit 0 = clean. Exit 1 = something was found; the commit must not proceed.
set -uo pipefail

cd "$(dirname "$0")/.."

# ---------------------------------------------------------------- what we ban
# SoCal business lines. These are real numbers that real customers call; they
# are hard-blocked in the commercial engine and must never appear here at all.
FORBIDDEN_LITERAL=(
  '+19514776060' '+19513958776' '+19514254567' '+19517177772'
  '9514776060' '9513958776' '9514254567' '9517177772'
  # Production endpoints and hosts belonging to the hosted product.
  'heyjosi.com'
  'socalreceptionist.com'
  '10.10.1.3'
  '10.10.1.5'
  '/Volumes/josi/Projects/'
  '143.110.236.218'
  # Supabase project ref for the live SoCal database.
  'xcngpfeuvvcsxgwyukch'
  # Zammad's internal binding — support infrastructure, not CE's business.
  '127.0.0.1:8111'
)

# Credential shapes. Deliberately broad: a false positive costs a conversation,
# a false negative costs a rotation.
FORBIDDEN_REGEX=(
  'sk-[A-Za-z0-9_-]{20,}'                       # OpenAI-style keys
  'sk-ant-[A-Za-z0-9_-]{20,}'                   # Anthropic keys
  'xai-[A-Za-z0-9_-]{20,}'                      # xAI keys
  'AKIA[0-9A-Z]{16}'                            # AWS access key id
  'AIza[0-9A-Za-z_-]{35}'                       # Google API key
  'ghp_[A-Za-z0-9]{36}'                         # GitHub PAT
  'github_pat_[A-Za-z0-9_]{50,}'
  'BEGIN [A-Z ]*PRIVATE KEY'                    # PEM
  'eyJ[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]{20,}' # JWT (cloudflared tokens etc.)
  # A DSN carrying an inline password. The username part is restricted to plain
  # identifier characters so that shell interpolation — postgresql://${PGUSER:-josi}@db,
  # whose ":-" default syntax looks like a user:password pair — is not a match.
  # A real credential still is: postgresql://user:hunter2@host.
  'postgres(ql)?://[A-Za-z0-9._%+-]+:[^@/ "'"'"'`]{3,}@'
  '[0-9a-f]{32}-us[0-9]{1,2}'                   # Mailchimp-style
)

# CTF Designs must never be presented as the creator of Josi (canonical map).
# The name may legitimately appear in prose that names the *other* company, so
# this looks for creator/author/by attributions specifically.
ATTRIBUTION_REGEX='(created|authored|developed|made|built|published)[^.\n]{0,40}(by )?CTF Designs|CTF Designs[^.\n]{0,20}(is the|as the)?[^.\n]{0,20}(creator|author|publisher|maker)'

# Files we never scan: the scanner's own ban-list, lockfiles, binaries.
is_skippable() {
  case "$1" in
    scripts/scan-secrets.sh) return 0 ;;
    *.png|*.jpg|*.jpeg|*.gif|*.ico|*.webp|*.pdf|*.zip|*.woff|*.woff2|*.ttf) return 0 ;;
    package-lock.json|*/package-lock.json) return 0 ;;
    *) return 1 ;;
  esac
}

# Portable file collection. macOS ships bash 3.2, which has no `mapfile`, and
# this hook has to run on Roman's Mac as well as in a Linux CI container.
FILE_LIST="$(mktemp)"
trap 'rm -f "$FILE_LIST"' EXIT

if [[ $# -gt 0 ]]; then
  printf '%s\n' "$@" > "$FILE_LIST"
else
  # Tracked plus staged, deduplicated. Untracked-and-unstaged files are not
  # going into the commit, so they are not this hook's problem.
  { git ls-files; git diff --cached --name-only --diff-filter=ACM; } 2>/dev/null \
    | sort -u > "$FILE_LIST"
fi

scanned=0
findings=0
report() {
  printf '  %s\n' "$1"
  findings=$((findings + 1))
}

while IFS= read -r file; do
  [[ -n "$file" ]] || continue
  scanned=$((scanned + 1))
  [[ -f "$file" ]] || continue
  is_skippable "$file" && continue
  # Skip anything that is not text.
  if ! grep -Iq . "$file" 2>/dev/null; then continue; fi

  for needle in "${FORBIDDEN_LITERAL[@]}"; do
    if grep -Fn -- "$needle" "$file" >/dev/null 2>&1; then
      while IFS= read -r hit; do
        report "$file:${hit%%:*}  forbidden string: $needle"
      done < <(grep -Fn -- "$needle" "$file")
    fi
  done

  for pattern in "${FORBIDDEN_REGEX[@]}"; do
    if grep -En -- "$pattern" "$file" >/dev/null 2>&1; then
      while IFS= read -r hit; do
        report "$file:${hit%%:*}  looks like a credential (/$pattern/)"
      done < <(grep -En -- "$pattern" "$file")
    fi
  done

  if grep -Eni -- "$ATTRIBUTION_REGEX" "$file" >/dev/null 2>&1; then
    report "$file  attributes Josi to CTF Designs; the creator is SOCAL RECEPTIONIST LLC"
  fi
done < "$FILE_LIST"

if [[ $findings -gt 0 ]]; then
  echo
  echo "secret scan FAILED: $findings finding(s) above."
  echo "Nothing from the commercial engine's production surface may enter this repo."
  exit 1
fi

echo "secret scan clean ($scanned files)"
exit 0
