import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { SVC_DIR, SCRIPTS_DIR, ENV_FILE } from './root.ts';
import { loadConfig } from './config.ts';
import { project, defaultProjectId } from './projects.ts';
import { parseHumanAsks } from './gates/envelopes.ts';
import { commandExists, runSync } from './util/proc.ts';
import { out, log } from './util/log.ts';
import { store as sessions } from './store/index.ts'; // 经 SessionStore 接缝（选择点），不直连 store/sessions.ts
import { db } from './store/db.ts';
import { addPrd, addImplementTask } from './intake.ts';
import { tick } from './orchestrator/worker.ts';
import { listen } from './daemon/listen.ts';
import { confirm, submitPmAnswers, requestGateB, submitGateBAnswers, forceGateBGo, go, deny, retry, setSize, assign, postConfirmComment, requestGateC, submitGateCAnswers, requestReviewPr, submitGateDAnswers, ackMerged } from './actions.ts';
import { scoreBadge, scoreBand } from './util/scoring.ts';
import { routingOf, parseDims } from './store/readModel.ts';
import { costRows, costSummary, formatCost } from './cost.ts';
import { days } from './util/time.ts';
import { evaluateHealth } from './health/check.ts';
import { healthConfig } from './health/config.ts';
import { runWatchdog } from './health/watchdog.ts';
import { runContractCheckCli } from './health/contract.ts';
import { allProbes } from './store/contract.ts';
import { initHeartbeat, pingLiveness } from './health/heartbeat.ts';
import { startHealthServer } from './health/server.ts';
import { startControlServer } from './control/server.ts';
import { ACTIVE_GATE_STATES } from './statemachine/states.ts';

type Flags = Record<string, string | boolean>;

function parseArgs(argv: string[]): { pos: string[]; flags: Flags } {
  const pos: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) flags[key] = true;
      else {
        flags[key] = next;
        i++;
      }
    } else pos.push(a);
  }
  return { pos, flags };
}

const str = (v: string | boolean | undefined): string | undefined =>
  typeof v === 'string' ? v : undefined;

function userOf(flags: Flags): string {
  return str(flags.user) ?? 'M';
}

