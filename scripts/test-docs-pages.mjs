import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../docs-site/body.html', import.meta.url), 'utf8');
const root = new URL('../docs-site/public/', import.meta.url);
const read = (path) => fs.readFileSync(new URL(path, root), 'utf8');
const home = read('index.html');
const install = read('install/index.html');
const legal = read('legal/index.html');
const legalOriginal = source.slice(source.indexOf('<h2 id="terms-of-use">'));
const visibleText = (html) => html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();

assert.match(home, /<h2 id="help">Help and current features<\/h2>/);
assert.match(home, /beta-quality software/, 'Keep the preview safety warning visible in Help');
assert.match(home, /href="install\/"[^>]*>Install Josi<span>/);
assert.match(home, /href="legal\/"[^>]*>Legal notices<span>/);
assert.doesNotMatch(home, /<h2 id="terms-of-use">/);
assert.doesNotMatch(home, /<h2 id="installation">/);
assert.match(home, /case 'terms-of-use':|['"]terms-of-use['"]/, 'old app legal hashes must redirect');

assert.match(install, /<h2 id="installation">1\. Run the installer<\/h2>/);
assert.match(install, /<h2 id="troubleshooting">Troubleshooting<\/h2>/);
assert.match(install, /Docker Desktop/);
assert.match(install, /docker\.io\/romanvaxman\/josi-ce-installer:latest/);
assert.match(install, /\.docker\/run\/docker\.sock/);
assert.match(install, /\/var\/run\/docker\.sock/);
assert.match(install, /copy or download it/);
assert.match(install, /Open the Josi URL and send a message/);
assert.match(install, /<h2 id="use-josi-on-your-devices">Use Josi on your devices<\/h2>/);
assert.match(install, /play\.google\.com\/store\/apps\/details\?id=com\.socalreceptionist\.josice/);
assert.match(install, /<strong>Public URL<\/strong> or <strong>Tailscale<\/strong>/);
assert.match(install, /<strong>Verify and continue<\/strong>/);
const afterInstallationIndex = install.indexOf('<h2 id="after-installation">');
const nativeAppsIndex = install.indexOf('<h2 id="use-josi-on-your-devices">');
const updatingIndex = install.indexOf('<h2 id="updating-josi">');
assert.ok(afterInstallationIndex < nativeAppsIndex && nativeAppsIndex < updatingIndex, 'Native apps must follow After installation');
assert.match(install, /<details class="mobile-index">[\s\S]*?href="#troubleshooting"[\s\S]*?<\/details>/, 'Guide index must be available on phones');
assert.doesNotMatch(install, /<REPOSITORY-URL>|git clone|josi doctor|\/health|\/ready|Confirm each dependency:/);
assert.doesNotMatch(install, /<h2 id="terms-of-use">/);

for (const id of ['terms-of-use', 'privacy-notice', 'cookie-notice', 'software-and-paid-feature-licences']) {
  assert.match(legal, new RegExp(`<h2 id="${id}">`));
  assert.match(legal, new RegExp(`href="#${id}"`));
}
assert.doesNotMatch(legal, /1\. Run the installer/);
assert.doesNotMatch(legal, /Confirm each dependency:/, 'Do not include installation material on notices');
assert.equal(visibleText(legal.match(/<article>([\s\S]*?)<\/article>/)?.[1] ?? ''), visibleText(legalOriginal), 'Legal notice text must remain unchanged');

for (const [name, page] of [['home', home], ['installation', install], ['legal', legal]]) {
  const canonicalPath = name === 'home' ? '' : name === 'installation' ? 'install/' : 'legal/';
  assert.match(page, new RegExp(`<link rel="canonical" href="https://help\\.heyjosi\\.com/${canonicalPath}">`), `${name}: canonical Help domain`);
  const sidebar = page.match(/<aside class="side">([\s\S]*?)<\/aside>/)?.[1] ?? '';
  const ids = [...page.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(ids.length, new Set(ids).size, `${name}: duplicate IDs`);
  for (const [, id] of sidebar.matchAll(/href="#([^"]+)"/g)) assert.ok(ids.includes(id), `${name}: dead sidebar link #${id}`);
}
console.log('docs_separate_pages=pass');
