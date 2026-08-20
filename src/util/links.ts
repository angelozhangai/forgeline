// 从一段文本里抽飞书文档链接（wiki/docx/docs）。live 消息与离线补拉共用。
export function extractFeishuLinks(text: string): string[] {
  const re = /https?:\/\/[\w.-]*feishu\.[\w.-]+\/(?:wiki|docx|docs)\/[A-Za-z0-9]+/g;
  return Array.from(new Set(text.match(re) ?? []));
}
