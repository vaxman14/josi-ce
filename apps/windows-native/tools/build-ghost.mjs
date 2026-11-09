// Packs the Masko ghost clips for the Windows app. WPF can't play transparent
// video, so each clip becomes frames: colour as JPEG, already multiplied by its
// alpha so edges can't halo, and alpha as a greyscale PNG. Ghost.cs reads these.
//
//   node tools/build-ghost.mjs <folder with web-webm and pose> [size]
//
// Needs ffmpeg with libvpx, which is what decodes the alpha. Packs go in
// assets/ghost and are committed, so a normal build doesn't need ffmpeg.
//
// A pack: "JGHO", then int32 width, height, frame count, then for each frame
// int32 JPEG length, int32 PNG length, and the two files. Little-endian.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [source, sizeArgument] = process.argv.slice(2);
if (!source) throw new Error('Usage: node tools/build-ghost.mjs <folder with web-webm and pose> [size]');
const size = Number(sizeArgument ?? 320), quality = 4;
const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'ghost');
mkdirSync(out, { recursive: true });
const ffmpeg = (...args) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args], { stdio: ['ignore', 'ignore', 'inherit'] });
const int32 = value => { const b = Buffer.alloc(4); b.writeInt32LE(value); return b; };

let total = 0, frames = 0;
for (const name of readdirSync(join(source, 'web-webm')).filter(f => f.endsWith('.webm')).sort()) {
  const clip = basename(name, '.webm'), input = join(source, 'web-webm', name);
  const work = mkdtempSync(join(tmpdir(), 'josi-ghost-'));
  try {
    const scale = `scale=${size}:${size}:flags=lanczos,format=yuva444p`;
    ffmpeg('-c:v', 'libvpx-vp9', '-i', input, '-vf', `${scale},premultiply=inplace=1,format=yuvj444p`, '-q:v', String(quality), join(work, 'c%04d.jpg'));
    ffmpeg('-c:v', 'libvpx-vp9', '-i', input, '-vf', `${scale},alphaextract,format=gray`, join(work, 'a%04d.png'));
    const colours = readdirSync(work).filter(f => f.startsWith('c')).sort();
    const parts = [Buffer.from('JGHO'), int32(size), int32(size), int32(colours.length)];
    for (const colour of colours) {
      const jpeg = readFileSync(join(work, colour)), png = readFileSync(join(work, colour.replace('c', 'a').replace('.jpg', '.png')));
      parts.push(int32(jpeg.length), int32(png.length), jpeg, png);
    }
    const pack = Buffer.concat(parts);
    writeFileSync(join(out, `${clip}.ghost`), pack);
    total += pack.length; frames += colours.length;
    console.log(`${clip}: ${colours.length} frames, ${(pack.length / 1048576).toFixed(2)} MB`);
  } finally { rmSync(work, { recursive: true, force: true }); }
}
ffmpeg('-i', join(source, 'pose', 'arms-open.png'), '-vf', `scale=${size}:${size}:flags=lanczos`, join(out, 'still.png'));
console.log(`total: ${frames} frames, ${(total / 1048576).toFixed(1)} MB`);
