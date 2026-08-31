#!/usr/bin/env bash
# Phase 9 mutation testing.
#
# Foreground segments, as Phase 7 established: backgrounded runs on this machine
# get killed part-way, and two harnesses racing on the same files produce
# meaningless results.
#
#   M_FROM=1 M_TO=6 bash scripts/mutate-phase9.sh
set -uo pipefail
cd "$(dirname "$0")/.."

FILES=(
  packages/storage/src/paths.ts
  packages/storage/src/mappings.ts
  apps/api/src/http/storageRoutes.ts
  apps/api/src/http/authz.ts
  packages/db/migrations/0007_documents.sql
)

BACKUP=$(mktemp -d)
for f in "${FILES[@]}"; do mkdir -p "$BACKUP/$(dirname "$f")"; cp "$f" "$BACKUP/$f"; done
restore() { for f in "${FILES[@]}"; do cp "$BACKUP/$f" "$f"; done; }
trap 'restore; rm -rf "$BACKUP"; echo; echo "(interrupted — sources restored)"; exit 130' INT TERM
trap 'restore; rm -rf "$BACKUP"' EXIT

run() { npx vitest run 2>&1 | grep -E "^ +Tests +" | tail -1; }

M_FROM="${M_FROM:-1}"; M_TO="${M_TO:-99}"; N=0
should_run() { N=$((N+1)); [[ $N -ge $M_FROM && $N -le $M_TO ]]; }

assert_mutated() {
  if diff -rq "$BACKUP/apps" apps >/dev/null 2>&1 && diff -rq "$BACKUP/packages" packages >/dev/null 2>&1; then
    echo "  !! MUTATION DID NOT APPLY — result below is meaningless"; return 1
  fi
  return 0
}

echo "=== BASELINE ==="; run

mut() { echo; echo "=== M$N: $1 ==="; }

