import type { State } from './statemachine/states.ts';

export interface Session {
  id: string;
  ref_num: number | null; // 人类可读需求编号序号 → 对外显示 REQ-<ref_num>（收到即分配，全程流转）
  slug: string;
  title: string;
  state: State;
  project_id: string; // 目标项目 id（Forge 服务的哪个项目；默认 'demo'）。入库时定，全程不变。
  branch: string; // 'main' | 'dev'
  prd_url: string | null;
  prd_text_path: string | null;
  feishu_chat_id: string | null;
  feishu_doc_token: string | null;
  poster_open_id: string | null; // 发 PRD 的产品的 open_id（群里 @TA 回复用）
  intake_msg_id: string | null; // PM 那条消息 id（bot 回复到它下面）
  status_msg_id: string | null; // bot 在群里那张状态卡 id（全程原地编辑）
  // 复杂度（相对估点，闸A 提议 + 人确认；全程流转、写进 issue、可加总工作量）
  size: string | null; // S|M|L|XL（对齐主仓 load-eval / size:* 标签）
  size_reason: string | null; // 定档一句理由
  size_source: string | null; // 'ai' | 'human'
  // PRD 质量评分（闸A·AI 产出）。⚠️ 私有：仅 `forge show`/`forge scores` 内部查询，绝不对外/不进交付文档（见 util/scoring.ts）
  prd_score: number | null; // 0-100 总分
  prd_score_dims: string | null; // json ScoreDims {clarity,completeness,feasibility,testability} 各 0-25
  prd_score_reason: string | null; // 扣分主因一句话
  // gate A
  gate_a_output_path: string | null;
  gate_a_session_id: string | null; // 自钉的 claude 会话号（首轮 --session-id 钉死，复评 --resume 续接，省 token）
  gate_a_round: number | null; // 当前评审轮次（1=首轮；PM 每答复一轮复评 +1）
  gate_a_pending_input: string | null; // PM 刚提交、待本轮复评消化的答复（消化后清空）
  gate_a_residual: string | null; // json：到上限仍未消解、交 M 裁决（PM 开放问题 或 codex 对抗 findings）
  gate_a_reviewer_session: string | null; // 闸A 对抗：codex thread_id（resume 续接）
  gate_a_fixer_session: string | null; // 闸A 对抗：claude 改方 session_id（续修 resume）
  gate_a_adv_round: number | null; // 闸A 对抗复审已完成轮次（与 PM 轮次 gate_a_round 分开计）
  gate_a_fix_fail_streak: number | null; // 连续 fix 调用失败计数（断路器；到 max_fix_failures → STALLED，成功清零）
  gate_a_cost_usd: number | null;
  repo_shas_a: string | null; // json {demo,example-web,example-admin}
  // triage
  routing: string | null; // json Routing
  // confirm
  confirmed_at: number | null;
  confirmed_by: string | null;
  confirmed_notes: string | null;
  // gate B
  gate_b_requested_by: string | null;
  gate_b_draft_path: string | null;
  issue_specs_path: string | null;
  repo_shas_b: string | null;
  adversarial_rounds: number | null; // 闸B 对抗复审最终轮次（复用为 review-fix 引擎 round）
  adversarial_residual: string | null; // json {round,used,verdict,findings[]} — 到上限仍未消解、交人工裁决的意见
  gate_b_cost_usd: number | null; // 累计 claude 改方成本（codex 评审无美元口径，token 另存）
  gate_b_reviewer_session: string | null; // codex thread_id（对抗复审 resume 续接）
  gate_b_fixer_session: string | null; // claude 改方 session_id（续修 resume）
  gate_b_round: number | null; // 对抗复审已完成轮次（驱动孤儿复位 + 卡片轮次展示）
  gate_b_fix_fail_streak: number | null; // 连续 fix 调用失败计数（断路器；到 max_fix_failures → STALLED，成功清零）
  gate_b_pending_input: string | null; // M 刚答复、待本轮续修消化的输入（消化后清空）
  gate_b_human_asks: string | null; // json HumanAsk[]：当前待 M 答复的升级问题
  gate_b_reviewer_tokens: string | null; // json {input,cachedInput,output}：codex 评审 token
  // 下游闸C（实现 + 本地CI；reviewer=确定性 CI/验收，无 codex 会话）
  gate_c_requested_by: string | null;
  gate_c_draft_path: string | null; // logs/<id>/gate-c.json（ImplementationEnvelope）
  gate_c_round: number | null; // 实现⇄CI 已完成轮次
  gate_c_fix_fail_streak: number | null; // 连续 fix 调用失败计数（断路器；到 max_fix_failures → STALLED，成功清零）
  gate_c_pending_input: string | null; // M 刚答复、待续做消化的输入
  gate_c_human_asks: string | null; // json HumanAsk[]：待 M 答复的实现升级问题
  gate_c_fixer_session: string | null; // claude 实现 session_id（续做 resume）
  gate_c_residual: string | null; // 到上限仍不绿的 CI/验收失败摘要（交 M 裁决）
  gate_c_cost_usd: number | null;
  // 下游闸D（PR 对抗 review + 测试补强 + merge readiness）
  gate_d_requested_by: string | null;
  gate_d_draft_path: string | null; // logs/<id>/gate-d.json
  gate_d_round: number | null;
  gate_d_fix_fail_streak: number | null; // 连续 fix 调用失败计数（断路器；到 max_fix_failures → STALLED，成功清零）
  gate_d_pending_input: string | null;
  gate_d_human_asks: string | null; // json HumanAsk[]
  gate_d_reviewer_session: string | null; // codex thread_id（审 diff，resume 续接）
  gate_d_fixer_session: string | null; // claude 改 worktree session_id
  gate_d_reviewer_tokens: string | null; // json {input,cachedInput,output}
  gate_d_residual: string | null;
  gate_d_cost_usd: number | null;
  gate_d_rollback_to: string | null; // 闸D 回滚失败毒丸：须复位到的绿 HEAD sha；置位⟺worktree 未确认态，进 loop 前必先复位确认
  gate_d_harden_round: number | null; // 测试补强已起轮次（>0 ⟺ 已进 GATE_D_HARDENING）
  gate_d_green_sha: string | null; // 闸D LGTM pin 的绿态 HEAD sha（补强基线，不可变）
  gate_d_harden_verified_sha: string | null; // 补强后 CI 绿的 HEAD sha（幂等 fast-path 守门）
  // worktree / PR / 合并
  target_repos: string | null; // json string[]：实现落哪些代码仓 dir 名（链式取 gate A repos_touched∩proj.repos；standalone 取 --repo）。空/缺→回退 proj.repos[0]
  legs: string | null; // json Leg[]：每仓一腿（worktree/分支/baseSha/CI/PR/闸D 全字段，见 src/gates/legs.ts）。单仓=1 腿；多仓每仓一树一PR
  worktree_path: string | null; // 隔离工作树绝对路径（经 proj.scripts.worktree_add 建；身份按 gateC.implIdentity 唯一派生）
  impl_branch: string | null; // 实现分支 = gateC.implIdentity() 安全 key：forge/<slug前缀>-<全id sha1>（基于唯一 id）
  base_shas: string | null; // json {repo: 建树时锚定的 origin/<base> sha}
  pr_url: string | null;
  pr_number: number | null;
  merge_readiness_path: string | null; // docs/delivery/<slug>/merge-readiness.md
  merged_by: string | null; // forge merged 确认人（→ SHIPPED）
  merged_at: number | null;
  // standalone 入口（裸 issue）+ 多租户预留
  source_kind: string | null; // 'prd'（上游链式）| 'issue'（standalone 直起闸C）
  issue_ref: string | null; // standalone 去重键：repo#n 或 issue URL
  tenant_id: string | null; // 多租户预留（本版不启用隔离逻辑）
  // assign（立项 DRI：自动 least-loaded+WIP 推荐 / 人工指定；写进 issue assignee）
  assignee: string | null; // 短码 M/EO/CC/DE
  assignee_source: string | null; // 'auto' | 'human'
  assigned_by: string | null;
  assigned_at: number | null;
  assign_snapshot: string | null; // json AssignSnapshot：算推荐时各人负载快照（纯展示）
  // go / writes
  go_by: string | null;
  go_at: number | null;
  created_issues: string | null; // json [{repo,number,url}]
  techdesign_branch: string | null;
  // bookkeeping
  error: string | null;
  // 重试簿记（节点失败自动退避重试 + 毒丸死信，见 orchestrator/retry.ts）
  retry_count: number | null; // 当前停泊态已用的瞬时错自动重试次数（成功推进即清 0）
  next_retry_at: number | null; // 瞬时错退避到点的时刻(毫秒)；置位⟺已排程自动重试
  reclaim_count: number | null; // 孤儿态(进程中途死)累计复位次数；防崩溃-重启无限环
  dead_letter: number | null; // 1=automation 放弃(重试/复位耗尽)，停泊待人工 retry 清
  // 多 runner 防重领（lease；见 store/sessions.ts leaseClaim + orchestrator/jobs/runner.ts）
  lease_owner: string | null; // 当前持有该 job 租约的 runner id（NULL=无主）
  lease_expires_at: number | null; // 租约到期时刻(ms)；< now 即可被其它 runner 重领（持有者疑似已死）
  created_at: number;
  updated_at: number;
}

export interface Routing {
  reviewer: string; // 短码 M/CC/...（或 'engineer' 表示 DRI 自评）
  reviewerLogin: string | null;
  toLead: boolean; // 是否升级给技术负责人
  reasons: string[];
  confidence: number;
}

export interface RepoShas {
  [repo: string]: string; // repo dir name → origin/<branch> sha
}

export interface CreatedIssue {
  repo: string;
  number: number;
  url: string;
}
