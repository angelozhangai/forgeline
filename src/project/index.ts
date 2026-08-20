// ProjectActions 选择点（唯一接线处）。核心只 `import { projectActions } from './project/index.ts'`，
// 永不直接调某个 adapter。当前唯一 adapter 是 demo 主仓脚本；将来按 proj 选 nativeGithub（直调 gh/API），
// 核心一行不动——同 messaging/index.ts 的 provider 选择点。
//
// 入参是已解析的 ProjectFull（调用方用 projectForSession(s) 拿，本就在手），故本模块**不**运行时依赖
// projects.ts——避开「mock projects.ts 缺 project 导出 → 导入期炸」那类测试脆裂（见 0.1b 教训）。
import { makeDemoScriptActions } from './actions.ts';
import { makeNativeGithubActions } from './github.ts';
import type { ProjectActions } from './actions.ts';
import type { ProjectFull } from '../projects.ts'; // type-only，运行时擦除

export function projectActions(proj: ProjectFull): ProjectActions {
  return proj.actions === 'native' ? makeNativeGithubActions(proj) : makeDemoScriptActions(proj);
}

export type { ProjectActions, ScriptResult, IssueWriteResult, PublishResult } from './actions.ts';
