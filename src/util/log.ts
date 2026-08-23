// Logs go to stderr and command results to stdout (so they can be piped and parsed).
// FORGE_LOG_JSON=1 -> structured JSON lines ({t,lvl,msg}), for a long-running daemon feeding log collection
// and search; the default stays human-readable text (no change at all).

const JSON_MODE = process.env.FORGE_LOG_JSON === '1';

function w(lvl: 'info' | 'warn' | 'error', prefix: string, msg: string): void {
  if (JSON_MODE) {
    process.stderr.write(`${JSON.stringify({ t: new Date().toISOString(), lvl, msg })}\n`);
  } else {
    process.stderr.write(`[forge] ${prefix}${msg}\n`);
  }
}

export const log = {
  info: (m: string) => w('info', '', m),
  ok: (m: string) => w('info', '✓ ', m),
  warn: (m: string) => w('warn', '⚠ ', m),
  err: (m: string) => w('error', '✗ ', m),
};

// A command's user-facing output goes to stdout
export function out(m: string): void {
  process.stdout.write(`${m}\n`);
}
