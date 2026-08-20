// 每人「当前在研负载」：自动指派的输入。⚠️ 负载口径镜像主仓 tools/weekly-load.sh（规模×跨栈），
// 改口径先改主仓真源再同步这里——保持「需求 × 规模(S1/M3/L8/XL20) × 跨栈(1/1.3/1.5)」一致。
// 与 weekly-load 的区别：这里只算「当前在研」（rollup 状态 ∈ in_progress_statuses），不含已上线，
// 也不乘质量因子——衡量的是「手上正推进的活」这一容量，不是回顾性产出。
import { run } from './proc.ts';
import { normSize, sizePoints, type Size } from './sizing.ts';
import { resolveLogin, type Config } from '../config.ts';

// 仓 slug → 字母（C/U/A/E 计入跨栈，对齐主仓 new-req.sh 短码；example-project=P 是 Epic 本体不算代码仓）。
// 默认项目（demo）的硬编码口径，作为 scoreLoad 的**缺省** repoCode：直调 scoreLoad（无项目上下文的纯函数测试）仍用它。
// 生产路径（probeLoad）按目标项目 repoMap+umbrella 反推 repoCode 注入 → 非 demo 项目也能算对字母（见 buildRepoCode）。
const REPO_CODE: Record<string, string> = {
  demo: 'C',
  'example-web': 'U',
  'example-admin': 'A',
  'example-engine': 'E',
  'example-project': 'P',
};

// 由目标项目仓身份反推「GitHub slug → 字母」：字母(C/U/A/E)→本地 key(repoMap)→slug(repoSlugs)，伞仓→P。
// 伞仓只在「不与代码仓 slug 撞」时才标 P（monorepo 下伞仓即代码仓 → 保留其代码字母，不被 P 抹掉）。
// demo 反推结果与上面 REPO_CODE 逐键相等（行为不变）；非 demo 项目据自身配置得对的字母。
export function buildRepoCode(repoMap: Record<string, string>, umbrella: string, repoSlugs: Record<string, string>): Record<string, string> {
  const slug = (key: string): string => repoSlugs[key] ?? key;
  const out: Record<string, string> = {};
  for (const [letter, localKey] of Object.entries(repoMap)) out[slug(localKey)] = letter;
  const umbSlug = slug(umbrella);
  if (!(umbSlug in out)) out[umbSlug] = 'P'; // 伞仓(非代码仓) → Epic 本体标记，不计跨栈
  return out;
}

// 跨栈倍率：单仓×1.0 / 两仓×1.3 / 三仓×1.5（协调/契约成本，同 weekly-load）。
export function crossStack(span: number): number {
  return span >= 3 ? 1.5 : span === 2 ? 1.3 : 1.0;
}

const SIZE_RANK: Record<Size, number> = { S: 1, M: 2, L: 3, XL: 4 };

export interface LoadIssue {
  repo: string; // 仓 dir 名（demo / example-web / example-admin / example-project）
  number: number;
  labels: string[]; // GitHub label 名（status:* / epic:* / size:*）
}

export interface LoadItem {
  key: string; // epic:<slug>（跨仓需求收成一条）或 <C|U|A>#<n>（单仓）
  size: Size; // 子 issue 最高档（无→缺省 M）
  span: number; // 跨代码仓数（≥1）
  status: number; // rollup（最小/最不成熟 status 序；0=无）
  points: number; // sizePoints × crossStack
}

export interface PersonLoad {
  wip: number; // 在研需求条数
  loadPoints: number; // 在研加权点数
  items: LoadItem[];
}

