// 日志走 stderr，命令结果走 stdout（便于管道/解析）。
// FORGE_LOG_JSON=1 → 结构化 JSON 行（长驻 daemon 接日志采集/查询用：{t,lvl,msg}）；缺省人读文本（零变化）。

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

// 命令面向用户的输出走 stdout
export function out(m: string): void {
  process.stdout.write(`${m}\n`);
}
