# deploy — Forge 常驻守护 (launchd) + 看门狗 + 飞书长连接 + 本地状态页

> **Forge** = 本服务的品牌/代号：把 PRD 锻造成技术方案/issue。launchd 标签 `com.forge.daemon` / `com.forge.watchdog`，启动器 `deploy/forge-daemon` / `deploy/forge-watchdog`。
>
> macOS「系统设置 → 登录项与扩展 → App 后台活动」里会出现 **forge-daemon / forge-watchdog · 身份不明的开发者**（脚本未做 Developer ID 签名，属正常）——**保持开关常开**即可（关掉 = 禁止 launchd 拉起，服务不再自启/常驻）。**不要**往「登录时打开」手动加东西：LaunchAgent 靠 `RunAtLoad` 在登录时自启，不走那个列表。

服务从「手动 `forge tick`」升级为「**常驻 daemon**:飞书长连接收卡片按钮/群消息 + 内置周期 tick + 出事/要你时主动私聊」。

## 一、daemon:`forge listen`

一个常驻进程,干三件事:
1. **飞书长连接**:收**卡片按钮回调**(确认/出方案/GO/打回/重跑)+ **群消息事件**(含 PRD 链接 → 自动 `addPrd`)。
2. **内置周期 tick**(每 `runtime.yaml: poll_interval_sec` 秒):推进闸A/闸B、孤儿态自愈。即便长连接没起也照跑。
3. **主动通知**:待确认/待GO/失败/完成/自愈 → 飞书私聊交互卡。

> 未配 `FEISHU_BOT_APP_*` 时自动降级:只跑周期 tick,无长连接(按钮/群入口不可用),通知走桌面+日志。

## 二、一键安装(守护 + 看门狗 + 状态页)

用 **LaunchAgent**(非 Daemon):登录态运行,有 login keychain → claude/codex/gh 凭据可用;注销/关机不跑。
两个任务:**守护**(`KeepAlive` 常驻 `forge listen`)+ **看门狗**(`StartInterval` 每 60s `forge watchdog`,救卡死)。

> **🧭 安装真源 = `/deploy-forge` skill（全新 Mac 从零部署）**:让 Claude Code / Codex 跑 **`/deploy-forge`** —— 它是逐步**阻断式**安装真源:每个前置(node≥24 / 主仓 / `forge.env` 密钥 / `claude`·`codex`·`gh` 登录 / 飞书后台见第三节)**卡一道闸**,带你填/装完、验证通过再放行,最后装 launchd 守护并收尾验证。**绝不替你输密钥**。
>
> **换电脑 / 旧宿主退役**：先停旧机 daemon/watchdog、在 Git 之外安全迁移密钥与 `state/` SQLite（如需),再从 Gate 0 严格安装——禁止两份独立 SQLite 同时消费同一生产入口。
>
> 机械部分由 **`./deploy/bootstrap.sh`** 自动做掉(node 检查 / 主仓检查 / `npm install` / 配置脚手架 / git hooks / `forge doctor` 预检);想手动跑就 `./deploy/bootstrap.sh`(准备+预检,不花钱),预检全绿后 `--install` 一键装。已部署过的机器直接用下面的 `install.sh`。

```bash
./deploy/bootstrap.sh      # 全新机器:准备 + 预检（不花钱）；--install 则预检全绿后顺手装
./deploy/install.sh        # 幂等:渲染 plist(替换路径占位) → bootstrap → enable;可重复跑
launchctl list | grep forge
tail -f logs/launchd.log   # 守护日志
tail -f logs/watchdog.log  # 看门狗日志
open http://127.0.0.1:4319/   # 本地状态页
```

停用 / 卸载:
```bash
./deploy/uninstall.sh      # 停并卸载两个任务;state/ 数据与 logs/ 保留
```

> plist 是**模板**(含 `__SVC__` 占位),由 `install.sh` 按当前仓根替换后安装——换机/换路径只要重跑 `install.sh`,不再手改硬编码路径。别直接 `cp` 模板。
> ⚠️ **自动 = 自动花钱**:群里发个 PRD 链接 → 下一拍自动跑闸A(~$1-2)。贵的闸B 仍要你点「出技术方案」按钮才跑,不会失控。

