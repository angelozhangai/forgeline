#!/usr/bin/env bash
# weekly-load.sh — 按【需求】算每人本周加权负载（不是工时、不是 PR 数、不是行数）
#
# 为什么：工时表量的是「填报习惯」，不是工作量（见 docs/workspace/load-eval.md）。
# 本工具从需求看板取每人本周真实推进的【需求】，按统一口径加权：
#
#     得分 = Σ_需求 ( 规模 × 跨栈 × 质量 )
#
#   · 原子单位 = 需求（= 看板一行）：Epic(P#) 把跨仓子 issue 收成 1 个需求；单仓 issue 各算 1 个。
#     —— 跨仓子 issue 按 epic:<slug> 合并，绝不重复计数（一个 Google 登录不会被算成 C+U 两份）。
#   · 规模  size:S/M/L/XL → 1 / 3 / 8 / 20（斐波那契，难度超线性）。闸B 评审时打 size:* 标签；
#            没打则默认 M(标 * 提示你去细化) 或用 config/weekly-overrides.tsv 覆盖。
#   · 跨栈  需求的子 issue 横跨几个代码仓：单仓×1.0 / 两仓×1.3 / 三仓×1.5（协调/契约成本是真的）。
#   · 质量  从 rollup 状态推：7-已上线×1.0 / 6-测试中×0.85 / 5-review×0.75 / 4-开发中×0.7 / 其它×0.4。
#            可在 config/weekly-overrides.tsv 手调（引发事故→0.6；干净沉淀公共件→1.2；review 多轮打回→0.8）。
#
# 用法（从 umbrella 根跑）：
#   ./scripts/weekly-load.sh                         # 默认团队 EO CC DE，最近 7 天
#   ./scripts/weekly-load.sh --since 2026-06-08 --until 2026-06-12
#   ./scripts/weekly-load.sh EO CC DE M              # 指定人（简称或 login）
#   ./scripts/weekly-load.sh --since 2026-06-08 --until 2026-06-12 CC
#
# 覆盖文件（可选，调 size/质量，不动 GitHub 标签）：config/weekly-overrides.tsv
#   每行：  <需求key> <TAB> <size或-> <TAB> <质量乘数或-> <TAB> 备注
#   需求key：Epic 用 "epic:<slug>"；单仓用 "C#164"/"A#98"/"U#545"。字段填 "-" = 不覆盖。
#   例：  epic:admin-dashboard	XL	0.7	测试中的大包
#         A#98	L	-	精选弹窗其实是 L
#
# 前置：gh 已登录有 your-org 权限的账号（alice-lead，见 README）。看板真源同 board.sh。
set -uo pipefail
cd "$(dirname "$0")"
ROOT="$(cd .. && pwd)"
OVR_FILE="${ROOT}/config/weekly-overrides.tsv"

OWNER="your-org"
ALL_REPOS=("demo" "example-web" "example-admin" "example-project")

die() { echo "✗ $*" >&2; exit 1; }
prefix_of() { case "$1" in demo) echo C;; example-web) echo U;; example-admin) echo A;; example-project) echo P;; *) echo "?";; esac; }
resolve_assignee() {
  local up; up=$(printf '%s' "$1" | tr '[:lower:]' '[:upper:]')
  case "$up" in
    M) echo alice-lead;; BD) echo bob-dev;; CC) echo carol-codes;; DE) echo dave-eng;; EO) echo erin-ops;; *) echo "$1";;
  esac
}
# 反查 login → 简称（展示用）
shorthand_of() {
  case "$1" in
    alice-lead) echo M;; bob-dev) echo BD;; carol-codes) echo CC;; dave-eng) echo DE;; erin-ops) echo EO;; *) echo "$1";;
  esac
}
days_ago() { if date -v-1d >/dev/null 2>&1; then date -v-"$1"d +%F; else date -d "$1 days ago" +%F; fi; }

