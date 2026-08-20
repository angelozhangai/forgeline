// 上传本地图片到飞书 → 拿 image_key（供卡片 img 组件引用）。一次性（每张只传一次，key 缓存到 keys.json）。
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { botTenantToken, FEISHU_BASE } from './dm.ts';
import { log } from '../util/log.ts';

// image_type=message：用于消息/卡片里展示的图片。返回 image_key（失败返回 null）。
export async function uploadImage(filePath: string): Promise<string | null> {
  const token = await botTenantToken();
  if (!token) {
    log.warn('上传图片：缺 bot token');
    return null;
  }
  try {
    const buf = readFileSync(filePath);
    const form = new FormData();
    form.append('image_type', 'message');
    form.append('image', new Blob([buf]), basename(filePath));
    const res = await fetch(`${FEISHU_BASE}/im/v1/images`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` }, // 不手动设 Content-Type，让 fetch 带 multipart boundary
      body: form,
    });
    const j = (await res.json()) as { code?: number; msg?: string; data?: { image_key?: string } };
    if (j.code !== 0 || !j.data?.image_key) {
      log.warn(`上传图片失败：${j.code} ${(j.msg ?? '').slice(0, 160)}（多半缺权限 im:resource「上传图片」）`);
      return null;
    }
    return j.data.image_key;
  } catch (e) {
    log.warn(`上传图片异常：${String(e).slice(0, 160)}`);
    return null;
  }
}