### 保活的两层:KeepAlive 救「死」,看门狗救「卡」

- **守护 plist**:`KeepAlive=true` 进程退出自动拉起;`ThrottleInterval=30` 防崩溃重启风暴。
- **但 `KeepAlive` 救不了「进程还活着但卡死」**——飞书长连接断、event loop 堵死、tick 锁僵死时进程都在,launchd 不会动。
- **看门狗**(独立进程,每 60s):探 `/healthz` + 读心跳 `liveness` + `launchctl` 状态 → 判定:
  - 进程没在跑 → `launchctl kickstart` 拉起 + 飞书告警。
  - 进程在跑但**卡死**(liveness 过期 + 探针连续失败到阈值):
    - **有 gate 在跑** → 先告警「暂缓强杀」,过宽限窗(`wedged_grace_sec`=300s)仍卡死才 `kickstart -k`——**避免打断 claude/codex 白烧 token**。重启后 orphan 自动回收。
    - 无 gate 在跑 → 立即 `kickstart -k` + 告警。
  - 恢复 → 「已恢复」告警。**去抖**:只在状态翻转时发,不每分钟刷屏。
  - 顺手轮转 `logs/launchd.log`(超 `health.log_rotate_mb`=20MB)。

参数都在 `config/runtime.yaml › health`,端口可被 `FORGE_HEALTH_PORT` 覆盖。手动活检:`./forge health`(加 `--json` 出结构化)。

## 三、⚠️ 飞书开发者后台需开(只有你能做,长连接收事件的前提)

在飞书开发者后台建一个企业自建应用(把 App ID/Secret 填进 `config/forge.env`),开这些后**发布新版**(企业自建需管理员审核生效):

1. **事件与回调 → 订阅方式 → 选「使用长连接接收事件/回调」**(不是 webhook URL)。
2. **订阅事件**:
   - `im.message.receive_v1`(接收消息 → 群消息入口)
   - 卡片回调(`card.action.trigger`,交互卡按钮)—— 开发者后台「卡片回传交互」/事件里勾选。
3. **权限**(权限管理 → 开通 → 发版):
   - 基础(收 @机器人 消息 + 发卡):`im:message.group_at_msg:readonly` + 已有 `im:message:send`。此档下 **PM 必须 @机器人** 才触发。
   - **PM 免 @ 入口**(直接贴链接即评审,体感更好):额外开 `im:message.group_msg`(收**非 @** 的群消息内容)。
     代码侧已就绪——adapter 设了 `policy.requireMention:false`(`src/messaging/feishu.ts`),`handleMessage` 只看有无飞书 doc 链接、不要求 @;**唯一前提就是这条 scope**(服务端不开则飞书根本不推非 @ 消息)。
   - **离线补拉**额外需 `im:message.history:readonly`(读群历史,断连/休眠期间漏的消息开机补回)。
   - 群消息入口还需把 **bot 拉进那个群**。
4. **私聊推送目标**已通(`union_id`,见 `config/forge.env`);观察群 `FEISHU_WATCH_CHATS`。

没开第 1/2 步:`forge listen` 仍跑(周期 tick + 私聊通知),但**按钮点了无反应、群消息收不到**。开了即生效(daemon 会自动收到回调)。

## 四、通知渠道与配置

`src/notify.ts` 统一出口:**bot 私聊卡片(2.0,带按钮) → webhook 兜底**;**桌面 + 日志永远兜底**。
- bot:`config/forge.env` 的 `FEISHU_BOT_APP_ID/SECRET` + `FEISHU_DM_UNION_ID`(已配)。
- 关桌面通知:`NOTIFY_DESKTOP=0`。

## 五、卡片驱动的全流程(按钮接通后)

```
群里发 PRD 链接 → 自动 addPrd → 闸A → 私聊「🔴 待确认」卡
  └ 选结论+批注+提交 → confirm → 「✅ 已确认」卡(带「🛠 出技术方案」按钮)
      └ 点「出技术方案」 → 闸B+对抗 → 「🟡 待 GO」卡(带「✅放行/❌驳回」)
          └ 点「放行」 → 建 issue → 「✅ 已建需求」卡(带链接)
失败任何一步 → 「❌ 失败」卡(带「🔁 重跑」)
```
全程在飞书私聊点按钮,不碰终端。

