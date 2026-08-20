// 一次性把 assets/pet/*.gif 传到飞书，把 stage→image_key 缓存到 assets/pet/keys.json。
//   跑：node tools/upload-pet-assets.ts
// 卡片渲染时只读 keys.json，绝不每次都传。换美术/换 app 后重跑本脚本即可。
import { readdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { uploadImage } from '../src/feishu/upload.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = resolve(ROOT, 'assets/pet');
const KEYS = resolve(DIR, 'keys.json');

const gifs = readdirSync(DIR).filter((f) => f.endsWith('.gif'));
if (gifs.length === 0) {
  console.error('没有 gif，先跑 node tools/gen-pet-sprites.ts');
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
    console.log(`✗ ${name} 上传失败（见上方告警）`);
  }
}
if (ok > 0) {
  writeFileSync(KEYS, JSON.stringify(out, null, 2) + '\n');
  console.log(`\n已写 ${ok}/${gifs.length} 个 image_key → ${KEYS}`);
} else {
  console.error('\n全部失败：多半 bot 缺「上传图片」权限(im:resource)。去开发者后台加上、发版后重跑本脚本。');
  process.exit(2);
}
