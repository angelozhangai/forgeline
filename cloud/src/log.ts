// Structured logs: one JSON object per line, which Workers Logs indexes field by field (`observability` in
// wrangler.jsonc). An `event` name plus flat fields, never a sentence with values spliced in -- a query for
// "every ws.refuse for this device" has to be a filter, not a regex.
//
// What never goes in a log line: frame bodies, reply text, prompts, summaries, keys, tokens. Logs are kept by
// Cloudflare outside D1's retention and outside the owner's control, and threat 11 in docs/cloud-agent.md is
// exactly "content leaks through storage". Ids, kinds, codes and counts are fine.

export type Level = 'debug' | 'info' | 'warn' | 'error';

export function log(level: Level, event: string, fields: Record<string, unknown> = {}): void {
  // `level` and `event` are written last so a field can never overwrite them.
  const line = JSON.stringify({ ...fields, level, event });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

// An Error rendered as fields. Only the message and name: a stack is noise in a one-line log, and an error
// message from D1 or the runtime does not carry user content.
export function errorFields(err: unknown): Record<string, string> {
  if (err instanceof Error) return { error: err.message, error_name: err.name };
  return { error: String(err) };
}
