import { loadConfig } from '../config.ts';
import { configForSession } from '../projects.ts';
import { hours } from '../util/time.ts';
import { log } from '../util/log.ts';
import { store as sessions } from '../store/index.ts'; // 经 SessionStore 接缝（选择点），不直连 store/sessions.ts
import * as cursors from '../store/cursors.ts';
import { tick } from '../orchestrator/worker.ts';
import { confirm, submitPmAnswers, requestGateB, submitGateBAnswers, forceGateBGo, go, deny, retry, composeHumanAnswer, postConfirmComment } from '../actions.ts';
import { readFileSync, existsSync } from 'node:fs';
import { parseHumanAsks, parseOpenQuestions, openQuestionsToDecisions, composeDecisionAnswer } from '../gates/envelopes.ts';
import { addPrd } from '../intake.ts';
import { backfillAll } from '../messaging/backfill.ts'; // provider 无关的补拉循环（历史那一次 API 往返在 adapter 里）
import { maybeBackup } from '../store/backup.ts';
import { notify, syncGroupCard } from '../notify.ts';
import { port } from '../messaging/index.ts';
import { resolveActor } from '../messaging/operators.ts';
import type { CardModel } from '../messaging/index.ts';
import { claimDocs } from '../docs/index.ts';
import { ACTIVE_GATE_STATES } from '../statemachine/states.ts';
import { healthConfig } from '../health/config.ts';
import { initHeartbeat, pingLiveness, markCycle, markWs } from '../health/heartbeat.ts';
import { startHealthServer } from '../health/server.ts';
import { startControlServer } from '../control/server.ts';
import { evaluateHealth } from '../health/check.ts';
import { recordSample } from '../health/history.ts';
import { sendHealthAlert } from '../health/alert.ts';
import { runContractProbes } from '../health/contract.ts';
import { allProbes, startupProbeDue } from '../store/contract.ts';

async function ack(text: string): Promise<void> {
  await port.sendDmText('⏳ 处理中', [text], 'grey').catch(() => undefined);
}