function help(): void {
  out(`forge — Forge · PRD 评审/技术方案自动化服务

用法：./forge <命令> [参数]

  doctor                              环境自检（主仓/三仓/claude/codex/gh/配置/DB）·静态
  health  [--json]                    运行时活检（守护心跳/长连接/DB/备份/依赖/磁盘）+ 状态页地址
  status-page                         独立预览状态页（只起健康服务，不跑 tick/不连飞书/不花钱；Ctrl-C 退出）
  watchdog                            看门狗一次性探活+自愈+告警（launchd StartInterval 调，人工很少手敲）
  contract-check                      主动探外部 CLI/API 输出契约（codex/claude 各一发付费 trivial + gh/飞书免费）→ 落库+漂移告警
  add --prd <飞书链接> [--slug s]      登记一个 PRD（读文档建 session）
      [--title t] [--branch prod|dev] [--chat <chatId>] [--project <id>]
  tick                                推进所有 ready session（闸A / 闸B+对抗）
  listen                              常驻守护：飞书长连接(卡片按钮+群消息入口) + 周期 tick
  control [--port N] [--host H]        控制面 HTTP server（只 /jobs+/store，不跑编排）；要编排+服务一体用 listen 配 FORGE_CONTROL_PORT（FORGE_CONTROL_* 配端口/鉴权；非回环须 token）
  list | board  [--project <id>]      列出所有 session 及状态（--project 按项目过滤）
  show <id|slug>                      查看某 session 详情 + 事件链
  answer  <id|slug> [--notes ".."] [--user W]  PM 答复开放问题 → 进下一轮复评（下次 tick 跑；群里走卡片更省事）
  confirm <id|slug> --user W [--notes ".."]   M 强制结束评审 → CONFIRMED（PM 只在群卡答复，多轮复评由 claude/M 终止）
  size    <id|slug> <S|M|L|XL> [--reason ".."]  评审人定/调复杂度档（建需求时打 size:* 标签）
  workload [--since D] [--until D] [人...]   人均加权负载（私有·管理面，规模×跨栈×质量）
  scores  [--sort score] [--min N] [--project <id>]  PRD 质量评分一览（私有·管理面，AI 闸A 打分，不对外）
  cost    [--since N] [--project <id>]  成本看板（私有·管理面，claude 改方 $ 聚合，--since N 只看近 N 天，--project 按项目）
  gateb   <id|slug> --user W           触发闸B（需 gate_b_allowed 权限）
  gateb-answer <id|slug> [--notes ".."] [--user W]  M 答复闸B 改方的升级问题 → 续修（下次 tick 跑；群里走卡片更省事）
  gateb-go <id|slug> --user W          闸B 停泊裁决时强制立项（需 go_approvers 权限）
  assign  <id|slug> [<M|EO|CC|DE>] --user W [--auto]  指派 DRI：给短码=手动；无/--auto=按负载+WIP 自动推荐
  go      <id|slug> --user W [--dry-run] [--assignee <短码>]  一键建需求（需 go_approvers 权限）
  deny    <id|slug> --user W [--reason ".."]  拒绝 GO
  retry   <id|slug> --user W           重置失败的 session 重跑（按失败闸鉴权：B→gate_b_allowed/C→gate_c_allowed/D→pr_create_approvers/其它→go_approvers）
  eval    [--fixture <名>] [--runs N] [--no-save]  golden 离线评测：fixtures/eval 的 PRD 真跑闸A→对照期望报回归 + 落盘 + 与上次趋势对比（⚠️ 调真 claude·花钱·手动跑，不在 ci；--runs N 多样本看抖动）

  ── 下游（闸C 实现 + 闸D PR 对抗 review）──
  implement <slug> --user W                       链式：DONE 后触发闸C（隔离 worktree 实现 + 本地 CI 至绿）
  implement --issue <repo#n|url> --title t [...]   standalone：裸 issue 直起闸C（--project/--repo/--branch 可选）
  gatec-answer <id|slug> [--notes ".."] [--user W]  M 答复闸C 实现的升级问题 / 裁决停泊 → 续做
  review-pr <id|slug> --user W                     闸C 绿后触发开 PR（委托脚本·绝不自动 merge）+ 闸D codex 审 diff⇄claude 修（需 pr_create_approvers）
  gated-answer <id|slug> [--notes ".."] [--user W]  M 答复闸D PR 复审的升级问题 / 裁决停泊 → 续修
  merged <id|slug> --user W [--force]              人工合并 PR 后确认 → SHIPPED（先 gh 核验真合并，再清隔离 worktree + 接漂移；需 merge_ack_allowed。--force 越过核验）

阶段：INTAKE→(闸A首轮)→AWAITING_PM_CONFIRM⇄(PM答复→复评·resume)→CONFIRMED→(gateb)→ADVERSARIAL_LOOP⇄(codex审⇄claude改·resume)→AWAITING_GO→(go)→DONE
      闸A 多轮：PM 每轮答复回喂同一会话复评，直到 claude 判定无剩余开放问题（或 M confirm 强制结束）；到 max_pm_rounds 仍未决→GATE_A_STALLED 待 M 裁决
      闸B 多轮：Codex 审、Claude 改技术方案各自 resume 续接；改方遇拿不准的点→AWAITING_GATE_B_INPUT 待 M 答复(gateb-answer)；到上限仍未决→GATE_B_STALLED 待 M 裁决(gateb-go 强制立项/gateb-answer 再修)
      下游：DONE→(implement)→闸C 实现⇄本地CI 至绿→AWAITING_GATE_D→(review-pr)→开 PR→闸D codex审diff⇄claude修(CI 须绿才推)→GATE_D_HARDENING(补内环测试+CI绿+出 merge-readiness)→AWAITING_HUMAN_MERGE(人工合并·永不自动)→(merged)→SHIPPED→漂移对账
      闸C/D 多轮：升级→AWAITING_GATE_C/D_INPUT 待 M 答复(gatec/gated-answer)；到上限→GATE_C/D_STALLED 待裁决（闸C stall=CI 未绿，只能再修，绝不放行）`);
}

