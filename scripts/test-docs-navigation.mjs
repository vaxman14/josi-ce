import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../docs-site/index.html', import.meta.url), 'utf8');
const topNav = html.match(/<nav class="top-links">([\s\S]*?)<\/nav>/)?.[1] ?? '';
const sidebar = html.match(/<aside class="side">([\s\S]*?)<\/aside>/)?.[1] ?? '';

for (const [label, anchor] of [
  ['Installation guide', 'installation'],
  ['Configuration options', 'configuration'],
]) {
  assert.match(topNav, new RegExp(`href="#${anchor}"`), `${label} must be in the top navigation`);
  assert.match(sidebar, new RegExp(`href="#${anchor}"`), `${label} must be in the sidebar`);
  assert.match(html, new RegExp(`<h2 id="${anchor}">`), `${label} must have a real heading target`);
}

assert.ok(sidebar.indexOf('href="#installation"') < sidebar.indexOf('href="#terms-of-use"'), 'Installation should appear before legal links in the sidebar');
assert.ok(sidebar.indexOf('href="#configuration"') < sidebar.indexOf('href="#terms-of-use"'), 'Configuration should appear before legal links in the sidebar');
assert.match(topNav, /Start installing<\/a>/, 'The start-installing shortcut should remain visible');
assert.match(topNav, /href="#installation"[^>]*>Start installing<\/a>/, 'Start installing must land on the guide');
assert.ok(html.indexOf('id="installation"') < html.indexOf('id="terms-of-use"'), 'Installation should precede the legal section');
assert.ok(html.indexOf('id="configuration"') > html.indexOf('id="installation"'), 'Configuration should be within the guide');
console.log('docs_install_navigation=pass');