async function handleCardAction(evt: Record<string, unknown>): Promise<void> {
  // 入站解析交给 adapter：把飞书原始事件规整成 provider 无关的 {action, slug, value, formValues}。
  const parsed = port.parseCardAction(evt);
  if (!parsed) {
    log.warn('cardAction 缺 action/slug（无法识别的回调）');
    return;
  }
  const { action: act, slug } = parsed;
  // 操作者身份：把飞书 open_id 映射成短码，权限闸按真实点击人裁决（未配 operators → 回退 M，单人沿用旧行为）。
  // operators 取**该需求所属项目**的覆盖（配置分化：项目可有自己的 open_id→短码映射，且 map 合并保留全局）；
  // 找不到 session/项目未覆盖 → 回退全局。否则项目级真实点击人会被错当全局/单人 M（Codex Blocker）。
  const cardSession = await sessions.resolve(slug);
  const operators = (cardSession ? configForSession(cardSession) : loadConfig()).permissions.operators ?? {};
  const actor = resolveActor(parsed.operatorId, operators);
  log.info(`cardAction: ${act} ${slug} by=${actor}`);
  try {
    if (act === 'confirm_submit') {
      // PM 在群里提交答复。注意：PM「答复」不等于「定案」——答复回喂同一 claude 会话做下一轮复评
      // （闸A 多轮循环）；评审何时结束由 claude（无剩余开放问题）或 M（强制结束）决定，PM 无权结束。
      const fv = parsed.formValues;
      const verdict = fv.verdict || 'accept';
      // 逐条收集：每个 open_question 的下拉选择（ask_<id>）+ 整体结论 + 全局补充，结构化拼成一段答复。
      // 读 gate-a.json 取同一份 open_questions（与卡片渲染同源）→ answerableDecisions 保证选项↔问题对齐。
      const before = await sessions.resolve(slug);
      const oqRaw = before?.gate_a_output_path && existsSync(before.gate_a_output_path) ? readFileSync(before.gate_a_output_path, 'utf8') : '';
      const items = openQuestionsToDecisions(parseOpenQuestions(oqRaw));
      const answerBody = composeDecisionAnswer(items, fv); // 逐条选择 + 全局补充（无 verdict 前缀）——PRD 留痕用
      const note = composeDecisionAnswer(items, fv, verdict).trim(); // 回喂复评（含整体结论框架）
      // 提交按钮防二次点击：靠下面 syncGroupCard 把带表单的群卡换成「复评中·第N轮」无按钮卡。
      // 兜底：SDK 去重(12h)+ submitPmAnswers 幂等(REVISION_REQUESTED 重入)+ 失败分支也刷新群卡。
      const r = await submitPmAnswers(slug, 'PM', note || undefined);
      const s = await sessions.resolve(slug);
      if (r.ok && s) {
        // PRD 留痕取结构化答复（含逐条下拉选择），而非仅自由文本——否则 PM 只点下拉时留痕成「批注：（无）」。
        postConfirmComment(s, { who: 'PM', verdict, notes: answerBody });
        await syncGroupCard(s); // 群卡 → 「复评中·第N轮」（去掉残留表单）
        await tick(); // 立即跑复评；tick 内据结果再发 needs_confirm（下一轮）/ needs_gateb（完成）/ needs_arbitration（停泊）
      } else {
        if (s) await syncGroupCard(s); // 失败也刷新群卡，避免旧表单/按钮滞留
        await ack(`提交失败：${r.msg}`);
      }
      return;
    }
    if (act === 'force_confirm') {
      // M 在「待裁决」卡上强制结束评审（PM 无此按钮）。
      const r = await confirm(slug, actor);
      const s = await sessions.resolve(slug);
      if (r.ok && s) await notify('needs_gateb', s);
      else await ack(`强制通过失败：${r.msg}`);
      return;
    }
    if (act === 'gateb') {
      await ack(`闸B 排队中：${slug}（出方案 + Codex⇄Claude 多轮对抗，约数分钟）…`);
      const r = await requestGateB(slug, actor);
      if (!r.ok) await ack(r.msg);
      await tick(); // 立即推进闸B
      return;
    }
    if (act === 'gateb_answer_submit') {
      // M 在「方案待拍板」卡上提交决定 → 回喂同一 claude 会话续修（闸B 多轮人在环）。
      // 读各下拉选择(ask_*) + 补充说明(notes)，按 id 结构化拼回喂；全空时 submitGateBAnswers 兜「再修一轮」。
      const fv = parsed.formValues;
      const before = await sessions.resolve(slug);
      const asks = before ? parseHumanAsks(before.gate_b_human_asks) : [];
      const answer = composeHumanAnswer(asks, fv).trim();
      const r = await submitGateBAnswers(slug, actor, answer || undefined);
      const s = await sessions.resolve(slug);
      if (r.ok && s) {
        await syncGroupCard(s); // 群卡 → 「依答复修订方案中」（去掉残留表单）
        await tick(); // 立即续修；tick 内据结果再发卡（下一轮升级 / 待 GO / 停泊裁决）
      } else {
        if (s) await syncGroupCard(s);
        await ack(`提交失败：${r.msg}`);
      }
      return;
    }
    if (act === 'gateb_force_go') {
      // M 在「方案待裁决」卡上强制立项 → AWAITING_GO（内含算自动指派推荐）。
      const r = await forceGateBGo(slug, actor);
      const s = await sessions.resolve(slug);
      if (r.ok && s) await notify('needs_go', s);
      else await ack(`强制立项失败：${r.msg}`);
      return;
    }
    if (act === 'gateb_send_back') {
      // M 在「方案待裁决」卡上选「再修一轮」→ 续修点。
      const r = await submitGateBAnswers(slug, actor, '再修一轮（M 未给具体批注）');
      const s = await sessions.resolve(slug);
      if (r.ok && s) {
        await syncGroupCard(s);
        await tick();
      } else {
        await ack(`再修失败：${r.msg}`);
      }
      return;
    }
    if (act === 'go') {
      // GO 卡 go_form 提交：form_value.assignee = 选定 DRI（默认推荐人，可下拉改）。
      const fv = parsed.formValues;
      const assignee = (fv.assignee ?? '').trim() || undefined;
      await ack(`建需求中：${slug}${assignee ? `（指派 ${assignee}）` : ''}…`);
      const r = await go(slug, actor, assignee ? { assignee } : {}); // 成功/写阶段失败各自发卡
      // 预检拒绝（权限/lint/未指派 DRI）不会自发卡——仍停在 GO 待办态，于此回执让 M 知道为何没建。
      if (!r.ok) {
        const st = (await sessions.resolve(slug))?.state;
        if (st === 'AWAITING_GO' || st === 'GO_DENIED') await ack(r.msg);
      }
      return;
    }
    if (act === 'deny') {
      const r = await deny(slug, actor); // 无权限/状态不符 → 不真打回，回执原因（别假报「已打回」）
      await ack(r.ok ? `已打回 ${slug}` : r.msg);
      return;
    }
    if (act === 'retry') {
      const r = await retry(slug, actor); // 无权限/无可重试态 → 不真重置，回执原因（别假报「已重置」）
      if (!r.ok) {
        await ack(r.msg);
        return;
      }
      await ack(`已重置 ${slug}，重跑中…`);
      await tick();
      return;
    }
    log.warn(`未知 cardAction：${act}`);
  } catch (e) {
    log.err(`cardAction 处理失败：${String(e).slice(0, 200)}`);
    await ack(`处理失败：${String(e).slice(0, 160)}`);
  }
}

