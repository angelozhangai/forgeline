// A one-off upload of assets/pet/*.gif to the IM provider, caching stage -> image_key into
// assets/pet/keys.json.
//   Run: node tools/upload-pet-assets.ts
// Rendering a card only reads keys.json and never re-uploads. Re-run this script after new artwork or a new
// app.
import { readdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { uploadImage } from '../src/feishu/upload.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = resolve(ROOT, 'assets/pet');
const KEYS = resolve(DIR, 'keys.json');

const gifs = readdirSync(DIR).filter((f) => f.endsWith('.gif'));
if (gifs.length === 0) {
  console.error('no gifs found -- run node tools/gen-pet-sprites.ts first');
  process.exit(1);
}

const out: Record<string, string> = existsSync(KEYS) ? JSON.parse(readFileSync(KEYS, 'utf8')) : {};
let ok = 0;
for (const f of gifs) {
  const name = basename(f, '.gif');
  const key = await uploadImage(resolve(DIR, f));
  if (key) {
    out[name] = key;
    ok++;
    console.log(`✓ ${name} → ${key}`);
  } else {
    console.log(`✗ ${name} failed to upload (see the warning above)`);
  }
}
if (ok > 0) {
  writeFileSync(KEYS, JSON.stringify(out, null, 2) + '\n');
  console.log(`\nwrote ${ok}/${gifs.length} image keys to ${KEYS}`);
} else {
  console.error('\nevery upload failed: most likely the bot lacks the image upload permission (im:resource). Grant it in the developer console, publish the change, and run this script again.');
  process.exit(2);
}
