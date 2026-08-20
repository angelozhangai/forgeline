// 读取宠物动图的 image_key 缓存（assets/pet/keys.json，由 tools/upload-pet-assets.ts 生成）。
// 进程内读一次；文件不存在（没上传过）→ 返回 null，卡片优雅回退到 emoji，不报错。
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const KEYS_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../../assets/pet/keys.json');

let cache: Record<string, string> | null = null;
function load(): Record<string, string> {
  if (cache) return cache;
  try {
    cache = existsSync(KEYS_PATH) ? (JSON.parse(readFileSync(KEYS_PATH, 'utf8')) as Record<string, string>) : {};
  } catch {
    cache = {};
  }
  return cache;
}

// 资源名(egg/hatch/chick/bird/final) → image_key；没有则 null。
export function petImageKey(name: string): string | null {
  return load()[name] ?? null;
}
