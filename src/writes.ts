import { readFileSync, existsSync } from 'node:fs';
import { GateBSchema } from './gates/envelopes.ts';
import type { IssueSpec } from './gates/envelopes.ts';
import { commitDeliveryDocs } from './workspace.ts';
import { projectActions, type ProjectActions } from './project/index.ts';
import { projectForSession, configForSession } from './projects.ts';
import { loadConfig, resolveLogin } from './config.ts';
import { log } from './util/log.ts';
import { reqRef } from './util/display.ts';
import { acceptanceMarkdown } from './util/acceptance.ts';
import { normSize, type Size } from './util/sizing.ts';
import { safeParse } from './util/json.ts';
import type { Session, CreatedIssue } from './types.ts';

export interface WriteResult {
  ok: boolean;
  stdout: string;
  issues: CreatedIssue[];
  published: boolean; // 技术方案是否**真的**发布了主仓 PR（demo 真发=true；native no-op / 未开发布=false）。DONE 文案据此。
}

// dryRun=只打印不创建；onCreated=issue 一建成立即回调落库（崩溃窗内也不丢已建记录，retry 据此跳过重建）。
export interface WriteOpts {
  dryRun?: boolean;
  onCreated?: (issues: CreatedIssue[]) => void;
}

// 伞仓（多仓 Epic 本体所在仓）与「仓字母 → 仓名」映射现按目标项目解析（projectForSession(s) → .umbrella / .repoMap）。

// 交付文档自动提交（config 门控、默认关、**绝不 push**）：把 docs/delivery/<slug>/ 提交到目标项目当前分支。
// 两处调用：① 立项成功（归档 req-review/tech-design）；② 闸D 全部目标仓补强完进合并就绪（归档 merge-readiness*.md）。
// best-effort——失败/异常只 warn，绝不阻断已成功的流程；返回结果供调用方留事件/审计。导出供下游 worker 复用同一门控。
export async function maybeCommitDeliveryDocs(s: Session): Promise<{ ok: boolean; committed: boolean }> {
  if (!loadConfig().runtime.delivery_doc_commit?.enabled) return { ok: true, committed: false };
  try {
    const { root } = projectForSession(s);
    const r = await commitDeliveryDocs({ root, slug: s.slug, refNum: s.ref_num ?? undefined });
    if (r.committed) log.info(`📄 已提交交付文档 docs/delivery/${s.slug}（目标项目当前分支，未 push）`);
    else if (!r.ok) log.warn(`交付文档自动提交失败（不影响流程，请人工提交）：${r.stderr}`);
    return { ok: r.ok, committed: r.committed };
  } catch (e) {
    log.warn(`交付文档自动提交异常（不影响流程）：${String(e).slice(0, 140)}`);
    return { ok: false, committed: false };
  }
}

// 上一轮已建成的 issue（WRITE_FAILED 多发生在建成后的 labels/approve 步骤）→ retry 据此跳过重建，绝不重复建 issue。
function alreadyCreated(s: Session): CreatedIssue[] {
  const arr = safeParse<CreatedIssue[]>(s.created_issues, []);
  return Array.isArray(arr) ? arr.filter((i) => i?.repo && i.number) : [];
}

// 给建好的 issue 打 size:* 标签（喂主仓 weekly-load.sh 的「规模」轴）。返回失败列表（聚合后由 doWrites 决定是否停泊）。
// size 对工程师可见(标签)、但人均工作量加权(weekly-load)才是管理面——符合 show size / 别滥用 workload。
async function applySizeLabels(
  issues: CreatedIssue[],
  overall: Size | null,
  specs: IssueSpec[],
  repoMap: Record<string, string>,
  pa: ProjectActions,
): Promise<{ repo: string; number: number; stderr: string }[]> {
  const fails: { repo: string; number: number; stderr: string }[] = [];
  for (const iss of issues) {
    // Epic(伞仓)/单仓 → 整需求档；子 issue → 该仓切片档(无则回退整需求档)。
    const spec = specs.find((sp) => repoMap[sp.repo] === iss.repo);
    const size = (spec?.size ? normSize(spec.size) : null) ?? overall;
    if (!size) continue;
    const r = await pa.addLabel(iss.repo, iss.number, `size:${size}`);
    if (!r.ok) fails.push({ repo: iss.repo, number: iss.number, stderr: r.stderr.slice(0, 120) });
  }
  return fails;
}

