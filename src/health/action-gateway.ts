// Web 操作面板写网关：把面板动作派到 actions.ts 的真函数。**绝不重造闸**——权限/lint/指派/状态机红线全由被调
// 的真 action 自身把关（与飞书卡片/CLI 同一套）；网关只做：动作名白名单 + 面板署名 actor + panel_action 审计 + 解析 slug。
// 署名 actor = runtime.web_actor（缺省 routing.lead）；须在相应权限名单里，否则 action 自身返回 !ok（网关不放水）。
import * as actions from '../actions.ts';
import type { ActionResult } from '../actions.ts';
import { configForProject } from '../projects.ts';
import { store } from '../store/index.ts';
const { resolve: resolveSession, appendEvent } = store; // 经 SessionStore 接缝取本地实现方法（自由函数无 this，解构安全）
import type { State } from '../statemachine/states.ts';

type Dispatch = (idOrSlug: string, by: string) => ActionResult | Promise<ActionResult>;

// 面板可触发动作 → 真 action。只收「人授权前进 / 裁决 / 重试」这类**按钮**动作；需文本答复的 *_INPUT 提交（submitGateB/C/DAnswers）另做。
const DISPATCH: Record<string, Dispatch> = {
  confirm: (id, by) => actions.confirm(id, by), // GATE_A_STALLED 强制通过
  gateb: (id, by) => actions.requestGateB(id, by), // CONFIRMED → 出技术方案
  force_go: (id, by) => actions.forceGateBGo(id, by), // GATE_B_STALLED 强制立项
  go: (id, by) => actions.go(id, by), // AWAITING_GO → 立项（不带 --force：lint/指派不过 !ok 留人工）
  deny: (id, by) => actions.deny(id, by), // AWAITING_GO → 打回
  implement: (id, by) => actions.requestGateC(id, by), // DONE → 起实现
  review_pr: (id, by) => actions.requestReviewPr(id, by), // AWAITING_GATE_D → 开 PR
  merged: (id, by) => actions.ackMerged(id, by), // AWAITING_HUMAN_MERGE → 确认已合并（不带 --force）
  retry: (id, by) => actions.retry(id, by), // *_FAILED → 重试（真 action 按失败闸鉴权）
};

// 状态 → 该态下面板可用的动作键（**单一真源**：board 详情据此渲染按钮；真校验仍在被调 action）。
const BY_STATE: Partial<Record<State, string[]>> = {
  GATE_A_STALLED: ['confirm'],
  CONFIRMED: ['gateb'],
  GATE_B_STALLED: ['force_go'],
  AWAITING_GO: ['go', 'deny'],
  DONE: ['implement'],
  AWAITING_GATE_D: ['review_pr'],
  AWAITING_HUMAN_MERGE: ['merged'],
  GATE_A_FAILED: ['retry'],
  GATE_B_FAILED: ['retry'],
  GATE_C_FAILED: ['retry'],
  GATE_D_FAILED: ['retry'],
  WRITE_FAILED: ['go'], // WRITE_FAILED 须重跑 go（planRetry 对它返 null，retry 会「无需重试」）；go 接受 WRITE_FAILED 且据 created_issues 跳过重建
};

// 该状态下面板可用的动作键（前端据此画按钮）。纯函数，导出供单测。
export function panelActionsFor(state: State): string[] {
  return BY_STATE[state] ?? [];
}

// 面板写动作的署名短码：runtime.web_actor，缺省回退**该项目级** routing.lead（配置分化：项目可有自己的 lead）。
export function panelActor(pid?: string): string {
  const cfg = configForProject(pid);
  return cfg.runtime.web_actor ?? cfg.routing.lead;
}

// 跑一个面板动作：校验动作名 + 解析需求 + 落 panel_action 审计 + 派到真 action（继承其权限/lint/红线）。
// 未知动作 / 找不到需求 → !ok，绝不静默。
export async function runPanelAction(action: string, slug: string): Promise<ActionResult> {
  const fn = DISPATCH[action];
  if (!fn) return { ok: false, msg: `未知面板动作：${action}` };
  const s = await resolveSession(slug);
  if (!s) return { ok: false, msg: `找不到需求：${slug}` };
  // 「按状态出按钮」必须是写网关策略、不只是前端展示：服务端再核一遍该动作是否属当前态的 BY_STATE，
  // 否则可绕过界面直接 POST 一个该态真 action 恰好允许、但面板策略不提供的动作（如非停泊态强制 confirm）。
  if (!panelActionsFor(s.state).includes(action)) {
    return { ok: false, msg: `动作 ${action} 在状态 ${s.state} 下不可用` };
  }
  const by = panelActor(s.project_id);
  await appendEvent(s.id, 'panel_action', { action, by }); // 审计来源：这步来自 Web 面板（被调 action 还会各记自己的事件）
  return fn(s.id, by);
}
