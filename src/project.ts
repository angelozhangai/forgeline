// 「目标项目」抽象：Forge 服务的一个项目（默认 example-project）。
// 封装所有【项目相关】的路径解析（root / scripts / docs/delivery / 子仓）。
// Forge 自身的路径（SVC_DIR / state / logs / config / prompts）见 src/root.ts，与项目无关。
//
// Stage 1（本提交）：仅默认项目，从 FORGE_PROJECT_ROOT / 兄弟 ../example-project 解析，
//   行为与旧 root.ts 完全一致。Stage 2 起引入 projects 注册表 + 每 session 绑定 project_id。
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url)); // <repo>/src
export const SVC_DIR = resolve(here, '..'); // Forge 服务仓根（与目标项目无关）

// 默认项目 id。Stage 2 起会有更多（projects 注册表的 key）。
export const DEFAULT_PROJECT_ID = 'demo';

// 默认目标项目根的解析顺序：
//   FORGE_PROJECT_ROOT 环境变量
//   → 兄弟 workspace/example-project
//   → 兜底：服务仍在「项目内 scripts/forge」布局时的项目根。
export function resolveDefaultRoot(): string {
  const explicit = process.env.FORGE_PROJECT_ROOT;
  if (explicit) return resolve(explicit);
  const sibling = resolve(SVC_DIR, '..', 'example-project'); // 默认目标项目
  if (existsSync(resolve(sibling, 'CLAUDE.md'))) return sibling;
  const inRepo = resolve(here, '..', '..', '..'); // 兜底：项目内 scripts/forge 布局
  if (existsSync(resolve(inRepo, 'CLAUDE.md'))) return inRepo;
  return sibling;
}

// 一个目标项目：id + 项目根，派生出 Forge 调用所需的全部项目内路径。
export interface Project {
  id: string;
  root: string;
  scriptsDir: string; // 机械动作脚本（review-req.sh / tech-design.sh / feishu-doc.js …）
  deliveryDir: string; // docs/delivery：交付物（req-review.md / tech-design.md …）
  repoPath(repo: string): string; // 项目内某子代码仓的绝对路径（闸A 真源）
  looksValid(): boolean; // 项目布局是否合理（doctor 用）
}

export function makeProject(id: string, root: string): Project {
  const scriptsDir = resolve(root, 'scripts');
  return {
    id,
    root,
    scriptsDir,
    deliveryDir: resolve(root, 'docs', 'delivery'),
    repoPath: (repo: string) => resolve(root, repo),
    looksValid: () =>
      existsSync(resolve(root, 'CLAUDE.md')) &&
      existsSync(resolve(scriptsDir, 'review-req.sh')) &&
      existsSync(resolve(scriptsDir, 'feishu-doc.js')),
  };
}

let _default: Project | undefined;
// 默认目标项目（懒解析 + 缓存）。首次调用时读环境/磁盘，与旧 ROOT 同时机（root.ts 在 import 期调用）。
export function defaultProject(): Project {
  if (!_default) _default = makeProject(DEFAULT_PROJECT_ID, resolveDefaultRoot());
  return _default;
}
