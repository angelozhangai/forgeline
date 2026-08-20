// 从 LLM 文本输出里抽取 JSON：优先 fenced ```json，否则取平衡 {...}。
// 鲁棒性取舍：模型常在末尾给最终答案、偶尔嵌示例块，故**取最后一个**候选；
// 解析容忍尾随逗号 / BOM（先严后宽，第二次才宽松）。仍失败则抛，交 parseStructured 自愈。

// 从 start 处（必须是 '{'）扫一个平衡对象，返回其切片或 null。
function sliceBalancedFrom(text: string, start: number): string | null {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

// 全文里所有顶层平衡对象（跳过已消费的范围）。
function balancedObjects(text: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] === '{') {
      const slice = sliceBalancedFrom(text, i);
      if (slice) {
        out.push(slice);
        i += slice.length;
        continue;
      }
    }
    i++;
  }
  return out;
}

// 收集所有匹配围栏的内容（去首尾空白）。
function allFenced(text: string, re: RegExp): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(re)) out.push(m[1].trim());
  return out;
}

// 先严格解析；失败则去 BOM + 去尾随逗号再试一次。仍失败抛出。
function tolerantParse(s: string): unknown {
  const cleaned = s.replace(/^﻿/, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const noTrailing = cleaned.replace(/,(\s*[}\]])/g, '$1'); // , 后紧跟 } 或 ] → 去掉逗号
    return JSON.parse(noTrailing);
  }
}

export function extractJsonBlock(text: string): unknown {
  const jsonFences = allFenced(text, /```json\s*([\s\S]*?)```/gi);
  const fences = jsonFences.length ? jsonFences : allFenced(text, /```\s*([\s\S]*?)```/g);
  const candidates = fences.length ? fences : balancedObjects(text);
  if (!candidates.length) throw new Error('LLM 输出里找不到 JSON 块');
  // 取最后一个候选（最终答案常在末尾）。解析失败直接抛，绝不静默回退到更早的块（可能是示例/陈旧稿）。
  return tolerantParse(candidates[candidates.length - 1]);
}

// 容错读取 DB 里存的 JSON TEXT 列：脏值降级到 fallback，绝不让渲染/CLI 崩。
export function safeParse<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