export const __handleCardActionForTest = handleCardAction;

// 重复 PRD 提醒卡（灰头，回复 PM 那条；无 msgId 则发到群）。best-effort，失败只记日志不阻断。
async function replyDuplicate(intakeMsgId: string | undefined, chatId: string, notice: string): Promise<void> {
  const card: CardModel = { color: 'grey', title: '🔁 重复提交', blocks: [{ kind: 'text', md: notice }] };
  try {
    if (intakeMsgId) await port.replyGroupCard(intakeMsgId, card);
    else if (chatId) await port.sendGroupCard(chatId, card);
  } catch (e) {
    log.warn(`重复 PRD 回复失败(不影响去重)：${String(e).slice(0, 120)}`);
  }
}

async function handleMessage(evt: Record<string, unknown>): Promise<void> {
  // 入站解析交给 adapter：把飞书原始事件规整成 provider 无关的 InboundMessage（text + searchTexts 候选）。
  const m = port.parseMessage(evt);
  if (!m) return;
  const chatId = m.chatId;
  const createTime = m.createTime; // adapter 已兜 now()（缺 createTime 不塞 0，避免水位插到 epoch）
  const posterId = m.senderId;
  const intakeMsgId = m.messageId;
  const text = m.text;
  // 群消息入口闸：群里**只有 @机器人**才入流程——否则群内随手分享/转发的飞书文档会被误当 PRD 吃进闸A（白花钱）。
  // 判定材料由 adapter 从事件里**服务端填充的 mentions** 算好（isGroup/mentionedBot，独立于 SDK 正文 @ normalize）。
  // p2p 私聊（isGroup 假）天然定向，不要求 @。无法确认 bot 身份（mentionedBot=null）→ 保守忽略并 warn（不静默放过）。
  if (m.isGroup && m.mentionedBot !== true) {
    if (m.mentionedBot === null) {
      log.warn(`消息入口：群消息但无法确认 bot 身份（${port.id} 未配 bot 自身 id）→ 保守忽略此消息`);
    } else {
      log.info('消息入口：群消息未 @机器人 → 按规则忽略（不入流程）');
    }
    if (chatId) cursors.advanceCursor(chatId, createTime); // 仍推进水位，避免重连后反复重拉这条非 @ 消息
    return;
  }
  // 链接常不在纯文本里（文档分享卡片 / 富文本 post）——adapter 把这些结构挖成 searchTexts 候选，
  // 交给**文档源注册表**认领（谁认得出就归谁；一个都不认才轮到兜底源）。核心不知道任何一种链接长什么样。
  const docs = claimDocs({ text, searchTexts: m.searchTexts });
  if (process.env.FORGE_WS_DEBUG === '1') {
    log.info(`消息入口收到：chat=${chatId} docs=${docs.length} text="${text.slice(0, 80)}" evt=${JSON.stringify(evt).slice(0, 700)}`);
  }
  if (docs.length === 0) {
    log.warn('消息入口：没有任何文档源认领这条消息，忽略');
  } else {
    for (const doc of docs) {
      const r = await addPrd({ doc, chatId: chatId || undefined, posterId, intakeMsgId });
      if (r.ok && r.session) {
        if (r.created) {
          log.ok(`消息入口：登记 ${r.session.slug}`);
          await syncGroupCard(r.session); // 立刻在群里回复 PM 那条、发/刷新状态卡（即时反馈）
        } else {
          // PRD 级去重：同一需求重复提交 → 明确回复 PM「已评审过，本次不再评审」，不重复建需求。
          log.info(`消息入口：重复 PRD（${r.session.slug}，${r.session.state}）→ 回复 PM`);
          await replyDuplicate(intakeMsgId, chatId, r.msg);
        }
      } else {
        log.warn(`消息入口：登记失败 ${r.msg}`);
      }
    }
    await tick(); // 立即跑闸A
  }
  // 推进该群水位（含无链接消息）→ 登记群供 backfill + 避免重连后重复补拉本条。
  if (chatId) cursors.advanceCursor(chatId, createTime);
}

