#!/usr/bin/env bash
# weekly-load.sh -- each person's weighted load for the week, counted in **requirements**: not hours, not
# PR counts, and not lines of code.
#
# Why: a timesheet measures how diligently someone fills in a timesheet, not how much work they did (see
# docs/workspace/load-eval.md).
# This tool takes the requirements each person actually moved forward this week off the board, and weights
# them all the same way:
#
#     score = sum over requirements of ( size x span x quality )
#
#   * The unit is one requirement, which is one row on the board: an Epic (P#) collapses its cross-repo
#     children into a single requirement, while a single-repo issue counts as one on its own.
#     Cross-repo children are merged by epic:<slug> and never double-counted, so one sign-in feature is not
#     counted once for C and again for U.
#   * Size: size:S/M/L/XL map to 1 / 3 / 8 / 20 -- Fibonacci, because difficulty grows faster than linearly.
#     The size:* label is applied during the gate B review;
#     unlabelled, it defaults to M and is marked with a * to prompt you to refine it, or you can override it
#     in config/weekly-overrides.tsv.
#   * Span: how many code repos a requirement's children reach across -- one repo x1.0, two x1.3, three x1.5.
#     The coordination and contract cost is real.
#   * Quality: inferred from the rollup status -- 7 shipped x1.0, 6 in testing x0.85, 5 in review x0.75,
#     4 in development x0.7, anything else x0.4.
#     It can be adjusted by hand in config/weekly-overrides.tsv (caused an incident -> 0.6; left behind a
#     clean shared component -> 1.2; sent back repeatedly in review -> 0.8).
#
# Usage, run from the umbrella root:
#   ./scripts/weekly-load.sh                         # the default team EO CC DE, over the last 7 days
#   ./scripts/weekly-load.sh --since 2026-06-08 --until 2026-06-12
#   ./scripts/weekly-load.sh EO CC DE M              # specific people, by short code or by login
#   ./scripts/weekly-load.sh --since 2026-06-08 --until 2026-06-12 CC
#
# The override file (optional -- it adjusts size and quality without touching the GitHub labels):
# config/weekly-overrides.tsv
#   Each line: <requirement key> <TAB> <size or -> <TAB> <quality multiplier or -> <TAB> a note
#   The requirement key is "epic:<slug>" for an Epic, or "C#164" / "A#98" / "U#545" for a single repo.
#   A field of "-" means no override.
#   For example:  epic:admin-dashboard	XL	0.7	a big one still in testing
#                 A#98	L	-	the featured dialog is really an L
#
# Prerequisite: gh is logged in as an account with access to your-org (alice-lead -- see the README). The
# board is the same source of truth board.sh reads.
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
# Map a login back to a short code, for display
shorthand_of() {
  case "$1" in
    alice-lead) echo M;; bob-dev) echo BD;; carol-codes) echo CC;; dave-eng) echo DE;; erin-ops) echo EO;; *) echo "$1";;
  esac
}
days_ago() { if date -v-1d >/dev/null 2>&1; then date -v-"$1"d +%F; else date -d "$1 days ago" +%F; fi; }

# -- Parse the arguments --
SINCE=""; UNTIL=""; PEOPLE=()
while [ $# -gt 0 ]; do
  case "$1" in
    --since) SINCE="${2:-}"; shift 2;;
    --until) UNTIL="${2:-}"; shift 2;;
    -h|--help) sed -n '2,33p' "$0"; exit 0;;
    -*) die "unknown argument: $1";;
    *) PEOPLE+=("$1"); shift;;
  esac
done
[ -n "$UNTIL" ] || UNTIL="$(date +%F)"
[ -n "$SINCE" ] || SINCE="$(days_ago 7)"
[ "${#PEOPLE[@]}" -gt 0 ] || PEOPLE=(EO CC DE)

# Pull a TSV per repo per person: prefix \t number \t status order \t status \t epicSlug \t sizeLabel \t
# type \t state \t title
ROW_JQ='
.[] |
  ([.labels[].name|select(startswith("status:"))]|(.[0]//"")) as $st |
  (if $st=="" then 0 else ($st|ltrimstr("status:")|split("-")[0]|tonumber) end) as $ord |
  ([.labels[].name|select(startswith("epic:"))|ltrimstr("epic:")]|(.[0]//"")) as $ep |
  ([.labels[].name|select(startswith("size:"))|ltrimstr("size:")]|(.[0]//"")) as $sz |
  ([.labels[].name|select(startswith("type:"))|ltrimstr("type:")]|join(",")) as $ty |
  "\($pre)\t\(.number)\t\($ord)\t\(if $st=="" then "-" else $st end)\t\($ep)\t\($sz)\t\(if $ty=="" then "-" else $ty end)\t\(.state)\t\(.title)"
'

# The scoring awk: it reads one person's TSV, groups by key and scores each group, writing the
# machine-readable summary lines to SCORE_OUT.
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
    if(span==0){ span=1; repcol="P" }   # it hangs off the Epic (P) alone, with no code repo child yet
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
  printf "  weighted total ~ %.1f      requirements %d (spanning repos %d)\n", total, ng, ncross
  if(SCORE_OUT!="") printf "%s\t%.1f\t%d\t%d\n", WHO, total, ng, ncross >> SCORE_OUT
}'

# A proxy note: behind a local fake-IP proxy, gh honours the lowercase https_proxy. If gh reports EOF:
#   https_proxy=http://127.0.0.1:7897 ./scripts/weekly-load.sh ...
gh api user -q .login >/dev/null 2>&1 || die "gh is not logged in, or the network is unreachable (behind a proxy, prefix the command with https_proxy=http://127.0.0.1:7897). See the README."

echo "=== requirement load per person  ${SINCE} ... ${UNTIL}  ==="
echo "  how it is counted: requirement x size (S1/M3/L8/XL20) x span (1/1.3/1.5) x quality (inferred from status) -- see docs/workspace/load-eval.md"
[ -f "$OVR_FILE" ] && echo "  overrides: config/weekly-overrides.tsv (loaded)" || echo "  overrides: config/weekly-overrides.tsv (absent, so size defaults to M and is marked *)"
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
    echo "  (no issue assigned to them was updated inside this window)"; echo
    printf '%s\t0.0\t0\t0\n' "$sh" >> "$SCORE_OUT"; continue
  fi
  printf "  %-6s %-4s %-4s %-4s %7s   %s\n" "repo" "size" "span" "qual" "score" "requirement"
  printf '%s\n' "$buf" | awk -F'\t' -v OVR="$OVR_FILE" -v WHO="$sh" -v SCORE_OUT="$SCORE_OUT" "$SCORE_AWK"
  echo
done

echo "=== weighted load, ranked (${SINCE} ... ${UNTIL}) ==="
sort -t$'\t' -k2 -nr "$SCORE_OUT" | awk -F'\t' '{ printf "  %-4s %6.1f   (requirements %d, spanning repos %d)\n", $1, $2, $3, $4 }'
echo
echo "  * = that requirement carries no size label and was estimated as M. Apply size:S/M/L/XL during the gate B review, or refine it in config/weekly-overrides.tsv."
echo "  Note: this table replaces or supplements a timesheet, for assessing by requirement and quality. What it counts and where it stops are in docs/workspace/load-eval.md."
