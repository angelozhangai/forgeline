// 需求宠物·成长进化（彩蛋层）。每条需求 = 一只从「需求蛋」孵化、随评审阶段进化、上线即「完全体」的小宠物。
// 设计纪律：
//  · 纯函数 + 确定性——所有「随机」都从 session 的 id/ref_num/created_at 派生，同一需求每次显示一致，可单测、不抖。
//    （绝不用 Math.random / Date.now，否则同一张卡每次渲染都变、测试也没法断言。）
//  · 不泄漏黑话——台词一律人话，绝不出现 闸A/闸B/GATE_*（与 display.ts 同纪律，pet.test.ts 守门）。
//  · 总开关 FORGE_FUN=0 → 整套彩蛋关闭，卡片回到正经模式（notify.ts 据此走老路）。
import type { State } from '../statemachine/states.ts';
import type { Session } from '../types.ts';

export const FUN_ON = process.env.FORGE_FUN !== '0';

// 对外展示的 5 阶进化树（要换主题只改这里 + STAGE 的 tier）。
export const PET_TREE = ['🥚', '🐣', '🐤', '🐔', '🦄'] as const;

export interface PetStage {
  sprite: string; // 当前状态的宠物形象（= 进化树第 tier 阶那只，保证「头部形象 = 进化树高亮」一致）
  tier: number; // 1..5，对应进化树第几阶
  stage: string; // 阶段昵称（人话）
  voice: string; // 这一步的台词（人话，无黑话）
}

// 每个内部状态 → 进化阶段(tier) + 阶段昵称 + 台词。sprite 由 tier 派生（PET_TREE[tier-1]），
// 单一真源、不会和进化树高亮漂移。停泊态(失败/驳回)落回对应阶段，台词改「卡壳/回炉」。
const STAGE: Record<State, Omit<PetStage, 'sprite'>> = {
  INTAKE: { tier: 1, stage: '需求蛋', voice: '新需求落窝啦，正在排队孵化…' },
  GATE_A_RUNNING: { tier: 2, stage: '破壳中', voice: '对着最新代码啄壳评审中，挑刺找漏…' },
  AWAITING_PM_CONFIRM: { tier: 2, stage: '探头待哺', voice: '孵出几个问题，正伸长脖子等产品投喂答案～' },
  GATE_A_REVISION_REQUESTED: { tier: 2, stage: '回味答案', voice: '尝到产品喂的答案，正回头再啄一轮、看还有没有漏…' },
  GATE_A_ADVERSARIAL: { tier: 2, stage: '复核淬炼', voice: '产品答案齐了，正和 AI 评审互啄、把需求再淬一遍火…' },
  GATE_A_STALLED: { tier: 2, stage: '挑食卡住', voice: '喂了好几轮还是有疙瘩，喊负责人来拍个板。' },
  CONFIRMED: { tier: 3, stage: '吃饱了', voice: '答案吃饱啦，等负责人带它学飞（出技术方案）。' },
  GATE_B_REQUESTED: { tier: 3, stage: '蓄力', voice: '排队学飞，马上铺开飞行图纸…' },
  GATE_B_RUNNING: { tier: 3, stage: '学飞中', voice: '正在画技术方案的飞行图纸…' },
  ADVERSARIAL_LOOP: { tier: 4, stage: '对练', voice: '和 Codex 互啄找茬，越啄越壮…' },
  AWAITING_GATE_B_INPUT: { tier: 4, stage: '挠头求助', voice: '对练中撞上拿不准的点，正歪头等负责人拍个主意～' },
  GATE_B_REVISION_REQUESTED: { tier: 4, stage: '照方改练', voice: '得了负责人的主意，正回头照着再练一轮…' },
  AWAITING_GO: { tier: 4, stage: '整装待发', voice: '羽翼丰满，待你一声令下出窝立项！' },
  WRITING: { tier: 4, stage: '起飞', voice: '正在建需求、铺跑道…' },
  DONE: { tier: 5, stage: '完全体', voice: '进化成功，振翅上线！' },
  // 下游：实现 + 本地CI
  GATE_C_REQUESTED: { tier: 4, stage: '待动工', voice: '图纸齐了，排队进隔离窝开写代码…' },
  GATE_C_RUNNING: { tier: 4, stage: '动工中', voice: '钻进隔离窝照图纸敲代码啦…' },
  GATE_C_LOOP: { tier: 4, stage: '边写边自测', voice: '边敲代码边自测，红了就回炉补到全绿…' },
  AWAITING_GATE_C_INPUT: { tier: 4, stage: '挠头求助', voice: '写到一半撞上拿不准的点，歪头等负责人拍个主意～' },
  GATE_C_REVISION_REQUESTED: { tier: 4, stage: '照答案续做', voice: '得了负责人的主意，回头接着写…' },
  // 下游：PR 复审 + 测试补强 + 合并
  AWAITING_GATE_D: { tier: 4, stage: '待受检', voice: '代码写完自测过啦，等一声令下提交受检！' },
  GATE_D_REQUESTED: { tier: 4, stage: '提交受检', voice: '正把改动提上去、排队等复审…' },
  GATE_D_LOOP: { tier: 4, stage: '受检对练', voice: '和 Codex 对着改动互啄找茬，越改越稳…' },
  AWAITING_GATE_D_INPUT: { tier: 4, stage: '挠头求助', voice: '复审里撞上拿不准的点，歪头等负责人拍个主意～' },
  GATE_D_REVISION_REQUESTED: { tier: 4, stage: '照评审续改', voice: '照着复审意见回头再改一轮…' },
  GATE_D_HARDENING: { tier: 4, stage: '加固护甲', voice: '正给改动补真测试当护甲（绝不糊弄镜像）…' },
  AWAITING_HUMAN_MERGE: { tier: 5, stage: '整装待合', voice: '护甲齐全、检查全过，待你一声令下合并上线！' },
  SHIPPED: { tier: 5, stage: '完全体', voice: '改动已合并，振翅上线！' },
  // 停泊态
  GATE_A_FAILED: { tier: 2, stage: '卡壳', voice: '破壳卡住了，喊负责人来搭把手。' },
  GATE_B_FAILED: { tier: 3, stage: '卡壳', voice: '学飞摔了一跤，喊负责人来救场。' },
  GATE_B_STALLED: { tier: 4, stage: '对练僵住', voice: '练了好几轮还有疙瘩，喊负责人来拍个板。' },
  GATE_C_FAILED: { tier: 4, stage: '卡壳', voice: '动工时摔了一跤，喊负责人来救场。' },
  GATE_C_STALLED: { tier: 4, stage: '自测卡住', voice: '自测好几轮还没全绿，喊负责人来拍个板。' },
  GATE_D_FAILED: { tier: 4, stage: '卡壳', voice: '复审时绊了一下，待负责人重试。' },
  GATE_D_STALLED: { tier: 4, stage: '对练僵住', voice: '复审练了好几轮还有疙瘩，喊负责人来拍个板。' },
  GO_DENIED: { tier: 1, stage: '回炉', voice: '被退回重养，改改再战。' },
  WRITE_FAILED: { tier: 4, stage: '卡壳', voice: '出窝时绊了一下，待负责人重试。' },
};

