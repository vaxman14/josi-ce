import assert from 'node:assert/strict';
function timestamp(value) {
  if (value === '\\N' || value === 'infinity' || value === '-infinity') return value;
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?([+-])(\d{2})(?::(\d{2}))?(?::(\d{2}))?$/.exec(value);
  assert.ok(m, 'Unsupported timestamp format; comparison cannot be declared equal');
  const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number);
  assert.ok(year >= 100 && month >= 1 && month <= 12 && day >= 1 && day <= 31 && hour <= 23 && minute <= 59 && second <= 59);
  const local = Date.UTC(year, month - 1, day, hour, minute, second);
  const original = new Date(local).toISOString().slice(0, 19).replace('T', ' ');
  assert.equal(original, `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}`, 'Invalid timestamp calendar date');
  const offsetHour = Number(m[9]), offsetMinute = Number(m[10] ?? 0), offsetSecond = Number(m[11] ?? 0);
  assert.ok(offsetHour <= 15 && offsetMinute <= 59 && offsetSecond <= 59);
  const offset = (offsetHour * 3600 + offsetMinute * 60 + offsetSecond) * (m[8] === '+' ? 1 : -1);
  const utc = new Date(local - offset * 1000).toISOString().slice(0, 19).replace('T', ' ');
  return `${utc}.${(m[7] ?? '').padEnd(6, '0')}+00`;
}

function typedNormalize(buffer) {
  const text = buffer.toString('utf8');
  assert.ok(Buffer.from(text).equals(buffer));
  const types = new Map();
  for (const table of text.matchAll(/^CREATE TABLE (.+) \(\r?\n([\s\S]*?)^\);\r?$/gm)) {
    const names = new Set();
    for (const column of table[2].matchAll(/^    ((?:"(?:[^"]|"")+")|[A-Za-z_][A-Za-z0-9_]*) timestamp(?:\(\d+\))? with time zone\b/gm)) names.add(column[1]);
    assert.ok(!types.has(table[1]));
    types.set(table[1], names);
  }
  const lines = text.split('\n'), changed = new Map();
  for (let i = 0; i < lines.length; i++) {
    const copy = /^COPY (.+) \((.+)\) FROM stdin;\r?$/.exec(lines[i]);
    if (!copy) continue;
    assert.ok(types.has(copy[1]), 'COPY table lacks an unambiguous schema declaration');
    const columns = copy[2].split(', '), timestampColumns = types.get(copy[1]);
    const indices = columns.map((name, index) => timestampColumns.has(name) ? index : -1).filter(index => index >= 0);
    const counts = new Map();
    while (++i < lines.length && !/^\\\.\r?$/.test(lines[i])) {
      const suffix = lines[i].endsWith('\r') ? '\r' : '';
      const fields = (suffix ? lines[i].slice(0, -1) : lines[i]).split('\t');
      assert.equal(fields.length, columns.length);
      for (const index of indices) {
        const before = fields[index];
        fields[index] = timestamp(before);
        if (before !== fields[index]) counts.set(columns[index], (counts.get(columns[index]) ?? 0) + 1);
      }
      lines[i] = fields.join('\t') + suffix;
    }
    assert.ok(i < lines.length);
    if (counts.size) changed.set(copy[1], [...counts].map(([column, count]) => ({ column, normalizedValues: count })));
  }
  return { buffer: Buffer.from(lines.join('\n')), changed, types };
}


export { typedNormalize };