function doctor(): void {
  let bad = 0;
  const ck = (label: string, ok: boolean, note = ''): void => {
    out(`${ok ? '✓' : '✗'} ${label}${note ? `  — ${note}` : ''}`);
    if (!ok) bad++;
  };
  out('── Forge doctor ──');
  const cfg = (() => {
    try {
      return loadConfig();
    } catch (e) {
      ck('加载配置', false, String(e).slice(0, 120));
      return null;
    }
  })();
  if (cfg) ck('加载配置 yaml', true);

  // 逐个注册项目自检：布局 + 该项目的代码真源子仓（闸A 对照）。无注册表 → 仅默认项目。
  const reg = cfg?.projects;
  const defId = defaultProjectId();
  const ids = reg ? Object.keys(reg.projects) : [defId];
  const multi = ids.length > 1;
  for (const id of ids) {
    const p = project(id);
    const tag = multi ? `[${id}${id === defId ? '·默认' : ''}] ` : '';
    out(`${tag}ROOT = ${p.root}`);
    ck(`${tag}项目布局（CLAUDE.md + scripts）`, p.looksValid());
    for (const repo of p.repos) {
      const gitdir = resolve(p.repoPath(repo), '.git');
      const ok = existsSync(gitdir);
      let sha = '';
      if (ok) {
        try {
          sha = runSync('git', ['-C', p.repoPath(repo), 'rev-parse', '--short', 'HEAD']).trim();
        } catch {
          /* ignore */
        }
      }
      ck(`${tag}子仓 ${repo}`, ok, ok ? `HEAD ${sha}` : '未 clone（跑项目 ./scripts/bootstrap.sh）');
    }
  }
  if (cfg) {
    ck('claude CLI', commandExists(cfg.runtime.claude_bin), commandExists(cfg.runtime.claude_bin) ? '已就位' : '缺失');
    const codexOk = commandExists(cfg.runtime.codex_bin);
    ck(`codex CLI（对抗复审 reviewer=${cfg.runtime.adversarial.reviewer}）`, codexOk, codexOk ? '已就位' : `缺失 → on_missing=${cfg.runtime.adversarial.on_missing}`);
  }
  const ghOk = commandExists('gh');
  let ghUser = '';
  if (ghOk) {
    try {
      ghUser = runSync('gh', ['api', 'user', '-q', '.login']).trim();
    } catch {
      /* ignore */
    }
  }
  ck('gh CLI 登录', ghOk && !!ghUser, ghUser ? `as ${ghUser}` : '未登录（写脚本需目标项目 GitHub org 写权限）');
  ck('feishu-doc.js', existsSync(resolve(SCRIPTS_DIR, 'feishu-doc.js')));
  ck('config/forge.env', existsSync(ENV_FILE), existsSync(ENV_FILE) ? '' : '缺（可选；从 .example 复制）');
  if (cfg) {
    const botOk = !!(cfg.env.FEISHU_BOT_APP_ID && cfg.env.FEISHU_BOT_APP_SECRET);
    const tgt = cfg.env.FEISHU_DM_OPEN_ID || cfg.env.FEISHU_DM_UNION_ID || cfg.env.FEISHU_DM_CHAT_ID || cfg.env.FEISHU_DM_EMAIL;
    ck('飞书 bot 私聊通知', botOk && !!tgt, botOk ? (tgt ? '已配' : '缺推送目标 FEISHU_DM_*') : '未配（降级桌面+日志）');
    const sdkOk = existsSync(resolve(SVC_DIR, 'node_modules/@larksuiteoapi/node-sdk'));
    ck('飞书长连接 SDK（forge listen 按钮/群入口）', sdkOk, sdkOk ? '已装（后台需开「事件订阅→长连接」见 deploy/README）' : 'npm install');
  }
  try {
    db();
    ck('SQLite 状态库', true);
    // 外部工具契约：只读上次探测态（不在 doctor 里触发探针——那花钱，走 `forge contract-check` / 每日定时）。
    try {
      const probes = allProbes();
      if (probes.length === 0) {
        ck('外部工具契约（上次探测）', true, '尚未探测（跑 ./forge contract-check）');
      } else {
        const drifted = probes.filter((p) => !p.ok);
        const ageMin = Math.max(0, Math.round((Date.now() - Math.max(...probes.map((p) => p.checkedAt))) / 60000));
        ck('外部工具契约（上次探测）', drifted.length === 0, drifted.length ? `漂移：${drifted.map((d) => d.dep).join('、')}（${ageMin} 分钟前）` : `${probes.map((p) => p.dep).join('/')} 正常（${ageMin} 分钟前）`);
      }
    } catch {
      /* 契约展示尽力而为 */
    }
  } catch (e) {
    ck('SQLite 状态库', false, String(e).slice(0, 120));
  }
  out(bad === 0 ? '\n全部就绪。' : `\n${bad} 项需处理。`);
  process.exitCode = bad === 0 ? 0 : 1;
}