export function petStage(state: State): PetStage {
  const e = STAGE[state] ?? STAGE.INTAKE;
  return { sprite: PET_TREE[e.tier - 1], ...e };
}

// 进化阶 → 像素动图资源名（assets/pet/<name>.gif，与 keys.json 的 key 对齐）。按 tier 取，单一真源。
export const TIER_ASSET = ['egg', 'hatch', 'chick', 'bird', 'final'] as const;
export function petAssetName(state: State): string {
  return TIER_ASSET[petStage(state).tier - 1];
}

// 确定性 hash（FNV-1a）。只为「同一需求稳定挑同一只最终形态/彩蛋」，不做安全用途。
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// 最终形态（上线时的收集感）：从 session id 确定性挑一只完全体；命中稀有则金光闪闪。
const FINAL_FORMS = ['🦄', '🐉', '🦅', '🦚', '🦖', '🦢', '🦩'];
export function finalForm(s: Pick<Session, 'id' | 'slug'>): string {
  const h = hash(s.id || s.slug || 'x');
  if (h % 20 === 0) return '✨🦄✨'; // ~5% 稀有金
  return FINAL_FORMS[h % FINAL_FORMS.length];
}

// 进化树一行，当前阶段高亮：🥚→🐣→【🐤】→🐔→🦄
export function treeLine(state: State): string {
  const tier = petStage(state).tier;
  return PET_TREE.map((e, i) => (i + 1 === tier ? `【${e}】` : e)).join('→');
}

// 投喂（成本拟物）。每 $0.05 折一口「算力粮」。
//  · group 卡：opts.showDollar=false → 只显示口数 + 粮票 emoji，藏起金额（PM 不该看内部成本）。
//  · 私聊(M) 卡：showDollar=true → 口数 + 真实 $（你的预算账本）。
export function feedLine(costUsd: number, opts: { showDollar: boolean }): string {
  const bites = Math.max(1, Math.round((costUsd || 0) / 0.05));
  if (opts.showDollar) return `🍗 这趟投喂 ${bites} 口算力粮 · $${(costUsd || 0).toFixed(2)}`;
  const food = '🍗'.repeat(Math.min(bites, 6));
  return `${food} 已投喂 ${bites} 口算力粮`;
}

// 偶发隐藏台词（确定性，从 session 派生；多数时候为 null）。优先级：里程碑 > 夜猫子 > 幸运蛋。
export function easterEgg(s: Pick<Session, 'id' | 'ref_num' | 'created_at'>): string | null {
  if (s.ref_num != null && s.ref_num > 0 && s.ref_num % 10 === 0) {
    return `🏆 里程碑达成：这是第 ${s.ref_num} 只需求蛋！`;
  }
  if (s.created_at) {
    const hour = new Date(s.created_at).getHours(); // 本机时区（China），仅做趣味判断
    if (hour >= 0 && hour < 6) return '🦉 夜猫子蛋：深夜下的蛋，格外有灵性～';
  }
  if (hash(`${s.id || ''}luck`) % 13 === 0) return '🍀 幸运蛋：今天它精神抖擞，状态拉满！';
  return null;
}
