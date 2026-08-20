export function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

export function shortId(): string {
  return (
    Date.now().toString(36) +
    Math.floor(Math.random() * 46656).toString(36).padStart(3, '0')
  );
}

// 标题多为中文 → slugify 可能为空，回退到 req-<shortid>。--slug 显式覆盖优先。
export function deriveSlug(title: string, override?: string): string {
  if (override?.trim()) return slugify(override) || override.trim();
  return slugify(title) || `req-${shortId()}`;
}
