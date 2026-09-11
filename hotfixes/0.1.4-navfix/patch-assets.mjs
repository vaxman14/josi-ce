import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const oldAsset = 'index-D1Np6mY1.js';
const newAsset = 'index-D1Np6mY1-navfix1.js';
const telegramEntry = ',{to:`/app/telegram`,label:`Telegram`}';

for (const root of ['/app/web', '/app/apps/web/dist']) {
  const oldPath = join(root, 'assets', oldAsset);
  const newPath = join(root, 'assets', newAsset);
  const indexPath = join(root, 'index.html');

  const original = readFileSync(oldPath, 'utf8');
  const occurrences = original.split(telegramEntry).length - 1;
  if (occurrences !== 1) {
    throw new Error(`${oldPath}: expected one top-level Telegram entry, found ${occurrences}`);
  }

  const patched = original.replace(telegramEntry, '');
  if (!patched.includes('/app/channels')) {
    throw new Error(`${oldPath}: Channels entry missing after patch`);
  }
  writeFileSync(newPath, patched);

  const index = readFileSync(indexPath, 'utf8');
  const references = index.split(oldAsset).length - 1;
  if (references !== 1) {
    throw new Error(`${indexPath}: expected one asset reference, found ${references}`);
  }
  writeFileSync(indexPath, index.replace(oldAsset, newAsset));
}
