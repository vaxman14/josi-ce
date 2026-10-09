import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
const hash = value => createHash('sha256').update(value).digest('hex');

export function normalize(input) {
  let text = input.toString('utf8');
  if (!Buffer.from(text).equals(input)) throw new Error('Dump is not canonical UTF-8');
  // Only known dump wrappers outside the SQL body may lose volatile tokens.
  const firstObject = text.indexOf('-- Name: ');
  if (firstObject < 0) throw new Error('No standard pg_dump object boundary');
  const header = text.slice(0, firstObject).replace(/^\\restrict [A-Za-z0-9]+\r?\n/gm, '');
  text = header + text.slice(firstObject);
  text = text.replace(/(\r?\n--\r?\n-- PostgreSQL database dump complete\r?\n--\r?\n)(?:\r?\n)*\\unrestrict [A-Za-z0-9]+(?:\r?\n)*$/, '$1');
  const lines = text.split('\n');
  const tables = new Map(), canonical = [], structural = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = /^COPY (.+) \((.+)\) FROM stdin;\r?$/.exec(line);
    if (!match) { canonical.push(line); structural.push(line); continue; }
    const rows = [];
    while (++i < lines.length && !/^\\\.\r?$/.test(lines[i])) rows.push(lines[i]);
    if (i === lines.length || tables.has(match[1])) throw new Error('Unterminated or duplicate COPY block');
    rows.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    tables.set(match[1], { columns: match[2], rows });
    canonical.push(line, ...rows, lines[i]);
    structural.push(line, lines[i]);
  }
  return { text: canonical.join('\n'), structural: structural.join('\n'), tables };
}
export function compare(before, after) {
  const a = normalize(before), b = normalize(after);
  const differences = [];
  for (const name of new Set([...a.tables.keys(), ...b.tables.keys()])) {
    const old = a.tables.get(name), current = b.tables.get(name);
    if (!old || !current) { differences.push({ table: name, kind: old ? 'table-data-block-missing' : 'table-data-block-added', oldRows: old?.rows.length ?? 0, newRows: current?.rows.length ?? 0 }); continue; }
    const oldCounts = new Map(), newCounts = new Map();
    for (const row of old.rows) oldCounts.set(row, (oldCounts.get(row) ?? 0) + 1);
    for (const row of current.rows) newCounts.set(row, (newCounts.get(row) ?? 0) + 1);
    let removed = 0, added = 0;
    for (const [row, count] of oldCounts) removed += Math.max(0, count - (newCounts.get(row) ?? 0));
    for (const [row, count] of newCounts) added += Math.max(0, count - (oldCounts.get(row) ?? 0));
    if (added || removed || old.columns !== current.columns) differences.push({ table: name, kind: 'row-or-column-difference', oldRows: old.rows.length, newRows: current.rows.length, addedRows: added, removedRows: removed, columnsChanged: old.columns !== current.columns });
  }
  const meaningfulSqlDifference = a.structural !== b.structural;
  return { exactNormalizedMatch: a.text === b.text, schemaAndOtherSqlMatch: !meaningfulSqlDifference,
    rowMultisetsMatch: differences.length === 0, tablesCompared: new Set([...a.tables.keys(), ...b.tables.keys()]).size,
    snapshotNormalizedSha256: hash(a.text), liveNormalizedSha256: hash(b.text), differences,
    normalization: ['Only top-level pg_dump restriction tokens', 'COPY rows sorted as multisets; duplicates and escaped values preserved'],
    includesSchemaSequencesOwnerCommentsAndOtherSql: true };
}
if (process.argv[2] === 'test') {
  const fixture = (rows, token = 'abc') => Buffer.from(`--\n-- PostgreSQL database dump\n--\n\\restrict ${token}\n\n--\n-- Name: t; Type: TABLE; Schema: public; Owner: josi\n--\nCREATE TABLE public.t (value text);\nCOPY public.t (value) FROM stdin;\n${rows.join('\n')}\n\\.\n\nSELECT pg_catalog.setval('public.s', 1, true);\n\n--\n-- PostgreSQL database dump complete\n--\n\n\\unrestrict ${token}\n\n`);
  assert.equal(compare(fixture(['a', 'b']), fixture(['b', 'a'], 'xyz')).exactNormalizedMatch, true);
  assert.equal(compare(fixture(['a', 'a']), fixture(['a'])).exactNormalizedMatch, false);
  assert.equal(compare(fixture(['\\N']), fixture([''])).exactNormalizedMatch, false);
  assert.equal(compare(fixture(['a\\nb']), fixture(['a\\rb'])).exactNormalizedMatch, false);
  assert.equal(compare(fixture(['a']), Buffer.from(fixture(['a']).toString().replace("setval('public.s', 1", "setval('public.s', 2"))).schemaAndOtherSqlMatch, false);
  assert.equal(compare(fixture(['a']), Buffer.from(fixture(['a']).toString().replace('Owner: josi', 'Owner: changed'))).schemaAndOtherSqlMatch, false);
  assert.equal(compare(fixture(['a']), Buffer.from(fixture(['a']).toString().replace('value text', 'value integer'))).schemaAndOtherSqlMatch, false);
  console.log('Seven SQL normalization safety tests passed.');
}
