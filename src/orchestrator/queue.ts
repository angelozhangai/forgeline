// A bounded-concurrency executor (it caps how many claude/codex processes run at once).
export async function runLimited<T>(
  items: T[],
  limit: number,
  fn: (t: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  const n = Math.max(1, limit);
  let idx = 0;
  async function worker(): Promise<void> {
    while (idx < items.length) {
      const i = idx++;
      await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
}