// 独立预览状态页：只起健康服务 + 心跳/liveness，【不】跑 tick / 不连飞书 / 不花钱。
// 用于本机随手看页面；正式常驻看 ./forge listen 或 ./deploy/install.sh。
async function statusPage(): Promise<void> {
  const hcfg = healthConfig();
  initHeartbeat({ pid: process.pid, port: hcfg.port, wsConfigured: false, now: Date.now() });
  startHealthServer(hcfg.port);
  const ping = async (): Promise<void> => {
    try {
      pingLiveness(Date.now(), await sessions.countByStates([...ACTIVE_GATE_STATES]));
    } catch {
      /* ping 尽力而为 */
    }
  };
  await ping();
  setInterval(() => void ping(), hcfg.livenessPingSec * 1000);
  out(`状态页（独立预览，不跑 tick/飞书）：http://127.0.0.1:${hcfg.port}/　—— Ctrl-C 退出`);
  await new Promise(() => {}); // 常驻直到 Ctrl-C
}

// 控制面 server（control plane / runner 分离）：对外服务 /jobs（runner 拉 job）+ /store（读写中心状态）。
// 独立于本地状态页（health/server.ts）。鉴权/端口/绑定地址走 FORGE_CONTROL_* env（forge 包装器从 forge.env 导出）。
// ⚠️ 本命令**只起 HTTP 面、不跑编排 tick**（reclaim/retry/autonomy/remind/sweep/drift 在 worker.tick 里）。故
// 「控制面 + 纯 runner」要跑通编排，控制面那台须有人跑 tick——**推荐用 `forge listen` 并配 FORGE_CONTROL_PORT**：
// 一个 listen 进程 = 编排 + 自身 job + 服务额外 runner（见 daemon/listen.ts）。本独立命令用于只想要纯 HTTP 面、
// 编排另由同一 sqlite 上的 `forge listen` 提供的场景。常驻直到 Ctrl-C。
async function controlCmd(flags: Flags): Promise<void> {
  const port = Number(str(flags.port) ?? process.env.FORGE_CONTROL_PORT ?? '4320') || 4320;
  const host = str(flags.host) ?? process.env.FORGE_CONTROL_HOST ?? '127.0.0.1';
  const token = process.env.FORGE_CONTROL_TOKEN || undefined;
  // 非回环无 token / 设了 FORGE_CONTROL_URL → fail-closed 同步抛；绑定失败 → reject。两者都propagate 到 main().catch 退 1。
  await startControlServer({ port, host, token });
  out(`控制面 server 运行中：http://${host}:${port}/（/jobs /store /healthz）—— Ctrl-C 退出`);
  await new Promise(() => {}); // 常驻
}

// 运行时活检：守护是否活着、长连接/DB/备份/依赖/磁盘 + 本地状态页地址。与静态 doctor 互补。
async function healthCmd(flags: Flags): Promise<void> {
  const report = await evaluateHealth();
  if (flags.json) {
    out(JSON.stringify(report, null, 2));
    process.exitCode = report.status === 'down' ? 1 : 0;
    return;
  }
  const icon = (s: string): string => (s === 'healthy' ? '🟢' : s === 'degraded' ? '🟡' : s === 'down' ? '🔴' : '⚪');
  out('── Forge health ──');
  out(`${icon(report.status)} 总状态：${report.status}`);
  if (report.daemon.pid != null) {
    out(`守护 PID ${report.daemon.pid} · 运行 ${report.uptimeSec ?? '—'}s · 周期 ${report.daemon.cycleCount} · 活跃 gate ${report.daemon.activeGates}${report.daemon.wedged ? ' · ⚠️ 卡死' : ''}`);
  } else {
    out('守护未运行（无心跳）—— 用 ./forge listen 启动，或 launchctl 已托管');
  }
  out('');
  for (const c of report.checks) out(`${icon(c.status)} ${c.name}　${c.detail}`);
  out('');
  out(`看板：共 ${report.board.total} · 等人决策 ${report.board.awaiting} · 失败 ${report.board.failed}`);
  out(`状态页：http://127.0.0.1:${healthConfig().port}/`);
  process.exitCode = report.status === 'down' ? 1 : 0;
}

async function listCmd(flags: Flags): Promise<void> {
  const rows = await sessions.listAll(str(flags.project)); // --project <id>：按项目过滤（缺省全库）
  if (rows.length === 0) {
    out('（无 session）');
    return;
  }
  out('STATE                 SLUG                      ROUTING        ID');
  for (const s of rows) {
    const r = routingOf(s);
    const routing = r ? (r.toLead ? `→${r.reviewer}` : 'DRI') : '';
    out(
      `${s.state.padEnd(21)} ${s.slug.slice(0, 25).padEnd(25)} ${routing.padEnd(14)} ${s.id}`,
    );
  }
}