export const __handleMessageForTest = handleMessage;

// 全局崩溃安全网（长驻 daemon 专用，CLI 一次性命令不需要）。分两类语义：
// - unhandledRejection：单个漏网 promise 通常不污染全局状态 → log + 私聊告警 M + **续跑**（绝不静默吞，符合「失败不静默」）。
// - uncaughtException：进程状态已不可信（Node 官方明确续跑不安全）→ log + 告警 + **退出**，
//   交 launchd KeepAlive 干净重启；崩溃残留的孤儿态由 reclaimOrphans + 毒丸保护回收。
// 与既有「保活两层（看门狗救卡死 / launchd 救死）」互补：这条专救「event handler 里漏网的异步抛」。
function installCrashHandlers(): void {
  process.on('unhandledRejection', (reason) => {
    const msg = String((reason as { stack?: string } | undefined)?.stack ?? reason).slice(0, 400);
    log.err(`unhandledRejection（已捕获，daemon 续跑）：${msg}`);
    void port.sendDmText('⚠️ unhandledRejection（daemon 续跑）', [msg], 'red').catch(() => undefined);
  });
  process.on('uncaughtException', (err) => {
    const msg = String(err?.stack ?? err).slice(0, 400);
    log.err(`uncaughtException（进程状态不可信，优雅退出待 launchd 重启）：${msg}`);
    // 告警尽力而为：给 1.5s 让飞书把卡片发出去，无论成败都退出（不长期阻塞在不可信状态里）。
    const bail = (): never => process.exit(1);
    const t = setTimeout(bail, 1500);
    void port
      .sendDmText('🔴 uncaughtException（守护重启中）', [msg], 'red')
      .catch(() => undefined)
      .finally(() => {
        clearTimeout(t);
        bail();
      });
  });
}