# --------------------------------------------------------------------------
# Containment. Each of these is a real way traversal defences get written wrong.
# --------------------------------------------------------------------------
if should_run; then mut "containment uses startsWith instead of a structural check"
python3 - <<'MUT'
p='packages/storage/src/paths.ts'; s=open(p).read()
s=s.replace("""  if (c === p) return true;
  const rel = relative(p, c);
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel);""",
"""  return c.startsWith(p);""",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "symlinks are never resolved — the check runs on the lexical path only"
python3 - <<'MUT'
p='packages/storage/src/paths.ts'; s=open(p).read()
s=s.replace("""  let real: string;
  try {
    real = await rp(candidate);""","""  let real: string = candidate;
  try {
    real = candidate;""",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "'..' is allowed in a path segment"
python3 - <<'MUT'
p='packages/storage/src/paths.ts'; s=open(p).read()
s=s.replace("const FORBIDDEN_SEGMENTS = new Set(['..', '.']);","const FORBIDDEN_SEGMENTS = new Set(['.']);",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "an absolute path is accepted where a relative one was expected"
python3 - <<'MUT'
p='packages/storage/src/paths.ts'; s=open(p).read()
s=s.replace("  if (isAbsolute(input)) throw new PathEscape('that path must be relative to the mapped folder');","",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "a null byte in a path is accepted"
python3 - <<'MUT'
p='packages/storage/src/paths.ts'; s=open(p).read()
s=s.replace("  if (input.includes('\\0')) throw new PathEscape('that path contains a null byte');","",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "the extension is taken from the FIRST dot, so report.pdf.exe is a pdf"
python3 - <<'MUT'
p='packages/storage/src/paths.ts'; s=open(p).read()
s=s.replace("  const dot = base.lastIndexOf('.');","  const dot = base.indexOf('.');",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "a not-yet-existing path is rebuilt under the UNRESOLVED parent"
python3 - <<'MUT'
p='packages/storage/src/paths.ts'; s=open(p).read()
s=s.replace("      return join(realAncestor, ...parts.slice(depth));","      return join(rootReal, cleanRelative);",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

# --------------------------------------------------------------------------
# The grant.
# --------------------------------------------------------------------------
if should_run; then mut "mapping works without the administrator having enabled it — M47"
python3 - <<'MUT'
p='packages/storage/src/mappings.ts'; s=open(p).read()
s=s.replace("  const allowed = args.provider === 'local' ? capability.may_map_local : capability.may_map_cloud;","  const allowed = true;",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "one capability covers both local and cloud"
python3 - <<'MUT'
p='packages/storage/src/mappings.ts'; s=open(p).read()
s=s.replace("  const allowed = args.provider === 'local' ? capability.may_map_local : capability.may_map_cloud;","  const allowed = capability.may_map_local || capability.may_map_cloud;",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "capabilities default to permitted when no row exists"
python3 - <<'MUT'
p='packages/storage/src/mappings.ts'; s=open(p).read()
s=s.replace("""const NO_CAPABILITY: StorageCapability = {
  may_map_local: false,
  may_map_cloud: false,
  may_index: false,""","""const NO_CAPABILITY: StorageCapability = {
  may_map_local: true,
  may_map_cloud: true,
  may_index: true,""",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "the refusal says which kind of mapping was denied"
python3 - <<'MUT'
p='packages/storage/src/mappings.ts'; s=open(p).read()
s=s.replace("""    throw new MappingError('an administrator has not enabled folder mapping for you', 'not_permitted');""",
"""    throw new MappingError(`an administrator has not enabled ${args.provider} folder mapping for you`, 'not_permitted');""",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "a mapping starts with every permission granted — M47"
python3 - <<'MUT'
p='packages/db/migrations/0007_documents.sql'; s=open(p).read()
s=s.replace("""  may_create boolean not null default false,
  may_edit boolean not null default false,
  may_move boolean not null default false,
  may_delete boolean not null default false,""",
"""  may_create boolean not null default true,
  may_edit boolean not null default true,
  may_move boolean not null default true,
  may_delete boolean not null default true,""",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "a mapping starts indexed"
python3 - <<'MUT'
p='packages/db/migrations/0007_documents.sql'; s=open(p).read()
s=s.replace("  indexing_enabled boolean not null default false,","  indexing_enabled boolean not null default true,",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "a mapping is recursive by default — M50"
python3 - <<'MUT'
p='packages/db/migrations/0007_documents.sql'; s=open(p).read()
s=s.replace("  recursive boolean not null default false,","  recursive boolean not null default true,",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "a read-only root can be made writable by its owner"
python3 - <<'MUT'
p='packages/storage/src/mappings.ts'; s=open(p).read()
s=s.replace("    if (wantsWrite && !root?.writable) {","    if (false) {",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "a disabled root is still mappable"
python3 - <<'MUT'
p='packages/storage/src/mappings.ts'; s=open(p).read()
s=s.replace("  if (!root || !root.enabled) throw new MappingError('that folder is not available', 'no_such_root');","  if (!root) throw new MappingError('that folder is not available', 'no_such_root');",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "containment is not checked when the grant is created — M45"
python3 - <<'MUT'
p='packages/storage/src/mappings.ts'; s=open(p).read()
s=s.replace("  const resolved = await resolveWithin(root.container_path, relativePath, { mustExist: true });","  const resolved = { absolute: root.container_path, relative: relativePath };",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "a root may be registered anywhere on the host — M45"
python3 - <<'MUT'
p='packages/storage/src/mappings.ts'; s=open(p).read()
s=s.replace("""  if (!isInside(base, path)) {
    throw new MappingError('a root must be under the folder Josi mounts shared storage into', 'bad_root');
  }""","",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "root registration uses startsWith, so a sibling prefix passes"
python3 - <<'MUT'
p='packages/storage/src/mappings.ts'; s=open(p).read()
s=s.replace("  if (!isInside(base, path)) {","  if (!path.startsWith(base)) {",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

# --------------------------------------------------------------------------
# Ownership and the administrator's limits.
# --------------------------------------------------------------------------
if should_run; then mut "any signed-in person may change a mapping's permissions — M68"
python3 - <<'MUT'
p='packages/storage/src/mappings.ts'; s=open(p).read()
s=s.replace("""  const [row] = await db.query<Mapping>(
    `select * from folder_mappings where id = $1 and owner_user_id = $2`,
    [mappingId, userId],
  );""","""  const [row] = await db.query<Mapping>(
    `select * from folder_mappings where id = $1`,
    [mappingId],
  );""",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "a shared mapping may be unmapped by the person it was shared with"
python3 - <<'MUT'
p='apps/api/src/http/storageRoutes.ts'; s=open(p).read()
s=s.replace("""    '/mappings/:id',
    requireOwnership({ db }, { type: 'folder_mapping', need: 'owner' }),
    handle(async (req, res) => {
      const purged = await unmapFolder(db, {""","""    '/mappings/:id',
    requireOwnership({ db }, { type: 'folder_mapping', need: 'write' }),
    handle(async (req, res) => {
      const purged = await unmapFolder(db, {""",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "the mapping route takes its owner from the request body — M47"
python3 - <<'MUT'
p='apps/api/src/http/storageRoutes.ts'; s=open(p).read()
s=s.replace("        ownerUserId: req.user!.id,\n        provider,","        ownerUserId: str(req.body?.ownerUserId, 64) || req.user!.id,\n        provider,",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "a member may set storage capabilities"
python3 - <<'MUT'
p='apps/api/src/http/storageRoutes.ts'; s=open(p).read()
s=s.replace("""    '/admin/capabilities/:userId',
    requireSuperAdmin,""","""    '/admin/capabilities/:userId',""",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "a member may read the admin health view"
python3 - <<'MUT'
p='apps/api/src/http/storageRoutes.ts'; s=open(p).read()
s=s.replace("""    '/admin/health',
    requireSuperAdmin,""","""    '/admin/health',""",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "the admin capability list joins in the folder paths — M72"
python3 - <<'MUT'
p='apps/api/src/http/storageRoutes.ts'; s=open(p).read()
s=s.replace("""                (select count(*)::int from folder_mappings m where m.owner_user_id = u.id) as mappings""",
"""                (select count(*)::int from folder_mappings m where m.owner_user_id = u.id) as mappings,
                (select string_agg(m.display_path, ',') from folder_mappings m where m.owner_user_id = u.id) as paths""",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "the audit log records which folder was mapped — M72"
python3 - <<'MUT'
p='packages/storage/src/mappings.ts'; s=open(p).read()
s=s.replace("""    payload: {
      provider: mapping.provider,
      recursive: mapping.recursive,
      indexing: mapping.indexing_enabled,
    },""","""    payload: {
      provider: mapping.provider,
      recursive: mapping.recursive,
      indexing: mapping.indexing_enabled,
      path: mapping.display_path,
    },""",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

# --------------------------------------------------------------------------
# Purge.
# --------------------------------------------------------------------------
if should_run; then mut "revoking indexing keeps the extracted data — M54"
python3 - <<'MUT'
p='packages/storage/src/mappings.ts'; s=open(p).read()
s=s.replace("  const purged = args.enabled ? null : await purgeDerived(db, args.mappingId);","  const purged = null;",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "unmapping leaves the derived data behind — M54"
python3 - <<'MUT'
p='packages/storage/src/mappings.ts'; s=open(p).read()
s=s.replace("""  const purged = await purgeDerived(db, args.mappingId);
  await db.query(`delete from folder_mappings where id = $1`, [args.mappingId]);""",
"""  const purged = { documents: 0 };
  await db.query(`delete from folder_mappings where id = $1`, [args.mappingId]);""",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "an administrator revoking may_index leaves the indexed text in place"
python3 - <<'MUT'
p='apps/api/src/http/storageRoutes.ts'; s=open(p).read()
s=s.replace("      if (flag(req.body?.mayIndex) === false) {","      if (false) {",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "indexing may be turned on without the administrator's half — M49"
python3 - <<'MUT'
p='packages/storage/src/mappings.ts'; s=open(p).read()
s=s.replace("    if (!capability.may_index) {","    if (false) {",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "pausing a mapping destroys its data — M78"
python3 - <<'MUT'
p='packages/storage/src/mappings.ts'; s=open(p).read()
s=s.replace("""  if (!row) return;
  await appendEvent(db, {""","""  if (!row) return;
  await purgeDerived(db, args.mappingId);
  await appendEvent(db, {""",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

# --------------------------------------------------------------------------
# Consent wording. M50 makes this a control, not copy.
# --------------------------------------------------------------------------
if should_run; then mut "a recursive scope does not mention future subfolders — M50"
python3 - <<'MUT'
p='packages/storage/src/mappings.ts'; s=open(p).read()
s=s.replace("    ? `${args.displayPath}, everything inside it, and any subfolder added to it in future`","    ? `${args.displayPath} and everything currently inside it`",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "the indexing consent does not mention the language model — M49"
python3 - <<'MUT'
p='packages/storage/src/mappings.ts'; s=open(p).read()
s=s.replace("  return `${read} Josi will also read every file in it now and keep the extracted text so it can search them, and will send that text to the language model you have configured when answering questions.`;","  return `${read} Josi will also index it.`;",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "mapping and indexing consent say the same thing"
python3 - <<'MUT'
p='packages/storage/src/mappings.ts'; s=open(p).read()
s=s.replace("""  if (!args.indexing) {
    return `${read} Files are read only when something you ask for needs them. Nothing is copied or kept.`;
  }""","",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

# --------------------------------------------------------------------------
# M70.
# --------------------------------------------------------------------------
if should_run; then mut "shared mappings do not block user removal — M70"
python3 - <<'MUT'
p='packages/storage/src/mappings.ts'; s=open(p).read()
s=s.replace("""     join resource_shares s
       on s.resource_type = 'folder_mapping' and s.resource_id = m.id""",
"""     left join resource_shares s
       on s.resource_type = 'folder_mapping' and s.resource_id = m.id and false""",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if [[ "$M_TO" -ge 99 ]]; then
  echo; echo "=== RESTORED — full suite must be green ==="; run
fi
