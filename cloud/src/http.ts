// JSON responses. Every body is a small object with a machine-readable `error` code and, where it helps, an
// English `message` -- never a stack trace or an internal detail (T1 in docs/cloud-agent.md can call every route).
export function json(status: number, body: Record<string, unknown>, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}