> 卡片对外用**人话**:每张卡头部 = **需求编号 `REQ-n` · 标题**,状态用「需求评审中 / 待产品确认 / 待出技术方案 / 待拍板立项」等(闸A/闸B 黑话只留代码内)。编号收到即分配、全程流转,并写进建出的 GitHub issue 正文。

## 六、可靠性:防休眠 · 自动备份 · 离线补拉

让"跑在随身笔记本上"也敢被人依赖,三道保障(均已内置,无需额外操作):

1. **防休眠**:`forge-daemon` 用 `caffeinate -is` 包住 daemon → Mac 醒着(在公司/家开着)就不空闲/系统休眠,长连接不断。
   > 合盖入包仍会睡(系统级,非 sudo 改不了);但醒来后**离线补拉**会补回那段时间的群消息,不漏需求。
2. **自动备份**:daemon 每小时把 `state/service.db` 在线备份(`node:sqlite` 原生 backup,持连接安全)到 `state/backups/`,留最近 14 份。启动也立刻备一份。
   - **恢复**(数据损坏/误删时):
     ```bash
     launchctl bootout gui/$(id -u)/com.forge.daemon        # 先停 daemon
     cp state/backups/service-<最近时间戳>.db state/service.db    # 用最近备份覆盖
     launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.forge.daemon.plist
     ```
3. **离线补拉**:关机/休眠期间飞书长连接不补推事件 → 开机/断线重连/每周期,daemon 用 `im.v1.message.list` 拉群历史,按 `chat_cursor` 水位把漏掉的 PRD 补登记。游标只前进 + 按 URL 去重 → 不漏不重。需 `im:message.group_msg` 权限(见三)。

## 七、本地状态页(类 status.claude.ai)

守护进程内嵌一个**仅绑 `127.0.0.1`** 的健康服务(零外部依赖,gate 跑期间也响应——claude/codex 是 async spawn 不堵 event loop)。

| 路由 | 用途 |
| --- | --- |
| `GET /` | 状态页 HTML:总状态横幅 + 组件健康灯 + 近 72h 在线率横条 + PRD 流水线看板(高亮卡住的 `AWAITING_*` / `*_FAILED`) |
| `GET /healthz` | 极简 `200 ok`(看门狗廉价探针) |
| `GET /health` | 实时健康 JSON(守护/长连接/DB/备份/依赖/磁盘/业务停泊) |
| `GET /api/board` | 看板数据(按状态分组 + 需关注 session) |
| `GET /api/history` | 滚动历史(在线率 + 宕机/恢复时间线;`?hours=72`) |

健康分级:`healthy`(全绿) / `degraded`(长连接断、依赖缺、备份停滞、磁盘紧、有 `*_FAILED`) / `down`(心跳缺失/卡死、DB 打不开、磁盘见底)。守护每 60s 落一行 `health_sample`(SQLite,按 `history_retain_hours` 剪枝),状态页据此画在线率;**总状态翻转**时守护自己发飞书(进程级宕机/卡死则由看门狗发,因为那时守护已发不出)。

打开:`open http://127.0.0.1:4319/`。

## 八、Mac mini 无人值守部署

1. **自动登录**:系统设置 → 用户与群组 → 自动以你的账户登录(LaunchAgent 需登录态 keychain 才有 claude/codex/gh 凭据;别用 LaunchDaemon)。
2. **防睡**:`forge-daemon` 已用 `caffeinate -is`;系统级再加 `sudo pmset -a sleep 0 disablesleep 1`(Mac mini 常插电,可一直醒)。
3. **装服务**:`./deploy/install.sh`(守护 + 看门狗 + git hook 一把装好)。
4. **远程看状态页**:不对外开端口——走 SSH 隧道在你本机看:
   ```bash
   ssh -L 4319:127.0.0.1:4319 mini   # 然后本机浏览器开 http://127.0.0.1:4319/
   ```
5. **告警通路**:确认 `config/forge.env` 的 `FEISHU_BOT_APP_*` + `FEISHU_DM_*` 已配——挂了/卡了/恢复都私聊推你。
6. **日志**:看门狗按大小轮转 `launchd.log`;想交系统统一管理见 `deploy/newsyslog/`(可选,需 sudo)。
