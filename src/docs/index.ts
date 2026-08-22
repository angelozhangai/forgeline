// 文档层薄缝——**注册表与唯一接线处**。核心（intake / gates / actions / listen / backfill）
// 只 import 本文件，永不直接依赖某个具体文档源。
//
// 为什么是注册表而不是「选择点」（对比 messaging/index.ts 的 `port`）：一套部署只能有一个 IM
// （否则审批轨迹分叉），但同一条消息里完全可能同时贴飞书文档和别的源的链接——文档源天然是**多个并存**，
// 靠内容寻址（谁认得出就归谁）而不是靠配置选一个。
import { log } from '../util/log.ts';
import { feishuDocs } from './feishu.ts';
import { plaintextDocs } from './plaintext.ts';
import { formatRef, parseStoredRef, type DocClaimInput, type DocReadResult, type DocRef, type DocSource } from './port.ts';

export { formatRef, parseStoredRef };
export type { DocRef, DocReadResult, DocSource, DocClaimInput } from './port.ts';

// 已注册的文档源。加一个源 = 在这里加一行（外加它自己的 docs/<id>.ts），核心其余部分一行不动。
// plaintext 是**兜底源**（fallback:true）且默认关——它排在最后只是可读性，真正决定顺位的是那个标志位。
const REGISTERED: DocSource[] = [feishuDocs, plaintextDocs];

export function sources(): DocSource[] {
  return [...REGISTERED];
}

export function sourceById(id: string): DocSource | null {
  return REGISTERED.find((s) => s.id === id) ?? null;
}

// 认领一条消息里的需求文档 —— **规则本身**（纯函数，对任意源列表成立）。
// 非兜底源取**并集**（一条消息里贴了两个源的链接，两份都该进）；一个都没认领时才轮到兜底源，
// 且**最多取一条**（兜底源认的是「正文本身就是需求」这类，多取只会把同一段话拆成好几个需求）。
// fallback 是标志位而非数组位置——位置太脆，一重排就会让兜底源把别人的链接全吞了。
export function resolveClaims(list: DocSource[], input: DocClaimInput): DocRef[] {
  const primary: DocRef[] = [];
  const seen = new Set<string>();
  for (const s of list) {
    if (s.fallback) continue;
    for (const ref of s.claim(input)) {
      const key = formatRef(ref);
      if (seen.has(key)) continue; // 同一份文档被同源多次认领（正文 + 兜底块都出现）→ 只留一份
      seen.add(key);
      primary.push(ref);
    }
  }
  if (primary.length) return primary;
  for (const s of list) {
    if (!s.fallback) continue;
    const [first] = s.claim(input);
    if (first) return [first];
  }
  return [];
}

// 把一个链接/裸 token 解析成 DocRef —— **规则本身**。非兜底源先问，都不认再问兜底源。
// 谁都不认 → null，由调用方**显式报错**（绝不猜一个源出来，猜错就是把需求登记到读不出正文的源上）。
export function resolveRef(list: DocSource[], urlOrToken: string): DocRef | null {
  for (const s of list) {
    if (s.fallback) continue;
    const ref = s.parseRef(urlOrToken);
    if (ref) return ref;
  }
  for (const s of list) {
    if (!s.fallback) continue;
    const ref = s.parseRef(urlOrToken);
    if (ref) return ref;
  }
  return null;
}

// 上面两条规则**接到真实注册表上**。规则与接线分开，是为了让「多源怎么解析」能被真正单测——
// 否则测试只能对着唯一一个已注册源自说自话，或者复制一份规则来测（那测的是副本，不是实现）。
export function claimDocs(input: DocClaimInput): DocRef[] {
  return resolveClaims(REGISTERED, input);
}

export function parseAnyRef(urlOrToken: string): DocRef | null {
  return resolveRef(REGISTERED, urlOrToken);
}

// 已注册源的 id 列表（报错文案用：告诉人「现在认得哪些源」，而不是干巴巴一句无法识别）。
export function registeredIds(): string[] {
  return REGISTERED.map((s) => s.id);
}

// 读正文。未注册的源 → **如实报错**，绝不静默当成读失败或空文档（库里存着一个没人认领的 ref，
// 通常意味着配置被改小了/源被摘掉了，这必须看得见）。
export async function readDoc(ref: DocRef): Promise<DocReadResult> {
  const s = sourceById(ref.source);
  if (!s) return { ok: false, text: '', error: `未注册的文档源「${ref.source}」（已注册：${registeredIds().join('/') || '无'}）` };
  return s.read(ref);
}

// 回写批注（best-effort，绝不阻断闸）。三种结局分得很清楚：
//  · 源不支持回写（没有 comment 方法）= 能力缺口，静默跳过——回写从来就只是锦上添花；
//  · 源支持但这次失败 = **记日志**（失败不静默）；
//  · 库里的 ref 解析不出 / 源没注册 = 记日志。
export async function commentDoc(storedRef: string | null | undefined, text: string): Promise<void> {
  const ref = parseStoredRef(storedRef);
  if (!ref) return; // 没有文档来源（手动 add / standalone issue）→ 本就无处可写
  const s = sourceById(ref.source);
  if (!s) {
    log.warn(`文档批注跳过：未注册的文档源「${ref.source}」`);
    return;
  }
  if (!s.comment) return; // 能力缺口：该源不支持回写
  try {
    const r = await s.comment(ref, text);
    if (!r.ok) log.warn(`文档批注失败（${ref.source}）：${(r.error ?? '').slice(0, 200)}`);
  } catch (e) {
    log.warn(`文档批注异常（${ref.source}）：${String(e).slice(0, 200)}`);
  }
}