export async function listen(): Promise<void> {
  installCrashHandlers();
  const cfg = loadConfig();
  const intervalMs = Math.max(30, cfg.runtime.poll_interval_sec || 180) * 1000;

  // 保活/健康：起心跳 + 本地状态页 + liveness ping + 健康采样。
  const hcfg = healthConfig();
  initHeartbeat({ pid: process.pid, port: hcfg.port, wsConfigured: port.inboundConfigured(), now: Date.now() });
  startHealthServer(hcfg.port);
  // 控制面/Runner 分离：本机当**控制面**时同进程起控制面 HTTP（/jobs+/store），让 `forge listen` 一个进程 =
  // 编排（reclaim/retry/autonomy/remind/sweep/drift，见 worker.tick）+ 自身 job loop + 服务额外 runner——
  // 单 sqlite 连接、无多进程争用。这才是「控制面进程跑全 tick + 服务」可运行的真身（额外 runner 设 FORGE_CONTROL_URL
  // 只跑 job loop）。仅当配 FORGE_CONTROL_PORT 且本机**非纯 runner**（未设 FORGE_CONTROL_URL）才起；纯 runner 当
  // server 会被 startControlServer fail-closed② 拦。默认（未配 PORT）不起，行为零变更。
  if (process.env.FORGE_CONTROL_PORT && !process.env.FORGE_CONTROL_URL) {
    try {
      await startControlServer({
        port: Number(process.env.FORGE_CONTROL_PORT) || 4320,
        host: process.env.FORGE_CONTROL_HOST || '127.0.0.1',
        token: process.env.FORGE_CONTROL_TOKEN || undefined,
      });
    } catch (e) {
      // fail-fast：配了控制面端口却绑不上 = 半启动（health/tick 活着但 /jobs+/store 不可用、额外 runner 拉不到 job）。
      // 硬退（health server 已起会留住 event loop，单靠 exitCode 退不掉）→ launchd 重启；端口持续被占则**响亮地反复失败**，
      // 暴露误配，绝不静默以「无控制面」形态活着。
      log.err(`控制面 HTTP 启动失败，拒绝以「无控制面」形态运行：${String(e).slice(0, 200)}`);
      process.exit(1);
    }
  }
  // liveness ping：gate 是 async spawn 不堵 event loop，此快 ping 是真·判活信号（看门狗据此判卡死）。
  const pingHealth = async (): Promise<void> => {
    try {
      const active = await sessions.countByStates([...ACTIVE_GATE_STATES]);
      pingLiveness(Date.now(), active);
    } catch {
      /* ping 尽力而为 */
    }
  };
  void pingHealth();
  setInterval(() => void pingHealth(), hcfg.livenessPingSec * 1000);
  // 健康采样：落滚动历史；总状态翻转时发飞书（守护活着才发——进程级宕机由看门狗负责）。
  const sampleHealth = async (): Promise<void> => {
    try {
      const report = await evaluateHealth(Date.now());
      const { flipped, prev } = recordSample(report, hcfg.historyRetainHours);
      if (flipped && prev) {
        if (report.status === 'healthy') {
          await sendHealthAlert('recovered', '服务已恢复', [`从「${prev}」恢复正常。`]);
        } else {
          const lines = report.checks
            .filter((c) => c.status === 'down' || c.status === 'degraded')
            .map((c) => `- **${c.name}**：${c.detail}`);
          await sendHealthAlert(report.status === 'down' ? 'down' : 'degraded', report.status === 'down' ? '服务异常' : '服务降级', lines.length ? lines : ['（无明细）']);
        }
      }
    } catch (e) {
      log.warn(`健康采样失败：${String(e).slice(0, 140)}`);
    }
  };
  setInterval(() => void sampleHealth(), hcfg.sampleIntervalSec * 1000);

  // 外部依赖契约：每日带外主动探测（codex/claude 升级会悄悄改输出 schema，发生在我们提交之外）。
  // 探针付费（codex+claude 各一发 trivial），故仅每 contract_interval_hours 跑一次；漂移翻转去抖后私聊告警。
  if (hcfg.contractCheckEnabled) {
    const contractDaily = async (): Promise<void> => {
      try {
        await runContractProbes(Date.now());
      } catch (e) {
        log.warn(`契约探测失败：${String(e).slice(0, 140)}`);
      }
    };
    // 启动即跑一次（状态页/doctor 不显「尚未探测」），但**按 checked_at 节流**：最近一次探测在间隔内则跳过，
    // 防 daemon 崩溃重启循环时每次启动都付费探一次（contract 探测是付费 claude+codex 调用）。
    if (startupProbeDue(allProbes(), Date.now(), hours(hcfg.contractIntervalHours))) {
      void contractDaily();
    } else {
      log.info(`外部契约最近一次探测在 ${hcfg.contractIntervalHours}h 内，启动跳过（防崩溃重启反复付费探测；状态页仍显示上次结果）`);
    }
    setInterval(() => void contractDaily(), hours(hcfg.contractIntervalHours));
    log.ok(`外部契约每日探测已启动（每 ${hcfg.contractIntervalHours}h）`);
  }

  // 内置周期循环：先补拉离线期间群消息(backfill)，再推进闸处理(tick)。即便长连接没起也不停。
  const runCycle = async (): Promise<void> => {
    let ok = true;
    try {
      await backfillAll();
    } catch (e) {
      log.err(`补拉失败：${String(e).slice(0, 160)}`);
    }
    try {
      await tick();
    } catch (e) {
      ok = false;
      log.err(`周期 tick 失败：${String(e).slice(0, 160)}`);
    }
    await maybeBackup(Date.now()).catch(() => undefined); // 每小时一份在线备份(内部 throttle)
    markCycle(Date.now(), ok);
  };
  void runCycle();
  const timer = setInterval(() => void runCycle(), intervalMs);
  log.ok(`周期循环已启动（补拉 + tick，每 ${intervalMs / 1000}s）`);

  if (!port.inboundConfigured()) {
    log.warn(`未配置入站传输（${port.id} bot 凭据缺失）→ 仅周期 tick，无长连接（卡片按钮/群消息入口不可用）`);
    await new Promise(() => {}); // 常驻
    return;
  }

  // 长连接交给 adapter（port.startInbound 内建 channel + 收发）；core 只接 provider 无关回调，
  // markWs(健康判活) / runCycle(补拉) 留在 core——adapter 不碰任何健康/业务概念。
  const channel = port.startInbound({
    onCardAction: (raw) => {
      markWs(true, Date.now());
      void handleCardAction(raw);
    },
    onMessage: (raw) => {
      markWs(true, Date.now());
      void handleMessage(raw);
    },
    onError: (reason) => {
      markWs(false, Date.now());
      log.err(`长连接错误：${reason.slice(0, 200)}`);
    },
    // 断线重连后立即补拉断连期间漏掉的群消息（长连接不补推历史事件）。
    onReconnected: () => {
      markWs(true, Date.now());
      log.ok('长连接已重连 → 补拉断连期间群消息');
      void runCycle();
    },
  });

  try {
    await channel.connect();
    markWs(true, Date.now());
    log.ok(`${port.id} 长连接已建立（卡片按钮回调 + 群消息入口已就绪）`);
    void runCycle(); // 开机首次：立即捞离线期间 PM 发的需求
  } catch (e) {
    markWs(false, Date.now());
    log.err(`长连接建立失败：${String(e).slice(0, 200)}（检查 ${port.id} 后台的事件订阅/长连接是否已开，见 deploy/README）。仅周期 tick 继续。`);
  }
  // 常驻：长连接事件 + 周期 tick
  await new Promise(() => {});
  clearInterval(timer); // 不会到达，留作语义完整
}
