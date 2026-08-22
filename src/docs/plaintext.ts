// 文档源——**纯文本**（兜底源）：需求正文就是那条 IM 消息本身，没有可回源的远端文档。
//
// 存在的理由：接 Slack 不该先欠一个 Notion/Google Docs adapter。人在群里 @ 机器人写一段需求，
// 这段话本身就够立项——这是最低配、零文档服务依赖的入口。
//
// **默认关**。开它等于把「@机器人 + 一段话」变成一条会真的跑闸A（花钱）的需求，对既有飞书部署
// 是行为变化：今天一条没链接的 @ 消息只会被忽略。所以要显式在 runtime.yaml 打开，绝不默认生效。
import { createHash } from 'node:crypto';
import { loadConfig } from '../config.ts';
import { log } from '../util/log.ts';
import type { DocClaimInput, DocRef, DocReadResult, DocSource } from './port.ts';

export const PLAINTEXT_SOURCE = 'plaintext';

// 实质性下限：归一后的**非空白字符数**。低于此不认领。
// 这道闸只为挡「好的/收到，谢谢/ok thanks」这类寒暄——人已经特意 @ 了机器人（群消息入口闸先过一道），
// 意图本身是明确的，所以不必再猜语义，长度是这里唯一站得住的信号。
// 取 20：中文一句真需求（「把退款按钮挪到订单详情页顶部并加二次确认」= 21 字）过得去，寒暄过不去。
// 代价是**假阴性**——极简短的真需求会被忽略；那是可接受的一侧：漏了人再写长点，而误收要花闸A 的钱。
export const MIN_SUBSTANCE_CHARS = 20;

// IM 的 @ 标记。这是**唯一**一处 IM 标记形状出现在 adapter 之外，理由是必须的：
// 这些占位符会随「@了谁」变化，留在正文里会让同一段话因 @ 的人不同而算出不同 token（去重直接失效）。
// 认的是**标记形状**、不是任何 provider 的 API；再冒出第三种形态就加在这里。
const MENTION_PATTERNS: RegExp[] = [
  /@_user_\d+/g, // 飞书：正文里的 @ 占位符
  /<@[A-Z0-9]+>/g, // Slack：<@U012ABC>
  /<![a-z]+>/g, // Slack：<!here> / <!channel>
];

// 归一：剥 @ 标记 → 折叠所有空白为单空格 → trim。
// 折叠空白是有意的：同一段需求换行方式不同（复制粘贴/手机端）不该算成两份需求。
export function normalizePlaintext(text: string): string {
  let s = text ?? '';
  for (const re of MENTION_PATTERNS) s = s.replace(re, ' ');
  return s.replace(/\s+/g, ' ').trim();
}

// 内容寻址：归一正文的 sha256（取前 32 hex）。没有文档身份可言，内容就是身份——
// 于是「原样再贴一遍」命中去重，「改了字再贴」诚实地算作一条新需求（本来也没有版本可追）。
export function contentToken(normalized: string): string {
  return createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, 32);
}

export function hasSubstance(normalized: string): boolean {
  return normalized.replace(/\s/g, '').length >= MIN_SUBSTANCE_CHARS;
}

// 是否启用（runtime.yaml `doc_sources.plaintext.enabled`，默认 false）。
// 读 config 而不是 env：这是「这套部署把不把一段话当需求」的产品决策，该和其它花钱开关放在一起。
function enabled(): boolean {
  try {
    return loadConfig().runtime.doc_sources?.plaintext?.enabled === true;
  } catch {
    return false; // 配置读不出来时保守当关（绝不因为配置坏了反而多花钱）
  }
}

export const plaintextDocs: DocSource = {
  id: PLAINTEXT_SOURCE,
  fallback: true, // 只有没人认领时才轮到；且 resolveClaims 最多取一条

  claim(input: DocClaimInput): DocRef[] {
    if (!enabled()) return [];
    // 只看正文：searchTexts 是 adapter 挖出来的**序列化事件**兜底块，把整坨 JSON 当需求正文是灾难。
    const norm = normalizePlaintext(input.text);
    if (!norm) return [];
    if (!hasSubstance(norm)) {
      // 不静默：让人能从日志看出「我们看见了，判它太短」，而不是什么都没发生。
      log.info(`plaintext：正文归一后不足 ${MIN_SUBSTANCE_CHARS} 字，不当作需求（"${norm.slice(0, 40)}"）`);
      return [];
    }
    return [{ source: PLAINTEXT_SOURCE, token: contentToken(norm), raw: norm }];
  },

  parseRef(urlOrToken: string): DocRef | null {
    if (!enabled()) return null;
    const s = (urlOrToken ?? '').trim();
    if (!s) return null;
    // 链接一律不收。没有任何主源认得的链接，八成是**我们读不了的**文档服务——
    // 把那串 URL 本身当成需求正文存下来，比直说「认不出」糟糕得多。
    if (/^https?:\/\//i.test(s)) return null;
    const norm = normalizePlaintext(s);
    if (!norm || !hasSubstance(norm)) return null;
    return { source: PLAINTEXT_SOURCE, token: contentToken(norm), raw: norm };
  },

  async read(ref: DocRef): Promise<DocReadResult> {
    // raw 只在 claim() → read() 这一趟里存在（它不落库）。拿一个**存量** plaintext ref 来重读，
    // 这里如实说读不了，而不是返回空正文装作读到了——上游据此停泊，人才看得见发生了什么。
    if (typeof ref.raw === 'string' && ref.raw.length > 0) return { ok: true, text: ref.raw };
    return {
      ok: false,
      text: '',
      error: 'plaintext 源不可回源：正文只在消息进来的那一趟里存在（需求正文已在建档时落到 prd.txt，此处无法重读）',
    };
  },

  // 没有 comment：一段 IM 文本无处回写批注。这是**能力缺口**，核心静默跳过（见 docs/index.ts commentDoc）。
};
