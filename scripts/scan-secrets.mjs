#!/usr/bin/env node
// Native Node runner for the existing repository policy. The Bash scanner stays
// usable on existing hosts; this parser fails closed if its policy shape changes.
import { readFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Decode only shell literal concatenation, never evaluate shell expressions. */
function literal(source) {
  let value = '', quote = '', started = false;
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (quote) {
      if (char === quote) quote = '';
      else {
        if (quote === '"' && /[$`\\]/.test(char)) throw new Error('Unsupported policy interpolation');
        value += char;
      }
    } else if (char === "'" || char === '"') { quote = char; started = true; }
    else if (/\s/.test(char) && started) {
      const rest = source.slice(index).trim();
      if (rest && !rest.startsWith('#')) throw new Error('Unexpected policy suffix');
      break;
    } else if (!/\s/.test(char)) throw new Error('Policy values must be quoted literals');
  }
  if (!started || quote) throw new Error('Incomplete policy value');
  return value;
}

export function policy() {
  const source = readFileSync(resolve(root, 'scripts/scan-secrets.sh'), 'utf8');
  const array = name => {
    const match = source.match(new RegExp(`^${name}=\\(\\r?\\n([\\s\\S]*?)^\\)`, 'm'));
    if (!match) throw new Error('Repository secret policy is missing');
    // The original literal list includes several quoted values on each line.
    // Credential regexes contain spaces and are one complete literal per line.
    if (name === 'FORBIDDEN_LITERAL') {
      const lines = match[1].split(/\r?\n/).map(line => line.replace(/\s+#.*$/, '').trim()).filter(line => line && !line.startsWith('#'));
      return lines.flatMap(line => {
        const values = [...line.matchAll(/'([^']*)'/g)].map(item => item[1]);
        if (!values.length || line.replace(/'[^']*'/g, '').trim()) throw new Error('Unsupported literal policy');
        return values;
      });
    }
    return match[1].split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#')).map(literal);
  };
  const attribution = source.match(/^ATTRIBUTION_REGEX=(.+)$/m);
  const publicFiles = source.match(/case "\$file" in\r?\n\s+([^\n]+)\)\r?\n\s+public_installer_file=1/);
  if (!attribution || !publicFiles) throw new Error('Repository hostname policy is missing');
  return { literals: array('FORBIDDEN_LITERAL'), expressions: array('FORBIDDEN_REGEX').map(value => new RegExp(value)),
    // In the existing POSIX ERE character class, \n denotes literal n, not a
    // newline. Preserve that policy exactly; scanning is already per line.
    attribution: new RegExp(literal(attribution[1]).replaceAll('\\n', 'n'), 'i'), publicFiles: new Set(publicFiles[1].trim().split('|')) };
}

export function scanText(source, file, rules = policy()) {
  const results = [];
  const publicInstaller = rules.publicFiles.has(file);
  for (const [index, line] of source.split(/\r?\n/).entries()) {
    const publicMailRemoved = line.replaceAll('roman@socalreceptionist.com', '');
    for (const needle of rules.literals) {
      if (publicMailRemoved.includes(needle)) results.push({ line: index + 1, kind: 'forbidden string' });
    }
    for (const match of line.matchAll(/heyjosi\.com/g)) {
      const before = line.slice(0, match.index), after = line.slice(match.index + match[0].length);
      const prefix = before.endsWith('help.') ? before.slice(0, -5)
        : publicInstaller && before.endsWith('get.') ? before.slice(0, -4) : null;
      if (prefix === null || /[A-Za-z0-9.-]$/.test(prefix) || /^[A-Za-z0-9.-]/.test(after)) {
        results.push({ line: index + 1, kind: 'forbidden production hostname' });
      }
    }
    for (const pattern of rules.expressions) {
      if (pattern.test(line)) results.push({ line: index + 1, kind: 'credential-shaped string' });
    }
    if (rules.attribution.test(line)) results.push({ line: index + 1, kind: 'incorrect creator attribution' });
  }
  return results;
}

function skipped(file) {
  return ['scripts/scan-secrets.sh', 'scripts/scan-secrets.mjs'].includes(file)
    || /\.(png|jpg|jpeg|gif|ico|webp|pdf|zip|woff|woff2|ttf)$/.test(file)
    || /(^|\/)package-lock\.json$/.test(file);
}

export function main(args = process.argv.slice(2)) {
  const rules = policy();
  const includeUntracked = args.includes('--include-untracked');
  args = args.filter(value => value !== '--include-untracked');
  const files = args.length ? args : execFileSync('git', ['ls-files', '-z', ...(includeUntracked ? ['--cached', '--others', '--exclude-standard'] : [])],
    { cwd: root, encoding: 'utf8', windowsHide: true }).split('\0').filter(Boolean);
  let findings = 0, scanned = 0;
  for (const input of new Set(files)) {
    const path = resolve(root, input), file = relative(root, path).split('\\').join('/');
    scanned++;
    if (skipped(file)) continue;
    let contents;
    try {
      if (!statSync(path).isFile()) continue;
      contents = readFileSync(path);
    } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (contents.includes(0)) continue;
    for (const result of scanText(contents.toString('utf8'), file, rules)) {
      // Never print a matching secret or the source line.
      console.error(`${file}:${result.line} ${result.kind}`);
      findings++;
    }
  }
  console.log(findings ? `secret scan FAILED: ${findings} finding(s)` : `secret scan clean (${scanned} files)`);
  return findings ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = main(); }
  catch { console.error('secret scan could not complete; no clean result'); process.exitCode = 1; }
}