# ── 解析参数 ──
SINCE=""; UNTIL=""; PEOPLE=()
while [ $# -gt 0 ]; do
  case "$1" in
    --since) SINCE="${2:-}"; shift 2;;
    --until) UNTIL="${2:-}"; shift 2;;
    -h|--help) sed -n '2,33p' "$0"; exit 0;;
    -*) die "未知参数：$1";;
    *) PEOPLE+=("$1"); shift;;
  esac
done
[ -n "$UNTIL" ] || UNTIL="$(date +%F)"
[ -n "$SINCE" ] || SINCE="$(days_ago 7)"
[ "${#PEOPLE[@]}" -gt 0 ] || PEOPLE=(EO CC DE)

# 每仓每人抽 TSV：前缀 \t 号 \t status序 \t status \t epicSlug \t sizeLabel \t type \t state \t 标题
ROW_JQ='
.[] |
  ([.labels[].name|select(startswith("status:"))]|(.[0]//"")) as $st |
  (if $st=="" then 0 else ($st|ltrimstr("status:")|split("-")[0]|tonumber) end) as $ord |
  ([.labels[].name|select(startswith("epic:"))|ltrimstr("epic:")]|(.[0]//"")) as $ep |
  ([.labels[].name|select(startswith("size:"))|ltrimstr("size:")]|(.[0]//"")) as $sz |
  ([.labels[].name|select(startswith("type:"))|ltrimstr("type:")]|join(",")) as $ty |
  "\($pre)\t\(.number)\t\($ord)\t\(if $st=="" then "-" else $st end)\t\($ep)\t\($sz)\t\(if $ty=="" then "-" else $ty end)\t\(.state)\t\(.title)"
'

# 评分 awk（读一个人的 TSV，按 key 分组算分；机器汇总行写 SCORE_OUT）
SCORE_AWK='
function sizepts(s){ if(s=="S")return 1; if(s=="M")return 3; if(s=="L")return 8; if(s=="XL")return 20; return 3 }
function qual(o){ if(o==7)return 1.0; if(o==6)return 0.85; if(o==5)return 0.75; if(o==4)return 0.7; if(o==0)return 0.5; return 0.4 }
BEGIN{
  split("C U A",CODE," "); rank["S"]=1;rank["M"]=2;rank["L"]=3;rank["XL"]=4
  if(OVR!=""){ while((getline ln < OVR)>0){ if(ln ~ /^#/ || ln=="")continue; m=split(ln,a,"\t"); ok=a[1]; if(a[2]!=""&&a[2]!="-"){ovrsz[ok]=a[2]} if(a[3]!=""&&a[3]!="-"){ovrq[ok]=a[3]+0} } close(OVR) }
}
{
  pfx=$1; num=$2; ord=$3+0; st=$4; ep=$5; sz=$6; ty=$7; state=$8; title=$9
  key = (ep!="" ? "epic:"ep : pfx"#"num)
  if (!(key in seen)) { order[++n]=key; seen[key]=1 }
  repos[key SUBSEP pfx]=1
  if (ord>0 && (!(key in minord) || ord<minord[key])) minord[key]=ord
  if (sz!="" && (!(key in size) || rank[sz]>rank[size[key]])) { size[key]=sz; sized[key]=1 }
  if (ep!="") gtitle[key]="[epic] "ep; else if(!(key in gtitle)) gtitle[key]=title
  gtype[key]=ty
}
END{
  total=0; ng=0; ncross=0
  for(i=1;i<=n;i++){
    key=order[i]
    span=0; repcol=""
    for(j in CODE){ if((key SUBSEP CODE[j]) in repos){ span++; repcol=repcol (repcol==""?"":"+") CODE[j] } }
    if(span==0){ span=1; repcol="P" }   # 只挂在 Epic(P) 上、暂无代码子仓
    cs = (span>=3?1.5:(span==2?1.3:1.0))
    o = (key in minord)?minord[key]:0
    s = (key in size)?size[key]:"M"; src=(key in sized)?"":"*"
    q = qual(o)
    if(key in ovrsz){ s=ovrsz[key]; src="" }
    if(key in ovrq){ q=ovrq[key] }
    pts = sizepts(s)*cs*q
    total+=pts; ng++; if(span>=2) ncross++
    printf "  %-6s %-3s %-4s %-4s %7.1f   %s\n", repcol, s src, cs, q, pts, gtitle[key]
  }
  print  "  ----------------------------------------------------------------"
  printf "  合计加权 ≈ %.1f      需求数 %d（跨栈 %d）\n", total, ng, ncross
  if(SCORE_OUT!="") printf "%s\t%.1f\t%d\t%d\n", WHO, total, ng, ncross >> SCORE_OUT
}'

# 代理小贴士：gh 在本机走 fake-IP 代理时认小写 https_proxy（见 memory）。若 gh 报 EOF：
#   https_proxy=http://127.0.0.1:7897 ./scripts/weekly-load.sh ...
gh api user -q .login >/dev/null 2>&1 || die "gh 未登录或网络不通（如走代理：前缀 https_proxy=http://127.0.0.1:7897）。见 README。"

echo "═══ 每人本周需求负载  ${SINCE} … ${UNTIL}  ═══"
echo "  口径：需求 × 规模(S1/M3/L8/XL20) × 跨栈(1/1.3/1.5) × 质量(状态推) —— 详见 docs/workspace/load-eval.md"
[ -f "$OVR_FILE" ] && echo "  覆盖文件：config/weekly-overrides.tsv（已加载）" || echo "  覆盖文件：config/weekly-overrides.tsv（无，size 缺省 M 标 *）"
echo

SCORE_OUT="$(mktemp)"; trap 'rm -f "$SCORE_OUT"' EXIT
for who in "${PEOPLE[@]}"; do
  login="$(resolve_assignee "$who")"; sh="$(shorthand_of "$login")"
  buf=""
  for r in "${ALL_REPOS[@]}"; do
    pfx="$(prefix_of "$r")"
    rows=$(gh issue list -R "${OWNER}/${r}" --state all --limit 100 \
            --search "assignee:${login} updated:${SINCE}..${UNTIL}" \
            --json number,title,state,labels \
            --jq "$(printf '%s' "$ROW_JQ" | sed "s/\$pre/\"${pfx}\"/")" 2>/dev/null)
    [ -n "$rows" ] && buf="${buf}${rows}"$'\n'
  done
  buf="$(printf '%s' "$buf" | sed '/^$/d')"
  echo "─── ${sh} (${login}) ───"
  if [ -z "$buf" ]; then
    echo "  （本周无指派给该人、且本窗口有更新的 issue）"; echo
    printf '%s\t0.0\t0\t0\n' "$sh" >> "$SCORE_OUT"; continue
  fi
  printf "  %-6s %-4s %-4s %-4s %7s   %s\n" "仓" "规模" "跨栈" "质量" "得分" "需求"
  printf '%s\n' "$buf" | awk -F'\t' -v OVR="$OVR_FILE" -v WHO="$sh" -v SCORE_OUT="$SCORE_OUT" "$SCORE_AWK"
  echo
done

echo "═══ 加权负载排行（${SINCE} … ${UNTIL}）═══"
sort -t$'\t' -k2 -nr "$SCORE_OUT" | awk -F'\t' '{ printf "  %-4s %6.1f   （需求 %d，跨栈 %d）\n", $1, $2, $3, $4 }'
echo
echo "  * = 该需求 size 未打标签，按缺省 M 估；闸B 评审时打 size:S/M/L/XL，或填 config/weekly-overrides.tsv 细化。"
echo "  说明：本表替代/补充工时表用于「按需求+质量」评估，口径与边界见 docs/workspace/load-eval.md。"
