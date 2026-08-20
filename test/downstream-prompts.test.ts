// golden（不花钱，进 npm run ci）：下游 prompt 资产**模板侧**防退化网。守两件确定性的事：
//  ①**模板变量契约（双向）**：用文档化的变量集渲染后无残留 {{X}}（模板没引入契约外的变量）+ 声明的变量都真被用到
//    （契约表没列冗余）。⚠️ 这只锁「模板↔契约表」一致，**不**证明「代码真喂了这些变量」——后者（code 漏喂 → 运行期残留 {{X}}）
//    由各 driver 集成测试断言**真渲染产物**无残留占位来兜（真跑 render→mock LLM 捕获 prompt 断言无 {{X}}）：
//    gate-c-implement/-fix-resume 见 gateCLoop.test；gate-d-pr-review(+resume)/gate-d-fix(+resume) 见 gateDLoop.test；
//    gate-d-ci-fix 见 gateDLoop.test（loop 自修调用点）+ gateDHarden.test（harden 自修调用点，两调用点皆覆盖）；
//    gate-d-harden-tests 见 gateDHarden.test。即：下游 gate-c/gate-d 每个 prompt 资产都有 ≥1 处 driver 真渲染兜底
//    （gate-d-ci-fix 两个调用点均覆盖）；本文件只补「模板↔契约表」这一层（含上面没单独跑的纯模板一致性）。
//  ②**红线纪律不被误删**：改方 prompt 的「不开 PR / 不 push / 不动 git」三联 + needs_human 升级口 + 只输出 JSON；
//    codex 审 prompt 的「LGTM⇔findings 空 / CHANGES⇔findings 非空」契约 + 镜像测试检查；补强 prompt 的镜像测试反面教材。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPrompt, render } from '../src/util/render.ts';

// 改方/实现/补强（claude 改 worktree）共同红线：禁外向写 + 升级口 + 只输出 JSON。
// 容差正则（大小写/措辞微调不误红），但保护意图不变：不开 PR / 不 push / 不动 git / 升级口 / 只输出 JSON。
const FIXER = [/do not open a PR/i, /do not push/i, /do not touch git/i, /needs_human/, /output ONLY this JSON/i];
// codex 审 diff 的判决契约 + 测试质量检查。
const REVIEWER = [/LGTM ⇔ findings must be empty/i, /CHANGES_REQUESTED ⇔ findings/, /mirror test/i];

const PROMPTS: { f: string; vars: string[]; must: RegExp[] }[] = [
  // 闸C 实现 / 续做
  { f: 'gate-c-implement.md', vars: ['CONTEXT', 'FINDINGS', 'WORKTREE'], must: FIXER },
  { f: 'gate-c-fix-resume.md', vars: ['FINDINGS', 'HUMAN_ANSWER', 'WORKTREE'], must: FIXER },
  // 闸D codex 审 diff
  { f: 'gate-d-pr-review.md', vars: ['CONTEXT', 'BASE', 'WORKTREE'], must: REVIEWER },
  { f: 'gate-d-pr-review-resume.md', vars: ['BASE', 'WORKTREE'], must: REVIEWER },
  // 闸D claude 改方 / 续修 / CI 自修
  { f: 'gate-d-fix.md', vars: ['FINDINGS', 'WORKTREE'], must: FIXER },
  { f: 'gate-d-fix-resume.md', vars: ['FINDINGS', 'HUMAN_ANSWER', 'WORKTREE'], must: FIXER },
  { f: 'gate-d-ci-fix.md', vars: ['CI', 'WORKTREE'], must: FIXER },
  // 闸D 测试补强：FIXER 红线 + 镜像测试反面教材（「杜绝镜像测试」硬规则由 code hardenRules() 注入 {{HARDEN_RULES}}）。
  { f: 'gate-d-harden-tests.md', vars: ['WORKTREE', 'DIFF_STAT', 'CONTEXT', 'HARDEN_RULES'], must: [...FIXER, /mirror test/i, /anti-pattern/i] },
];

for (const p of PROMPTS) {
  test(`prompt 资产（模板侧）：${p.f} 存在、变量契约双向一致、红线纪律在`, () => {
    const tmpl = loadPrompt(p.f); // 缺文件即抛 → 防误删
    assert.ok(tmpl.trim().length > 0, `${p.f} 空`);
    const vars = Object.fromEntries(p.vars.map((v) => [v, `‹${v}›`]));
    const out = render(tmpl, vars);
    // 契约双向：渲染后无残留 {{X}}（模板没引入契约外变量）+ 声明的变量都被用到（契约表无冗余）。
    assert.doesNotMatch(out, /\{\{\w+\}\}/, `${p.f} 模板引入了契约表外的变量（残留占位）`);
    for (const v of p.vars) assert.match(out, new RegExp(`‹${v}›`), `${p.f} 契约表声明了模板未用的变量 ${v}`);
    // 红线纪律不被误删。
    for (const re of p.must) assert.match(out, re, `${p.f} 缺红线纪律 ${re}`);
  });
}
