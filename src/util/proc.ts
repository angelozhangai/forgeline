import { spawn, spawnSync } from 'node:child_process';

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface RunOpts {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  timeoutMs?: number;
  onStdoutLine?: (line: string) => void; // called back with each complete line of stdout (used for live stream-json progress)
}

export function run(bin: string, args: string[], opts: RunOpts = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd: opts.cwd, env: opts.env ?? process.env });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let lineBuf = '';
    const onLine = opts.onStdoutLine;
    const to = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill('SIGKILL');
        }, opts.timeoutMs)
      : null;
    child.stdout.on('data', (d) => {
      const s = d.toString();
      stdout += s;
      if (onLine) {
        lineBuf += s;
        let nl = lineBuf.indexOf('\n');
        while (nl >= 0) {
          const line = lineBuf.slice(0, nl);
          lineBuf = lineBuf.slice(nl + 1);
          if (line.trim()) onLine(line);
          nl = lineBuf.indexOf('\n');
        }
      }
    });
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', (e) => {
      if (to) clearTimeout(to);
      resolve({ code: null, stdout, stderr: stderr + String(e), timedOut });
    });
    child.on('close', (code) => {
      if (to) clearTimeout(to);
      if (onLine && lineBuf.trim()) onLine(lineBuf); // flush a final line that had no trailing newline
      resolve({ code, stdout, stderr, timedOut });
    });
    if (opts.input != null) {
      child.stdin.write(opts.input);
      child.stdin.end();
    } else {
      child.stdin.end();
    }
  });
}

// A small synchronous command (git fetch, git show and the like): returns stdout, throws on failure.
export function runSync(bin: string, args: string[], cwd?: string): string {
  const r = spawnSync(bin, args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    throw new Error(`${bin} ${args.join(' ')} exited ${r.status}: ${(r.stderr || '').slice(0, 500)}`);
  }
  return r.stdout;
}

export function commandExists(bin: string): boolean {
  const r = spawnSync(bin, ['--version'], { stdio: 'ignore' });
  return !r.error; // ENOENT → error set
}