function parseLabel(labels: string[], prefix: string): string | null {
  const hit = labels.find((l) => l.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
}
// status 标签形如 "4-开发中" → 4；无/坏 → 0。
function statusOrd(labels: string[]): number {
  const st = parseLabel(labels, 'status:');
  if (!st) return 0;
  const n = Number(st.split('-')[0]);
  return Number.isFinite(n) ? n : 0;
}

// 纯函数：把某人名下 issue 聚合成需求并算在研负载。便于单测（喂 label 数组即可）。
// repoCode：仓 slug → 字母（缺省回退默认项目 REPO_CODE）；生产由 probeLoad 按项目反推注入。
export function scoreLoad(issues: LoadIssue[], opts: { inProgressStatuses: number[]; repoCode?: Record<string, string> }): PersonLoad {
  const repoCode = opts.repoCode ?? REPO_CODE;
  interface Agg {
    repos: Set<string>;
    size: Size | null;
    codeStatus: number; // 代码子仓(C/U/A) rollup = min(子状态)；DRI 恒在每个子，故这些会出现在本人探测里
    otherStatus: number; // P Epic 本体/未知仓的 status（仅纯 P 需求兜底用）
  }
  const aggs = new Map<string, Agg>();
  for (const iss of issues) {
    const epic = parseLabel(iss.labels, 'epic:');
    const code = repoCode[iss.repo] ?? '?';
    // epic:<slug> 把跨仓子 issue 收成 1 条需求（绝不重复计数）；单仓 issue 各算 1 条。
    const key = epic ? `epic:${epic}` : `${code}#${iss.number}`;
    let a = aggs.get(key);
    if (!a) {
      a = { repos: new Set(), size: null, codeStatus: 0, otherStatus: 0 };
      aggs.set(key, a);
    }
    const isCode = code !== 'P' && code !== '?';
    if (isCode) a.repos.add(code);
    const sz = normSize(parseLabel(iss.labels, 'size:') ?? '');
    if (sz && (!a.size || SIZE_RANK[sz] > SIZE_RANK[a.size])) a.size = sz; // 取最高档
    const ord = statusOrd(iss.labels);
    if (ord > 0) {
      // rollup = 最落后(最小)子。分流：代码子仓单独算 codeStatus，P Epic 本体只入 otherStatus。
      if (isCode) {
        if (a.codeStatus === 0 || ord < a.codeStatus) a.codeStatus = ord;
      } else if (a.otherStatus === 0 || ord < a.otherStatus) a.otherStatus = ord;
    }
  }
  const inProg = new Set(opts.inProgressStatuses);
  const items: LoadItem[] = [];
  for (const [key, a] of aggs) {
    // 有代码子仓 → 按子仓 rollup 判在研（P Epic 的 rollup 标签常滞后于 start-issue，绝不用它把活跃跨仓需求误判成空闲）；
    // 纯 P 需求（暂无代码子）→ 用 P 自身状态。
    const status = a.codeStatus > 0 ? a.codeStatus : a.otherStatus;
    if (!inProg.has(status)) continue; // 只算「当前在研」（含无 status 的被排除）
    const span = Math.max(1, a.repos.size); // 仅挂 Epic(P)→span 1
    const size = a.size ?? 'M'; // 无 size 缺省 M（同 weekly-load）
    const points = sizePoints(size) * crossStack(span);
    items.push({ key, size, span, status, points });
  }
  const loadPoints = items.reduce((s, i) => s + i.points, 0);
  return { wip: items.length, loadPoints, items };
}

export interface PersonLoadResult extends PersonLoad {
  code: string; // 短码
  login: string | null;
  ok: boolean; // gh 探测是否成功（失败 → 该人负载未知，算法据此知情；绝不静默当 0）
}

// 拉某人名下各仓 open issue（薄 IO）。失败的仓记 ok=false，不静默丢。
async function fetchPersonIssues(
  login: string,
  repos: string[],
  owner: string,
): Promise<{ ok: boolean; issues: LoadIssue[] }> {
  const issues: LoadIssue[] = [];
  let ok = true;
  for (const repo of repos) {
    const r = await run(
      'gh',
      ['issue', 'list', '-R', `${owner}/${repo}`, '--state', 'open', '--search', `assignee:${login}`, '--limit', '100', '--json', 'number,labels'],
      { timeoutMs: 60000 },
    );
    if (r.code !== 0 || r.timedOut) {
      ok = false;
      continue;
    }
    try {
      const arr = JSON.parse(r.stdout || '[]') as { number?: number; labels?: { name?: string }[] }[];
      for (const a of arr) {
        if (typeof a.number !== 'number') continue;
        issues.push({ repo, number: a.number, labels: (a.labels ?? []).map((l) => l.name ?? '').filter(Boolean) });
      }
    } catch {
      ok = false;
    }
  }
  return { ok, issues };
}

// 探测整个人选池的当前在研负载（每人每仓一发 gh，与 weekly-load 同量级）。
// proj 由调用方按 session 的项目传（projectForSession(s)）——扫哪些仓、跨栈字母口径都不再写死 demo。
// 结构化子集（非 import ProjectFull）：避免 load.ts 运行时依赖 projects.ts（防 mock.module 导入期脆裂）。
export interface ProbeRepoIdentity {
  owner: string; // 该项目 GitHub org
  repos: string[]; // 本地 repo key/path（monorepo 为 '.'）
  umbrella: string; // 本地伞仓 key
  repoSlugs: Record<string, string>; // 本地 key → GitHub slug（monorepo '.' → your-monorepo）
  repoMap: Record<string, string>; // 字母(C/U/A/E) → 本地 key；反推跨栈字母口径用
}
export async function probeLoad(cfg: Config, proj: ProbeRepoIdentity): Promise<PersonLoadResult[]> {
  const { owner, repos: projRepos, umbrella, repoSlugs, repoMap } = proj;
  // 本地 repo key/path → GitHub slug（monorepo '.' → your-monorepo），再拼 gh -R owner/<slug>——绝不把本地路径 '.' 当仓名。
  const slug = (key: string): string => repoSlugs[key] ?? key;
  const keys = umbrella && !projRepos.includes(umbrella) ? [...projRepos, umbrella] : [...projRepos];
  const repos = keys.map(slug);
  // 跨栈字母口径按本项目反推（slug→字母）：demo 得 C/U/A/E/P（同 REPO_CODE），非 demo 据自身 repoMap。
  const repoCode = buildRepoCode(repoMap, umbrella, repoSlugs);
  const out: PersonLoadResult[] = [];
  for (const code of cfg.assignment.pool) {
    const login = resolveLogin(cfg, code);
    if (!login) {
      out.push({ code, login: null, ok: false, wip: 0, loadPoints: 0, items: [] });
      continue;
    }
    const { ok, issues } = await fetchPersonIssues(login, repos, owner);
    const load = scoreLoad(issues, { inProgressStatuses: cfg.assignment.in_progress_statuses, repoCode });
    out.push({ code, login, ok, ...load });
  }
  return out;
}
