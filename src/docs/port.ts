// 文档层薄缝——**DocSourcePort**：核心与「需求文档从哪来」之间的唯一接口。
// 核心只认一个 provider 无关的 DocRef（哪个源 + 源内稳定 id），不认飞书 wiki/docx、不认 Notion page、
// 不认一段裸文本。每个源的 adapter（见 docs/<source>.ts）各自负责认领链接、读正文、（可选）回写批注。
//
// 为什么这条缝跟 MessagingPort **形状不同**：IM 是**选择**（一套部署只能有一个 IM，否则审批轨迹分叉），
// 文档源是**注册表**（同一条消息里可能同时贴飞书文档和 Notion 链接，都该被认领）。所以这里没有
// 「唯一 port 常量」，只有一份注册表 + 一套内容寻址的解析规则（见 docs/index.ts）。
// 一份需求文档的 provider 无关引用。
export interface DocRef {
  // 源 id（'feishu' / 'plaintext' / 'notion'…）。**不许含 ':'**——落库键是 `<source>:<token>`。
  source: string;
  // 源内稳定 id。同一份文档的各种 URL 变体（查询参数/末尾斜杠/分享后缀）必须归一到同一个 token，
  // 否则 PRD 级去重（红线）会漏。
  token: string;
  // 人能点开的链接。有的源没有（plaintext 就没有）→ 省略。仅用于展示 + 兼容旧的 prd_url 去重路径。
  url?: string;
  // **不落库**：claim() → read() 之间的搬运通道。用于「消息正文本身就是需求」这类不可回源的源
  // （plaintext）——它没有可以再读一次的远端，正文只在这一趟里存在。
  raw?: string;
}

export interface DocReadResult {
  ok: boolean;
  text: string;
  error?: string;
}

// claim() 的入参：一条 IM 消息的可搜文本面（正文 + adapter 挖出的兜底文本块）。
// 故意不是 InboundMessage：文档层不该知道 IM 的存在，只需要「一堆可以扫的文本」。
export interface DocClaimInput {
  text: string;
  searchTexts?: string[];
}

// 文档源契约探针结果（provider 无关，与 messaging 的 InboundProbe 同构）。
export interface DocProbe {
  available: boolean; // 凭据齐、能探
  ok: boolean; // 信封完好
  detail: string;
  raw?: string;
  kind?: 'auth' | 'drift'; // auth=凭据/权限/网络；drift=信封字段缺失
}

export interface DocSource {
  readonly id: string;
  // 兜底源：只有当**没有任何**非兜底源认领时才轮到它，且最多取一条。
  // 是**标志位、不是数组位置**——位置太脆：数组一重排，plaintext 就会把所有 Notion 链接吞掉。
  readonly fallback?: boolean;

  // 从一条消息里认领属于本源的文档（可能多份）。不认领 → 空数组。
  claim(input: DocClaimInput): DocRef[];
  // 把一个链接/裸 token 解析成本源的 ref（CLI `--prd <url>` 走这条）。不属于本源 → null。
  parseRef(urlOrToken: string): DocRef | null;
  // 读正文。失败**如实报错**（错误原文进 error），绝不返回空串装作读到了——上游据此停泊。
  read(ref: DocRef): Promise<DocReadResult>;
  // 回写批注（可选能力）。没有这个方法 = 该源不支持回写，核心静默跳过；
  // 有这个方法但调用失败 = 记日志（best-effort，不阻断闸）。
  comment?(ref: DocRef, text: string): Promise<{ ok: boolean; error?: string }>;
  // 契约探针（可选）：只读往返验自家 API 信封。**故意用本地形状**，跟 messaging 的 InboundProbe 一样——
  // 文档层不该 import llm/probes.ts 的 ProbeResult（那会把 ProbeDep 联合类型和一条 docs→llm 的依赖
  // 一起焊进来）。健康页长出「文档源」那一行时，由 llm/probes.ts 写薄壳映射，与 probeFeishu 同构。
  // 目前核心尚无消费方：声明在这里是让实现方现在就有地方放，而不是回头改接口。
  probe?(): Promise<DocProbe>;
}

// 落库键：`<source>:<token>`。带上源前缀是因为**跨源 token 会撞**——裸 token 做唯一索引，
// 迟早有两个源给出同一个字符串，然后两份毫不相干的需求被判成重复。
export function formatRef(ref: DocRef): string {
  return `${ref.source}:${ref.token}`;
}

// 反解落库键。按**第一个** ':' 切——token 里允许再出现 ':'（源 id 不允许）。
// 无前缀 / 空 source / 空 token 一律 null：宁可让调用方显式处理，也不猜一个源出来。
export function parseStoredRef(stored: string | null | undefined): DocRef | null {
  if (!stored) return null;
  const i = stored.indexOf(':');
  if (i <= 0 || i === stored.length - 1) return null;
  return { source: stored.slice(0, i), token: stored.slice(i + 1) };
}
