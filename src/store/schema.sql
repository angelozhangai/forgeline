-- Forge 状态库（node:sqlite）。json 字段以 TEXT 存。

CREATE TABLE IF NOT EXISTS session (
  id                   TEXT PRIMARY KEY,
  ref_num              INTEGER,
  slug                 TEXT NOT NULL,
  title                TEXT NOT NULL,
  state                TEXT NOT NULL,
  project_id           TEXT NOT NULL DEFAULT 'demo',  -- 目标项目 id（Forge 的哪个项目；入库定、不变）
  branch               TEXT NOT NULL,
  prd_url              TEXT,
  prd_text_path        TEXT,
  feishu_chat_id       TEXT,
  feishu_doc_token     TEXT,
  poster_open_id       TEXT,
  intake_msg_id        TEXT,
  status_msg_id        TEXT,
  size                 TEXT,
  size_reason          TEXT,
  size_source          TEXT,
  prd_score            INTEGER,  -- PRD 质量评分 0-100（闸A·AI 产出，私有，不对外）
  prd_score_dims       TEXT,     -- json {clarity,completeness,feasibility,testability} 各 0-25
  prd_score_reason     TEXT,     -- 扣分主因一句话
  gate_a_output_path   TEXT,
  gate_a_session_id    TEXT,
  gate_a_round         INTEGER,  -- 闸A 当前评审轮次（1=首轮；PM 每答复一轮复评 +1）
  gate_a_pending_input TEXT,     -- PM 刚提交、待本轮复评消化的答复（消化后清空）
  gate_a_residual      TEXT,     -- 到上限仍未消解、交 M 裁决（PM 开放问题 或 codex 对抗 findings，json）
  gate_a_reviewer_session TEXT,  -- 闸A 对抗：codex thread_id（resume 续接）
  gate_a_fixer_session    TEXT,  -- 闸A 对抗：claude 改方 session_id（续修 resume）
  gate_a_adv_round        INTEGER, -- 闸A 对抗复审已完成轮次（与 PM 轮次 gate_a_round 分开计）
  gate_a_fix_fail_streak  INTEGER, -- 连续 fix(claude) 调用失败计数（断路器；到 max_fix_failures → STALLED，成功清零）
  gate_a_cost_usd      REAL,
  repo_shas_a          TEXT,
  routing              TEXT,
  confirmed_at         INTEGER,
  confirmed_by         TEXT,
  confirmed_notes      TEXT,
  gate_b_requested_by  TEXT,
  gate_b_draft_path    TEXT,
  issue_specs_path     TEXT,
  repo_shas_b          TEXT,
  adversarial_rounds   INTEGER,
  adversarial_residual TEXT,
  gate_b_cost_usd      REAL,
  gate_b_reviewer_session TEXT,    -- codex thread_id（对抗复审 resume 续接，省 token）
  gate_b_fixer_session    TEXT,    -- claude 改方 session_id（续修 resume）
  gate_b_round            INTEGER, -- 闸B 对抗复审已完成轮次（1=首轮评审；每修订-复评 +1）
  gate_b_fix_fail_streak  INTEGER, -- 连续 fix(claude) 调用失败计数（断路器；到 max_fix_failures → STALLED，成功清零）
  gate_b_pending_input    TEXT,    -- M 刚答复、待本轮续修消化的输入（消化后清空）
  gate_b_human_asks       TEXT,    -- json HumanAsk[]：当前待 M 答复的升级问题（needs_human）
  gate_b_reviewer_tokens  TEXT,    -- json {input,cachedInput,output}：codex 评审 token（无美元口径，另存）
  -- ── 下游闸C：实现 + 本地CI（reviewer=确定性 CI/验收，无 codex 会话）──
  gate_c_requested_by  TEXT,
  gate_c_draft_path    TEXT,     -- logs/<id>/gate-c.json（ImplementationEnvelope 快照）
  gate_c_round         INTEGER,  -- 实现⇄CI 已完成轮次
  gate_c_fix_fail_streak INTEGER, -- 连续 fix(claude) 调用失败计数（断路器；到 max_fix_failures → STALLED，成功清零）
  gate_c_pending_input TEXT,     -- M 刚答复、待本轮续做消化的输入
  gate_c_human_asks    TEXT,     -- json HumanAsk[]：待 M 答复的实现升级问题
  gate_c_fixer_session TEXT,     -- claude 实现 session_id（续做 resume）
  gate_c_residual      TEXT,     -- 到上限仍不绿的 CI/验收失败摘要（交 M 裁决）
  gate_c_cost_usd      REAL,
  -- ── 下游闸D：PR 对抗 review + 测试补强 + merge readiness ──
  gate_d_requested_by  TEXT,
  gate_d_draft_path    TEXT,     -- logs/<id>/gate-d.json
  gate_d_round         INTEGER,
  gate_d_fix_fail_streak INTEGER, -- 连续 fix(claude) 调用失败计数（断路器；到 max_fix_failures → STALLED，成功清零）
  gate_d_pending_input TEXT,
  gate_d_human_asks    TEXT,
  gate_d_reviewer_session TEXT,  -- codex thread_id（审 diff，resume 续接）
  gate_d_fixer_session    TEXT,  -- claude 改 worktree session_id
  gate_d_reviewer_tokens  TEXT,  -- json {input,cachedInput,output}
  gate_d_residual      TEXT,
  gate_d_cost_usd      REAL,
  gate_d_rollback_to   TEXT,     -- 毒丸：闸D 改方回滚(reset --hard)失败时存「须复位到的绿 HEAD sha」；置位⟺worktree 处未确认态，下次进 loop 前必须先复位确认、绝不让 review-first 跑在未复位的树上
  gate_d_harden_round  INTEGER,  -- 测试补强（GATE_D_HARDENING）已起轮次：>0 ⟺ 已进补强阶段（planRetry 据此把 GATE_D_FAILED 回 HARDENING 而非白烧一轮 codex）
  gate_d_green_sha     TEXT,     -- 闸D codex LGTM 那一刻 worktree 的 pin 绿态 HEAD sha——补强基线只 reset 到此**不可变 sha**，绝不用移动 ref origin/<branch>（否则 harden 的对象 ≠ 被 codex 审过的对象）
  gate_d_harden_verified_sha TEXT, -- 补强后本地 CI 绿那一刻的 HEAD sha——幂等收尾 fast-path 据此校验「HEAD 仍是被验证的提交」才补推，绝不盲推未验证对象
  -- worktree / PR / 合并
  target_repos         TEXT,     -- json string[]：实现落哪些代码仓 dir 名（链式取 gate A repos_touched∩proj.repos；standalone 取 --repo）。空/缺→回退 proj.repos[0]
  legs                 TEXT,     -- json Leg[]：每仓一腿（worktree/分支/baseSha/CI/PR/闸D 全字段，见 src/gates/legs.ts）。单仓=1 腿；多仓每仓一树一PR
  worktree_path        TEXT,     -- 隔离工作树绝对路径（经 proj.scripts.worktree_add 建；身份按 session.id 唯一派生）
  impl_branch          TEXT,     -- 实现分支 = gateC.implIdentity() 派生的安全 key：forge/<slug前缀>-<全id sha1>（基于唯一 id，防同 slug 误删）
  base_shas            TEXT,     -- json {repo: 建树时锚定的 origin/<base> sha}
  pr_url               TEXT,
  pr_number            INTEGER,
  merge_readiness_path TEXT,     -- docs/delivery/<slug>/merge-readiness.md
  merged_by            TEXT,     -- forge merged 确认人（→ SHIPPED）
  merged_at            INTEGER,
  -- standalone 入口（裸 issue）+ 多租户预留
  source_kind          TEXT,     -- 'prd'（上游链式）| 'issue'（standalone 直起闸C）
  issue_ref            TEXT,     -- standalone 去重键：repo#n 或 issue URL
  tenant_id            TEXT,     -- 多租户预留（本版不启用隔离逻辑）
  assignee             TEXT,     -- 立项 DRI 短码（M/EO/CC/DE）；go 时写进 issue assignee
  assignee_source      TEXT,     -- 'auto'（算法推荐采纳）| 'human'（M 手动指定）
  assigned_by          TEXT,     -- 拍定指派的操作者
  assigned_at          INTEGER,
  assign_snapshot      TEXT,     -- json：算推荐时各人负载快照（供 GO 卡渲染理由，纯展示）
  go_by                TEXT,
  go_at                INTEGER,
  created_issues       TEXT,
  techdesign_branch    TEXT,
  error                TEXT,
  retry_count          INTEGER,  -- 当前停泊态已用的瞬时错自动重试次数（成功推进即清 0）
  next_retry_at        INTEGER,  -- 瞬时错退避到点的时刻(毫秒)；置位⟺已排程自动重试
  reclaim_count        INTEGER,  -- 孤儿态(进程中途死)累计复位次数；防崩溃-重启无限环
  dead_letter          INTEGER,  -- 1=automation 放弃(重试/复位耗尽)，停泊待人工 retry 清
  lease_owner          TEXT,     -- 多 runner 防重领：当前持有该 job 租约的 runner id（NULL=无主）
  lease_expires_at     INTEGER,  -- 租约到期时刻(ms)；< now 即可被其它 runner 重领（持有者疑似已死）
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_session_state ON session(state);
CREATE INDEX IF NOT EXISTS idx_session_slug ON session(slug);

CREATE TABLE IF NOT EXISTS event_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT NOT NULL,
  ts          INTEGER NOT NULL,
  kind        TEXT NOT NULL,
  detail      TEXT
);

