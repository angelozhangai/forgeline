// Upload a local image to Feishu and get an image_key (referenced by a card's img element). One-off:
// each image is uploaded once and its key is cached in keys.json.
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { botTenantToken, FEISHU_BASE } from './dm.ts';
import { log } from '../util/log.ts';

// image_type=message: an image displayed inside a message or card. Returns the image_key (null on
// failure).
export async function uploadImage(filePath: string): Promise<string | null> {
  const token = await botTenantToken();
  if (!token) {
    log.warn('Image upload: no bot token');
    return null;
  }
  try {
    const buf = readFileSync(filePath);
    const form = new FormData();
    form.append('image_type', 'message');
    form.append('image', new Blob([buf]), basename(filePath));
    const res = await fetch(`${FEISHU_BASE}/im/v1/images`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` }, // do not set Content-Type by hand; let fetch add the multipart boundary
      body: form,
    });
    const j = (await res.json()) as { code?: number; msg?: string; data?: { image_key?: string } };
    if (j.code !== 0 || !j.data?.image_key) {
      log.warn(`Image upload failed: ${j.code} ${(j.msg ?? '').slice(0, 160)} (most likely the im:resource "upload image" permission is missing)`);
      return null;
    }
    return j.data.image_key;
  } catch (e) {
    log.warn(`Image upload threw: ${String(e).slice(0, 160)}`);
    return null;
  }
}