// 真正落地：建 issue（单仓/Epic）+ 闸B 放行置 status:3。dryRun=只打印不创建。
// 幂等（P1-D）：① issue 一建成立即 onCreated 落库（建成后 labels/approve 失败也不丢记录）；
// ② 入口若 created_issues 已有记录 → 跳过重建，仅补跑幂等的 labels/approve，绝不重复建 issue。
// 失败不静默：approve 非零退出、size 标签打失败、多仓子 issue 部分缺失 → 一律抛 → WRITE_FAILED（绝不假装 DONE）。
export async function doWrites(s: Session, opts: WriteOpts = {}): Promise<WriteResult> {
  if (!s.gate_b_draft_path || !existsSync(s.gate_b_draft_path)) {
    throw new Error('缺 gate-b 草稿，无法建需求');
  }
  const env = GateBSchema.parse(JSON.parse(readFileSync(s.gate_b_draft_path, 'utf8')));
  if (env.issue_specs.length === 0) throw new Error('issue_specs 为空，无可建 issue');
  // 目标项目：决定仓字母→仓名映射、伞仓；机械动作经 ProjectActions 端口（scriptsDir/owner 由 adapter 注入）。
  const proj = projectForSession(s);
  const { repoMap, umbrella } = proj;
  const pa = projectActions(proj);
  const prd = s.prd_url ?? undefined;
  // 立项 DRI：会话指派（自动推荐/人工改派）优先，回退闸B issue_spec 的 assignee。短码→login 按**该项目**的 reviewers
  // 解析（配置分化：项目 pool 产出的短码须用项目级 reviewers 映射到 GitHub login，否则裸短码传给 new-req.sh 指错人/失败）。
  const sessionDri = s.assignee ? resolveLogin(configForSession(s), s.assignee) ?? s.assignee : null;
  // 需求编号全程流转 → 写进 issue 正文（回链评审来源）。复杂度走 size:* 标签（见 applySizeLabels）。
  const refLine = `评审编号：${reqRef(s)}`;

  // 先把技术方案 doc 发布到主仓（提交+PR+merge）→ 再建 issue（用户口径：方案落地后才立项）。
  // 失败抛 → go() 转 WRITE_FAILED，不建 issue；瞬时错(gh/网络) classifyError 自动重试；幂等不重复发。
  let publishOut = '';
  let published = false; // 真的发了 PR 才 true（native publishTechDesign 是 no-op → false）——绝不让 DONE 文案谎称 PR 已合
  const pub = proj.techDesignPublish; // 按项目解析（projects.yaml 可单独关）；不再读全局 runtime（多项目/可插拔目标必需）
  if (pub?.enabled) {
    const r = await pa.publishTechDesign(s.slug, { base: pub.base, dryRun: opts.dryRun });
    publishOut = r.stdout ? `${r.stdout}\n` : '';
    if (!r.ok) throw new Error(`技术方案发布主仓失败：${(r.stderr || r.stdout || '').slice(0, 300)}（修复后 retry go；幂等不会重复发）`);
    published = r.published;
  }

  // 真跑（非 dryRun）才考虑续建；dryRun 永远完整预演。
  const resume = !opts.dryRun ? alreadyCreated(s) : [];

  // size 标签失败聚合后统一抛（不静默漏数 weekly-load 口径）；先于 approve，缺标签不放行 status:3。
  const failIfLabelsFailed = (fails: { repo: string; number: number }[]): void => {
    if (fails.length) {
      throw new Error(
        `size 标签打失败 ${fails.length} 个：${fails.map((f) => `${f.repo}#${f.number}`).join(', ')}` +
          `（标签没同步？主仓 sync-labels.sh 后 retry go；issue 已建、不会重复）`,
      );
    }
  };
  const approveOrThrow = async (issue?: string): Promise<void> => {
    const ap = await pa.approveTechDesign(s.slug, issue, false);
    if (!ap.ok) throw new Error(`tech-design approve 失败：${(ap.stderr || ap.stdout || '').slice(0, 300)}（修复后 retry go）`);
  };

  if (env.multi_repo) {
    const expectedRepos = [...new Set(env.issue_specs.map((i) => repoMap[i.repo] ?? i.repo))]; // 期望子仓（去重）
    const missingOf = (have: CreatedIssue[]): string[] => expectedRepos.filter((repo) => !have.some((i) => i.repo === repo));

    const fromResume = resume.length > 0;
    let issues = resume;
    let stdout = '(已建 issue，跳过重建，仅补跑 labels/approve)';
    if (!fromResume) {
      const dri = sessionDri ?? env.issue_specs.find((i) => i.assignee)?.assignee;
      const type = env.epic_doc_type || env.issue_specs[0]?.type || 'feat';
      const prio = env.issue_specs[0]?.prio;
      const children = env.issue_specs.map((i) => ({ repo: i.repo, title: i.title }));
      // Epic 正文挂全量外环验收（跨仓契约的 Done 定义）；各仓子 issue 由 epic 脚本据 children 建。
      const epicBody = [refLine, acceptanceMarkdown(env.acceptance)].filter(Boolean).join('\n\n');
      const r = await pa.createEpic(s.slug, env.epic_title || s.title, children, {
        type, prio, assignee: dri, docUrl: prd, body: epicBody, dryRun: opts.dryRun,
      });
      if (opts.dryRun) return { ok: r.ok, stdout: publishOut + r.stdout, issues: r.issues, published };
      if (!r.ok) throw new Error(`建 Epic 失败：${r.stderr.slice(0, 300)}`);
      // 端口契约：createEpic.issues = Epic + 全部已建子 issue（demo adapter 解 ✓C#n / native 自建并直接返回）。
      // doWrites 不再 know 任何脚本输出格式——多仓 native 据此可端到端跑通。
      issues = r.issues;
      opts.onCreated?.(issues); // Epic + 已建子 issue 都落库（保留已建出的，便于人工补救 + done 卡完整）
      stdout = r.stdout;
    }

    // 覆盖校验（**fresh + resume 都跑**，堵「首次挡住、重跑从侧门进」）：期望子仓必须都齐。
    // 主仓脚本子 issue 建失败是 continue（脚本仍退 0），故缺子 issue 绝不静默 approve 到 DONE。
    let missing = missingOf(issues);
    if (missing.length && fromResume && !opts.dryRun) {
      // 重跑场景：人工可能已 new-req.sh add-child 补建 → 按 epic:<slug> 标签从 GitHub 重新发现并刷新 created_issues。
      const refreshed = [...issues];
      for (const repo of missing) {
        const q = await pa.listEpicChildren(repo, s.slug);
        if (q.ok) for (const iss of q.issues) if (!refreshed.some((x) => x.repo === iss.repo && x.number === iss.number)) refreshed.push(iss);
      }
      if (refreshed.length !== issues.length) {
        issues = refreshed;
        opts.onCreated?.(issues); // 刷新落库 → 后续 retry 直接命中、done 卡完整
      }
      missing = missingOf(issues);
    }
    if (missing.length) {
      throw new Error(
        `多仓子 issue 缺失：${missing.join('/')}（期望 ${expectedRepos.join('/')}）。` +
          `用 \`new-req.sh add-child <slug> <repo>\` 补建后 retry go（会按 epic 标签自动补登记，绝不重复建）`,
      );
    }

    // size 只打在 Epic（需求行）；子 issue 不带（主仓约定，跨栈倍率另算）。
    failIfLabelsFailed(await applySizeLabels(issues.filter((i) => i.repo === umbrella), normSize(s.size ?? ''), env.issue_specs, repoMap, pa));
    await approveOrThrow(); // epic.sh set <slug> 3 + tech-design 文档 active
    await maybeCommitDeliveryDocs(s); // best-effort，config 门控，绝不 push
    return { ok: true, stdout: publishOut + stdout, issues, published };
  }

  const spec = env.issue_specs[0];
  let issues = resume;
  let stdout = '(已建 issue，跳过重建，仅补跑 labels/approve)';
  if (issues.length === 0) {
    // 单仓 issue 正文 = 评审编号 + 方案背景 + 本仓外环验收（Done 定义，工程师据此补内环单测/集测）。
    const body = [refLine, spec.body, acceptanceMarkdown(env.acceptance, spec.repo)].filter(Boolean).join('\n\n');
    const r = await pa.createSingle(spec.repo, spec.title, {
      type: spec.type, prio: spec.prio, area: spec.area, assignee: sessionDri ?? spec.assignee, docUrl: prd, body, dryRun: opts.dryRun,
    });
    if (opts.dryRun) return { ok: r.ok, stdout: publishOut + r.stdout, issues: r.issues, published };
    if (!r.ok || r.issues.length === 0) throw new Error(`建 issue 失败：${r.stderr.slice(0, 300)}`);
    opts.onCreated?.(r.issues);
    issues = r.issues;
    stdout = r.stdout;
  }
  failIfLabelsFailed(await applySizeLabels(issues, (spec.size ? normSize(spec.size) : null) ?? normSize(s.size ?? ''), env.issue_specs, repoMap, pa));
  await approveOrThrow(`${spec.repo}:${issues[0].number}`);
  await maybeCommitDeliveryDocs(s); // best-effort，config 门控，绝不 push
  return { ok: true, stdout: publishOut + stdout, issues, published };
}