CREATE INDEX IF NOT EXISTS idx_event_session ON event_log(session_id);
-- lastEventTs(session_id, kind) 的 MAX(ts) 去抖查询：复合索引让它走 index 求极值，不扫该 session 全部事件
-- （event_log 随每次 transition/事件增长，仅 session_id 索引时退化为按 kind 过滤的扫描）。
CREATE INDEX IF NOT EXISTS idx_event_session_kind_ts ON event_log(session_id, kind, ts);

-- 群消息补拉游标：每群一行，last_ts = 已处理到的消息 create_time(毫秒)。
-- 离线→开机后从 last_ts 拉群历史，补回漏掉的 PRD（详见 feishu/backfill.ts）。
CREATE TABLE IF NOT EXISTS chat_cursor (
  chat_id  TEXT PRIMARY KEY,
  last_ts  INTEGER NOT NULL
);

-- 健康滚动采样：守护每 ~60s 落一行，状态页画近 N 小时在线率 + 宕机/恢复事件时间线。
-- 按 health.history_retain_hours 剪枝（src/health/history.ts）。
CREATE TABLE IF NOT EXISTS health_sample (
  ts            INTEGER NOT NULL,   -- 采样时刻(毫秒)
  status        TEXT NOT NULL,      -- healthy | degraded | down
  ws            TEXT,               -- connected | disconnected | na
  db_ok         INTEGER,            -- 1/0
  active_gates  INTEGER,            -- 采样时活跃 gate 数
  detail        TEXT                -- json：各 check 摘要（排障用）
);

CREATE INDEX IF NOT EXISTS idx_health_sample_ts ON health_sample(ts);

-- 外部依赖「契约探针」最新结果：每依赖一行（codex/claude/gh/feishu），每日定时探测后 upsert。
-- ok=1 信封完好 / 0 漂移。存上次态供「翻转去抖」（持久漂移只告警一次），守护重启后回填缓存。
-- 有界 4 行，无需剪枝。详见 src/health/contract.ts、src/llm/probes.ts。
CREATE TABLE IF NOT EXISTS contract_probe (
  dep         TEXT PRIMARY KEY,   -- 'codex' | 'claude' | 'gh' | 'feishu'
  ok          INTEGER NOT NULL,   -- 1=信封完好，0=漂移
  detail      TEXT,               -- 人话一行
  raw         TEXT,               -- 截断的原始载荷（漂移时附上）
  checked_at  INTEGER NOT NULL    -- 探测时刻(毫秒)
);
