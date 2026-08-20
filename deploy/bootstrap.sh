#!/bin/zsh
# Forge bootstrap：把一台新 Mac 从「刚 clone」带到「守护跑起来」。幂等可重跑。
# 自动化一切机械步骤（node / npm / 配置脚手架 / git hooks / 主仓检查 + doctor 预检）；
# 密钥、CLI 登录、飞书开发者后台这些不可自动化的内核——卡在检查点，由 doctor 报清单，
# 人补完再重跑（脚本绝不替你输密钥）。
#
# 用法：
#   ./deploy/bootstrap.sh            机械准备 + doctor 预检；全绿则提示下一步（不自动装、不花钱）
#   ./deploy/bootstrap.sh --install  预检全绿则顺手 ./deploy/install.sh + 验证（一键到底）
set -euo pipefail

DIR="${0:A:h}"          # <repo>/deploy
SVC="${DIR:h}"          # 仓根
cd "$SVC"

INSTALL=0
if [[ "${1:-}" == "--install" ]]; then INSTALL=1; fi

step(){ print -P "%F{cyan}▸ $1%f"; }
ok(){   print -P "%F{green}✓ $1%f"; }
warn(){ print -P "%F{yellow}⚠ $1%f"; }
die(){  print -P "%F{red}✗ $1%f"; exit 1; }

# 0) 只支持 macOS（launchd）
[[ "$(uname)" == "Darwin" ]] || die "本脚本只支持 macOS（launchd）。Linux/Docker 暂不支持。"

# 1) node ≥ 24
step "检查 node ≥ 24"
if ! command -v node >/dev/null 2>&1; then
  if command -v brew >/dev/null 2>&1; then warn "未装 node → brew install node"; brew install node; else die "未装 node，且无 Homebrew。先装 Node ≥24（https://nodejs.org）再重跑。"; fi
fi
NODE_MAJ="$(node -p 'process.versions.node.split(".")[0]')"
(( NODE_MAJ >= 24 )) || die "node 版本过低（需 ≥24，现 $NODE_MAJ）。升级后重跑。"
ok "node $(node -v)"

# 2) 目标项目 example-project（机械动作/脚本真源；兄弟目录或 FORGE_PROJECT_ROOT）
step "检查目标项目 example-project"
SIBLING="${SVC:h}/example-project"
ROOT="${FORGE_PROJECT_ROOT:-$SIBLING}"
if [[ ! -d "$ROOT/.git" ]]; then
  warn "未找到主仓（$ROOT）——它是机械动作/脚本/标准的活真源。"
  print "  克隆：git clone git@github.com:your-org/example-project.git \"$ROOT\""
  if [[ -t 0 ]] && read -q "REPLY?  现在克隆到兄弟目录？[y/N] "; then
    echo; git clone git@github.com:your-org/example-project.git "$ROOT" || die "克隆失败（检查 SSH / gh 权限）"
  else
    echo; die "缺目标项目——克隆后重跑（或设 FORGE_PROJECT_ROOT 指向已有 checkout）。"
  fi
fi
ok "主仓 $ROOT"

# 3) npm install（纯 JS 依赖：yaml / zod / 飞书 SDK）
step "npm install"
npm install --no-audit --no-fund
ok "依赖就位"

# 4) 配置脚手架（不覆盖已填的）
step "配置脚手架"
for f in forge.env weekly-overrides.tsv; do
  if [[ -f "config/$f" ]]; then ok "config/$f 已存在（不覆盖）";
  elif [[ -f "config/$f.example" ]]; then cp "config/$f.example" "config/$f"; warn "已从 .example 生成 config/$f —— 待你填（密钥 / webhook）"; fi
done

# 5) git hooks（提交前本地 CI 闸口）
if git config core.hooksPath .githooks 2>/dev/null; then ok "git hooks 已启用（pre-commit 跑 npm run ci）"; fi

# 6) doctor 预检（机械的都过了，剩下不可自动化的它来报）
step "./forge doctor 预检"
DOCTOR_OK=1
./forge doctor || DOCTOR_OK=0

echo
if (( DOCTOR_OK )); then
  ok "预检全绿——可部署。"
  if (( INSTALL )); then
    warn "守护一旦启动即自动跑闸 + 每日契约探针 = 自动花钱。"
    step "安装并启动守护（./deploy/install.sh）"
    ./deploy/install.sh
    step "验证"
    sleep 3
    ./forge health || true
    echo
    ok "部署完成。状态页 http://127.0.0.1:${FORGE_HEALTH_PORT:-4319}/　｜　日志 tail -f logs/launchd.log"
  else
    print -P "下一步：%F{cyan}./deploy/install.sh%f（装守护+看门狗）　或重跑 %F{cyan}./deploy/bootstrap.sh --install%f 一键到底。"
  fi
else
  warn "预检有缺项（见上 doctor 的 ✗）。以下是不可自动化、需你手补的内核："
  print "  1) 填 config/forge.env：飞书 bot 密钥 / DM 目标 / 结果 webhook（见文件内注释）"
  print "  2) 登录 CLI：claude（保持登录态）/ codex（鉴权）/ gh auth login"
  print "  3) 飞书开发者后台：事件订阅→长连接 + 权限 + 把 bot 拉进观察群（见 deploy/README.md 第三节）"
  print "  4) 主仓三代码仓未 clone → 去主仓跑 ./scripts/bootstrap.sh"
  print -P "补齐后重跑 %F{cyan}./deploy/bootstrap.sh%f（幂等）。可接受降级（无飞书）也可直接 %F{cyan}./deploy/install.sh%f。"
  print -P "想被逐步带着补齐？让 Claude Code / Codex 跑 %F{cyan}/deploy-forge%f skill（阻断式安装真源）。"
  exit 2
fi