// PRD 质量评分一览（私有·管理面）：AI 闸A 评审打的分，工程师/对外都看不到。低分 = 这份 PRD 待打磨的信号。
// 默认按需求编号倒序（最新在上）；`--sort score` 改为分低在前（先盯差的）；`--min N` 只看 ≥N 分。
async function scoresCmd(flags: Flags): Promise<void> {
  const byScore = str(flags.sort) === 'score';
  const min = str(flags.min) !== undefined ? Number(str(flags.min)) : undefined;
  let rows = (await sessions.listAll(str(flags.project))).filter((s) => s.prd_score != null); // --project <id>：按项目过滤
  if (min !== undefined && !Number.isNaN(min)) rows = rows.filter((s) => (s.prd_score ?? 0) >= min);
  if (rows.length === 0) {
    out('（暂无 PRD 评分——闸A 评审过的需求才有）');
    return;
  }
  if (byScore) rows = rows.slice().sort((a, b) => (a.prd_score ?? 0) - (b.prd_score ?? 0));
  out('REQ       SCORE  档   清/完/行/测          SIZE  SLUG');
  for (const s of rows) {
    const score = s.prd_score ?? 0;
    const d = parseDims(s.prd_score_dims);
    const dims = d ? `${d.clarity}/${d.completeness}/${d.feasibility}/${d.testability}` : '-';
    const ref = s.ref_num != null ? `REQ-${s.ref_num}` : s.id.slice(0, 8);
    const flag = score < 55 ? ' ⚠' : '';
    out(
      `${ref.padEnd(9)} ${String(score).padStart(3)}    ${scoreBand(score).padEnd(2)}  ${dims.padEnd(18)}  ${(s.size ?? '-').padEnd(4)}  ${s.slug.slice(0, 24)}${flag}`,
    );
  }
  const avg = Math.round(rows.reduce((a, s) => a + (s.prd_score ?? 0), 0) / rows.length);
  out(`\n${rows.length} 条 · 均分 ${avg}（私有，仅本服务可见）`);
}

// 成本看板（私有·管理面）：每条需求 claude 改方 $ 聚合 + 按状态汇总 + 总计。
// `--since N` 只看近 N 天有更新的需求（按 updated_at）。⚠️ 不对外，与 scores/workload 同属管理面。
async function costCmd(flags: Flags): Promise<void> {
  let rows = await sessions.listAll(str(flags.project)); // --project <id>：按项目过滤（缺省全库）
  const since = str(flags.since) !== undefined ? Number(str(flags.since)) : undefined;
  if (since !== undefined && !Number.isNaN(since)) {
    const cutoff = Date.now() - days(since);
    rows = rows.filter((s) => s.updated_at >= cutoff);
  }
  const cr = costRows(rows);
  out(formatCost(cr, costSummary(cr)));
}

