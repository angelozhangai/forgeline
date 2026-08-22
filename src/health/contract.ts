// Layer 3 — 外部依赖契约的「每日定时带外检测 + 告警」。
//  · runContractProbes：跑全部探针 → 落库（昂贵，仅每日调度跑）。
//  · maybeAlertContractDrift：按依赖翻转去抖 → 新漂移发飞书 degraded 卡（私聊 M）、恢复发 recovered。
//  · contractCheck：只读 DB 上次探测态聚成一个 health Check，折进 evaluateHealth——
//    于是 60s 一次的健康采样仍廉价（零探针），漂移自动出现在状态页 / `forge health`。
import { log } from '../util/log.ts';
import { runAllProbes, type ProbeResult } from '../llm/probes.ts';
import { getProbe, upsertProbe, allProbes } from '../store/contract.ts';
import { sendHealthAlert } from './alert.ts';
import type { Check } from './check.ts';
import { port } from '../messaging/index.ts';

// 'im' 那一项显示成**当前生效的 provider 名**（飞书 API / slack API）——写死某一家的话，
// 换了 provider 的部署会在状态页上看到一个跟自己无关的名字。
function depLabel(dep: string): string {
  if (dep === 'im') return `${port.id} API`;
  return DEP_LABEL[dep] ?? dep;
}
const DEP_LABEL: Record<string, string> = { codex: 'codex', claude: 'claude', gh: 'gh' };
// 登录/鉴权失效（kind='auth'）时各工具的「重新登录」指引——区别于 schema 漂移（改 contract.ts）。
// 直击「token 过期 → 链路静默瘫」：给操作者可直接照做的修复动作，而非误导去改信封定义。
// IM 那条**不在这里**：怎么修是 provider 知识，由 adapter 随探针结果自报（ProbeResult.authFix）。
const AUTH_FIX: Record<string, string> = {
  codex: 'codex 重新登录（codex 非交互鉴权 / 重跑登录）',
  claude: 'claude 重新登录（/login 或换 CLAUDE_CODE_OAUTH_TOKEN / setup-token）',
  gh: 'gh auth login（需目标项目 GitHub org 写权限）',
};

// 跑全部探针并落库（available 的才落）。返回结果供调用方告警。昂贵——仅每日 interval / `forge contract-check` 调。
export async function runContractProbes(now: number): Promise<ProbeResult[]> {
  const results = await runAllProbes(now);
  // 注意：先告警（读上次态）再落库——maybeAlertContractDrift 内部按顺序 getProbe→upsert。
  await maybeAlertContractDrift(results);
  return results;
}

// 翻转去抖：对比 DB 里上次 ok，仅在「完好→漂移」首次发 degraded、「漂移→完好」发 recovered。
// 持久漂移不每日刷屏。available=false（跳过）的不落库、不告警。
export async function maybeAlertContractDrift(results: ProbeResult[], now: number = results[0]?.at ?? 0): Promise<void> {
  for (const r of results) {
    if (!r.available) continue;
    const prev = getProbe(r.dep);
    const wasOk = prev ? prev.ok : true; // 首次见到默认当「之前好的」，仅在变坏时告警
    upsertProbe(r);
    if (wasOk && !r.ok) {
      const label = depLabel(r.dep);
      const body =
        r.kind === 'auth'
          ? [
              `**${label}** 调用非零退出，疑似**登录态失效 / token 过期**——相关闸/建 issue 会停泊（失败不静默）。`,
              `- 现象：${r.detail}`,
              `- 处置：${r.authFix ?? AUTH_FIX[r.dep] ?? '检查该工具登录态'}，恢复后 \`forge retry <slug>\` 清停泊。`,
              ...(r.raw ? ['```', r.raw.slice(0, 600), '```'] : []),
            ]
          : [
              `**${label}** 升级后输出结构疑似变更——我们解析所依赖的信封字段未出现。`,
              `- 现象：${r.detail}`,
              `- 影响：相关闸/补拉解析可能静默退化 → 现已改为**停泊**（失败不静默）。`,
              `- 处置：核对 ${r.dep} 新版输出 → 改 \`src/llm/contract.ts\` 的信封定义（单点）。`,
              ...(r.raw ? ['```', r.raw.slice(0, 600), '```'] : []),
            ];
      await sendHealthAlert('degraded', r.kind === 'auth' ? `🔑 ${label} 登录/鉴权疑似失效` : `外部工具契约漂移：${label}`, body, now);
    } else if (!wasOk && r.ok) {
      await sendHealthAlert('recovered', `外部工具契约已恢复：${depLabel(r.dep)}`, [`${depLabel(r.dep)} 信封字段重新解析正常。`], now);
    }
  }
}

// 只读 DB 上次探测态 → 一个 health Check（绝不触发探针）。供 evaluateHealth 折入 checks[]。
export function contractCheck(now: number): Check {
  let rows: ReturnType<typeof allProbes>;
  try {
    rows = allProbes();
  } catch {
    return { name: '外部工具契约', status: 'na', detail: '探针记录不可读' };
  }
  if (rows.length === 0) return { name: '外部工具契约', status: 'na', detail: '尚未探测（每日一次）' };
  const drifted = rows.filter((r) => !r.ok);
  const newest = Math.max(...rows.map((r) => r.checkedAt));
  const ageMin = Math.max(0, Math.round((now - newest) / 60000));
  if (drifted.length) {
    return { name: '外部工具契约', status: 'degraded', detail: `契约漂移：${drifted.map((d) => depLabel(d.dep)).join('、')}（${ageMin} 分钟前探测）` };
  }
  return { name: '外部工具契约', status: 'healthy', detail: `${rows.map((r) => depLabel(r.dep)).join('/')} 契约正常（${ageMin} 分钟前）` };
}

// 给 CLI `forge contract-check` 用：跑探针 + 告警 + 打印一行行结果。
export async function runContractCheckCli(now: number): Promise<ProbeResult[]> {
  const results = await runContractProbes(now);
  for (const r of results) {
    const mark = !r.available ? '·' : r.ok ? '✓' : '✗';
    log.info(`${mark} ${depLabel(r.dep)}：${r.detail}`);
  }
  return results;
}