async function showCmd(idOrSlug: string): Promise<void> {
  const s = await sessions.resolve(idOrSlug);
  if (!s) {
    out(`找不到：${idOrSlug}`);
    process.exitCode = 1;
    return;
  }
  out(`# ${s.slug}  (${s.id})`);
  out(`state:   ${s.state}`);
  out(`title:   ${s.title}`);
  out(`branch:  ${s.branch}`);
  out(`prd:     ${s.prd_url ?? '-'}`);
  if (s.routing) out(`routing: ${s.routing}`);
  if (s.gate_a_round != null) {
    out(`闸A 评审: 第 ${s.gate_a_round} 轮${s.gate_a_session_id ? `  (会话 ${s.gate_a_session_id.slice(0, 8)}…，复评 resume 续接)` : ''}`);
  }
  if (s.gate_a_residual) {
    out('── 闸A 多轮到上限未消解开放问题（待 M 裁决）──');
    try {
      const r = JSON.parse(s.gate_a_residual) as { round: number; open_questions: { q: string; severity?: string; suggestion?: string }[] };
      out(`  到第 ${r.round} 轮仍有 ${r.open_questions.length} 条：`);
      r.open_questions.forEach((q, i) => {
        out(`  ${i + 1}. [${q.severity ?? 'med'}] ${q.q}`);
        if (q.suggestion) out(`      建议：${q.suggestion}`);
      });
      out(`  强制通过：./forge confirm ${s.slug} --user M`);
    } catch {
      out(`  ${s.gate_a_residual}`);
    }
  }
  if (s.gate_b_round != null && s.gate_b_round > 0) {
    const rev = s.gate_b_reviewer_session ? `codex ${s.gate_b_reviewer_session.slice(0, 8)}…` : '-';
    const fix = s.gate_b_fixer_session ? `claude ${s.gate_b_fixer_session.slice(0, 8)}…` : '-';
    out(`闸B 对抗: 第 ${s.gate_b_round} 轮（reviewer ${rev} / fixer ${fix}，均 resume 续接）`);
  }
  {
    // 经 schema 归一（兼容旧 string[] 选项）——与卡片/gateBLoop 同走 parseHumanAsks，绝不渲染 [object Object]。
    const asks = parseHumanAsks(s.gate_b_human_asks);
    if (asks.length) {
      out('── 闸B 改方升级·待 M 答复 ──');
      asks.forEach((a, i) => {
        const opts = a.options.map((o) => `${o.recommended ? '★' : ''}${o.label}`).join(' / ');
        out(`  ${i + 1}. [${a.severity}] ${a.question}${opts ? `（选项：${opts}）` : ''}`);
      });
      out(`  答复：./forge gateb-answer ${s.slug} --notes "…"`);
    }
  }
  if (s.prd_score != null) {
    out(`prd score: ${scoreBadge(s.prd_score, parseDims(s.prd_score_dims))}${s.prd_score_reason ? ` — ${s.prd_score_reason}` : ''}  (私有)`);
  }
  if (s.confirmed_by) out(`confirmed: ${s.confirmed_by} ${s.confirmed_notes ?? ''}`);
  if (s.created_issues) out(`issues:  ${s.created_issues}`);
  if (s.error) out(`error:   ${s.error}`);
  const cost = (s.gate_a_cost_usd ?? 0) + (s.gate_b_cost_usd ?? 0) + (s.gate_c_cost_usd ?? 0) + (s.gate_d_cost_usd ?? 0);
  if (cost) out(`cost:    $${cost.toFixed(4)}`);
  if (s.adversarial_residual) {
    out('── 对抗复审未裁决意见（GO 前须人工裁决）──');
    try {
      const r = JSON.parse(s.adversarial_residual) as {
        round: number;
        used: string;
        findings: { severity: string; issue: string; where?: string; fix?: string; evidence?: string }[];
      };
      out(`  到上限第 ${r.round} 轮（reviewer=${r.used}），${r.findings.length} 条未消解：`);
      r.findings.forEach((f, i) => {
        out(`  ${i + 1}. [${f.severity}] ${f.issue}${f.where ? ` @${f.where}` : ''}`);
        if (f.fix) out(`      建议：${f.fix}`);
        if (f.evidence) out(`      证据：${f.evidence}`);
      });
    } catch {
      out(`  ${s.adversarial_residual}`);
    }
  }
  out('── events ──');
  for (const e of await sessions.events(s.id)) {
    out(`  ${new Date(e.ts).toISOString()}  ${e.kind}  ${e.detail ?? ''}`);
  }
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  const { pos, flags } = parseArgs(rest);
  switch (cmd) {
    case 'doctor':
      doctor();
      break;
    case 'add': {
      const r = await addPrd({
        prdUrl: str(flags.prd) ?? pos[0] ?? '',
        slug: str(flags.slug),
        title: str(flags.title),
        projectId: str(flags.project), // 显式指定目标项目（缺省按 群→项目映射/默认 解析）
        branch: str(flags.branch) === 'prod' ? 'prod' : str(flags.branch) === 'dev' ? 'dev' : undefined,
        chatId: str(flags.chat),
      });
      out(r.msg);
      process.exitCode = r.ok ? 0 : 1;
      break;
    }
    case 'tick':
      await tick();
      break;
    case 'listen':
      await listen();
      break;
    case 'health':
      await healthCmd(flags);
      break;
    case 'status-page':
      await statusPage();
      break;
    case 'control':
      await controlCmd(flags);
      break;
    case 'watchdog': {
      const d = await runWatchdog();
      out(`watchdog: ${d.klass} · action=${d.action.kind}${d.livenessAgeSec != null ? ` · liveness ${d.livenessAgeSec}s 前` : ''}`);
      break;
    }
    case 'contract-check': {
      // 主动探测外部 CLI/API 输出契约（codex/claude 各一发付费 trivial；gh/飞书免费只读）→ 落库 + 漂移告警。
      const results = await runContractCheckCli(Date.now());
      const drifted = results.filter((r) => r.available && !r.ok);
      process.exitCode = drifted.length ? 1 : 0;
      break;
    }
    case 'eval': {
      // golden eval：用 fixtures/eval 的 PRD 真跑闸A提示词，对照期望比对产出形状 → 报回归。
      // ⚠️ 调真实 claude（**花钱**），故不在 npm run ci，只手动跑。--runs N 多样本看抖动；落盘 + 与上次对比趋势。
      const { runEval } = await import('./eval/runEval.ts');
      const { loadFixtures } = await import('./eval/expectations.ts');
      const { formatReport, diffRuns, formatTrend } = await import('./eval/aggregate.ts');
      const { saveEvalRun, loadLatestEvalRun } = await import('./eval/store.ts');
      const only = str(flags.fixture);
      const runs = Math.max(1, Number(str(flags.runs) ?? '1') || 1);
      const fxs = loadFixtures(undefined, only);
      const n = fxs.length;
      if (n === 0) {
        out(only ? `找不到 fixture：${only}` : '没有 fixtures（fixtures/eval/ 为空）');
        process.exitCode = 1;
        break;
      }
      const judgeN = fxs.filter((f) => f.expect.acceptance_judge).length; // 带 acceptance-judge 的闸B fixture 各多一发 claude
      const calls = (n + judgeN) * runs;
      out(`⚠️ forge eval 会真实调用 claude（**花钱**）：${n} 个 fixture${judgeN ? `（含 ${judgeN} 个带 acceptance-judge，各多一发）` : ''} × ${runs} 次 = ${calls} 发 claude，逐个真评审…\n`);
      const prev = loadLatestEvalRun(); // 落盘前先读上一次，作趋势基线
      const report = await runEval({ only, runs });
      out(formatReport(report));
      if (!flags['no-save']) {
        report.ranAt = new Date().toISOString().replace(/[:.]/g, '-');
        try {
          report.gitSha = runSync('git', ['rev-parse', '--short', 'HEAD']).trim() || null;
        } catch {
          report.gitSha = null;
        }
        out(`\n已落盘：${saveEvalRun(report, report.ranAt)}`);
      }
      if (prev) out(`\n${formatTrend(diffRuns(prev, report))}`);
      process.exitCode = report.allPass ? 0 : 1;
      break;
    }
    case 'list':
    case 'board':
      await listCmd(flags);
      break;
    case 'show':
      await showCmd(pos[0] ?? '');
      break;
    case 'answer': {
      const who = str(flags.user) ?? 'PM';
      const r = await submitPmAnswers(pos[0] ?? '', who, str(flags.notes));
      const s = await sessions.resolve(pos[0] ?? '');
      if (r.ok && s) await postConfirmComment(s, { who, notes: str(flags.notes) }); // PM 答复 → 文档留痕
      out(r.msg);
      if (r.ok) out(`下一步：./forge tick  跑本轮复评`);
      process.exitCode = r.ok ? 0 : 1;
      break;
    }
    case 'confirm': {
      const r = await confirm(pos[0] ?? '', userOf(flags), str(flags.notes));
      out(r.msg);
      process.exitCode = r.ok ? 0 : 1;
      break;
    }
    case 'size': {
      const r = await setSize(pos[0] ?? '', pos[1] ?? '', userOf(flags), str(flags.reason));
      out(r.msg);
      process.exitCode = r.ok ? 0 : 1;
      break;
    }
    case 'workload': {
      // 人均加权负载（私有·管理面）：规模×跨栈×质量。工具+调分留在私有 Forge，工程师看不到。
      const tool = resolve(SVC_DIR, 'tools/weekly-load.sh');
      const r = spawnSync('bash', [tool, ...rest], { stdio: 'inherit' });
      process.exitCode = r.status ?? 0;
      break;
    }
    case 'scores':
      // PRD 质量评分一览（私有·管理面）：AI 闸A 打分，工程师/对外都看不到。
      await scoresCmd(flags);
      break;
    case 'cost':
      // 成本看板（私有·管理面）：claude 改方 $ 聚合，不对外。
      await costCmd(flags);
      break;
    case 'gateb': {
      const r = await requestGateB(pos[0] ?? '', userOf(flags));
      out(r.msg);
      process.exitCode = r.ok ? 0 : 1;
      break;
    }
    case 'gateb-answer': {
      const r = await submitGateBAnswers(pos[0] ?? '', str(flags.user) ?? 'M', str(flags.notes));
      out(r.msg);
      if (r.ok) out(`下一步：./forge tick  跑本轮续修`);
      process.exitCode = r.ok ? 0 : 1;
      break;
    }
    case 'gateb-go': {
      const r = await forceGateBGo(pos[0] ?? '', userOf(flags));
      out(r.msg);
      if (r.ok) out(`下一步：./forge go ${pos[0] ?? ''} --user ${userOf(flags)}  建需求`);
      process.exitCode = r.ok ? 0 : 1;
      break;
    }
    case 'assign': {
      // 指派 DRI：给短码=手动；无短码或 --auto=按 least-loaded+WIP 算法推荐并采纳（打印各人负载理由）。
      const code = pos[1] && !pos[1].startsWith('--') ? pos[1] : undefined;
      const r = await assign(pos[0] ?? '', userOf(flags), { to: code, auto: !!flags.auto });
      out(r.msg);
      if (r.ok) out(`下一步：./forge go ${pos[0] ?? ''} --user ${userOf(flags)}  建需求（或卡片一键立项）`);
      process.exitCode = r.ok ? 0 : 1;
      break;
    }
    case 'go': {
      const r = await go(pos[0] ?? '', userOf(flags), { dryRun: !!flags['dry-run'], force: !!flags.force, assignee: str(flags.assignee) });
      out(r.msg);
      process.exitCode = r.ok ? 0 : 1;
      break;
    }
    case 'deny': {
      const r = await deny(pos[0] ?? '', userOf(flags), str(flags.reason));
      out(r.msg);
      process.exitCode = r.ok ? 0 : 1;
      break;
    }
    case 'implement': {
      // standalone 裸 issue：implement --issue <ref> --title "…" [--body "…"] [--project id] [--repo r] [--branch prod|dev]
      if (str(flags.issue)) {
        const r = await addImplementTask({
          issueRef: str(flags.issue) ?? '',
          title: str(flags.title) ?? '',
          body: str(flags.body),
          projectId: str(flags.project),
          repo: str(flags.repo),
          branch: str(flags.branch) === 'prod' ? 'prod' : str(flags.branch) === 'dev' ? 'dev' : undefined,
          by: userOf(flags),
        });
        out(r.msg);
        if (r.ok && r.created) out('下一步：./forge tick  自动建 worktree + 实现 + 本地 CI');
        process.exitCode = r.ok ? 0 : 1;
        break;
      }
      // 链式：implement <slug>（从 DONE 触发闸C）
      const r = await requestGateC(pos[0] ?? '', userOf(flags));
      out(r.msg);
      if (r.ok) out('下一步：./forge tick  自动建 worktree + 实现 + 本地 CI');
      process.exitCode = r.ok ? 0 : 1;
      break;
    }
    case 'gatec-answer': {
      const r = await submitGateCAnswers(pos[0] ?? '', str(flags.user) ?? 'M', str(flags.notes));
      out(r.msg);
      if (r.ok) out('下一步：./forge tick  跑本轮续做');
      process.exitCode = r.ok ? 0 : 1;
      break;
    }
    case 'review-pr': {
      // 闸C 绿后触发开 PR + 闸D PR 对抗 review：review-pr <slug> [--user M]
      const r = await requestReviewPr(pos[0] ?? '', userOf(flags));
      out(r.msg);
      if (r.ok) out('下一步：./forge tick  委托开 PR（不自动 merge）+ codex 审 diff⇄claude 修');
      process.exitCode = r.ok ? 0 : 1;
      break;
    }
    case 'gated-answer': {
      const r = await submitGateDAnswers(pos[0] ?? '', str(flags.user) ?? 'M', str(flags.notes));
      out(r.msg);
      if (r.ok) out('下一步：./forge tick  跑本轮续修');
      process.exitCode = r.ok ? 0 : 1;
      break;
    }
    case 'merged': {
      // 人工合并 PR 后确认 → SHIPPED（清 worktree + 接漂移闭环）：merged <slug> [--user M]
      const r = await ackMerged(pos[0] ?? '', userOf(flags), { force: !!flags.force });
      out(r.msg);
      process.exitCode = r.ok ? 0 : 1;
      break;
    }
    case 'retry': {
      const r = await retry(pos[0] ?? '', userOf(flags));
      out(r.msg);
      process.exitCode = r.ok ? 0 : 1;
      break;
    }
    case undefined:
    case 'help':
    case '-h':
    case '--help':
      help();
      break;
    default:
      log.err(`未知命令：${cmd}`);
      help();
      process.exitCode = 1;
  }
}

main().catch((e) => {
  log.err(String(e?.stack ?? e));
  process.exitCode = 1;
});
