# The Self-Built Harness Trade-off: a Live Specimen + Why Eval Is the Other Half of the Closed Loop

> This document is the **empirical companion** to [RATIONALE.md](./RATIONALE.md). RATIONALE answers "why not build a harness, why two AIs cross-reviewing" from first principles (economics / capability theory); this document does two things RATIONALE does not:
> 1. **Take a real self-built harness as a live specimen**, grounding "what a self-built harness actually looks like and where it loses" in measurable numbers;
> 2. **Name the leg RATIONALE only implies — `eval = closed-loop measurement`**: the instrument that makes it defensible to outsource judgment to uncontrollable external agents.
>
> Comparison sample: a sibling project in the same workspace, **Divine-Sword (hereafter DS)** — a "self-built AI full-stack R&D harness". All numbers below are 2026-06 measurements (`git ls-files` + `wc`), not estimates.

---

## 1. The live specimen: what a self-built harness actually looks like

The common mental image of "building your own agent harness" is "I implemented a powerful agent loop". Measured, that is **not** what DS is made of:

| Component | Measured | Nature |
|------|------|------|
| Markdown rules / SOUL / workflows | **≈ 24k lines / 209 files** | "Conventions" — telling the LLM what to do, in prose |
| Python gate scripts (`tools/*.py`) | **~5,000 lines / 26 files** | **Structural checks** (are fields present, did the gates run) |
| Eval / golden samples / regression | **0** (grep `eval\|golden\|fixture\|benchmark` = 0 hits) | —— |
| An actual agent loop | **≈ none** | Stood in for by "a single LLM role-playing each part per the markdown" |

Two counterintuitive facts, which directly decide the trade-off:

1. **Those 5,000 lines are not a loop; they are gates.** The actual "agent core/loop" is not in the Python — it is in the markdown, and amounts to "one LLM playing architect→backend→qa in sequence". In other words, this self-built harness **never actually engineered an agent loop**: no context management, no tool scheduling, no token optimization, no error recovery — and those are **exactly what Claude Code / Codex improve internally every week, co-trained with the model** (see RATIONALE, "Why not build a harness").

2. **Its "conventions" are all open-loop.** The 5,000 lines of gates check **structure** (does the document have the required fields, does the contract have this field, does the ledger have a fresh PASS); **not one of them evaluates whether the output is actually good**. The only thing touching "quality" is a `quality-rubric.yaml` — but that is **read by the LLM so it can grade itself against the rubric**. **Self-assessment is not eval; it is self-reporting.**

> One-line specimen conclusion: the part a self-built harness actually "self-builds" (the agent core) is **its weakest part and the part most worth renting**; the only part that doesn't depreciate is its deterministic gating — **and Forge has that too, done closed-loop (see section 3).**

---

## 2. Why "convention by documentation" is structurally inaccurate

The inaccuracy of documentation conventions is not "not written in enough detail" — it is being open-loop on **three levels at once**:

| Level | Documentation convention (self-built harness) | Consequence | How Forge closes it |
|------|----------------------|------|----------------|
| **Interpretation** | Natural language; the LLM interprets it itself | No control over how it reads "100% faithful" | Structured contracts / outer-loop acceptance (executable `Given/When/Then`) |
| **Enforcement** | Markdown rules = suggestions | Ignorable by the model under pressure | Deterministic gates (CI green / types / zero Blockers, unskippable) |
| **Learning** | No measurement | You never learn whether a rule helped | **Eval (golden samples + judge + scoring, see below)** |

Note that DS itself recognized the enforcement-level gap — its `gate_run.py` + tamper-evident ledger exist precisely to force "**the gates really did run**" (it calls this "root cause 1"). But that closes only half of the enforcement level: **it can guarantee the gates ran, not that the output is good** — while the interpretation and learning levels stay wide open.

---

## 3. The key reinforcement: eval = the other half of the closed loop (the leg RATIONALE didn't name)

RATIONALE presents reliability as "two legs": **heterogeneous cross-review** (subjective correctness) + **deterministic gates** (objective correctness). That holds for a **single output**. What it implies but never names is a **third thing — quality not regressing over time**:

> **The engines you rent (Claude Code / Codex) change under your feet daily. Cross-review and gates only judge "is this one right"; nothing tells you "today's model upgrade quietly dropped my overall quality a notch".**

What fills that gap is **eval — closed-loop measurement**:

- **Mechanism**: pin a set of golden samples (`fixtures/eval/*/prd.md` + `expect.yaml`) → run the full pipeline → a judge scores against expectations (`src/eval/judge.ts` + `prompts/eval/acceptance-judge.md`) → aggregate and store (`aggregate.ts` / `store.ts`). **Every prompt/gate change or model swap can be A/B'd against the baseline.**
- **Division of labor vs deterministic gates**: a gate is a **single-point pass/fail** (did CI go green this time); eval is a **quality curve relative to a baseline** (is this version better or worse than the last). Gates prevent "this one collapsing"; eval prevents "boiling-frog regression".
- **Division of labor vs `probes.ts`**: `probes.ts`/`contract.ts` measure **interface drift** (did the CLI's `--json` schema change); eval measures **quality drift** (interface intact, output got worse). Together they form the complete instrument panel that "renting a high-speed engine" calls for.

**This is exactly why someone who rents the engine needs eval more than someone who builds it**: you hand the steering wheel to an uncontrollable engine that changes daily; the only thing that lets you sleep is this closed loop — drift probes guarding "the interface didn't break", eval guarding "the quality didn't drop".

Measured comparison:

| | Self-built harness (DS) | Forge |
|---|---|---|
| Eval subsystem | **none (0 hits)** | `src/eval/` (judge/expectations/aggregate/runEval/store) |
| Golden samples | none | `fixtures/eval/` × 4 (prd + expect) |
| Eval itself tested | —— | 5 eval tests |
| Interface-drift probes | none | `probes.ts` / `contract.ts` |
| Overall test discipline | 1 self-check script, no CI | **tests/source ≈ 92%**, CI with coverage floors (75/72/75) |

> **Assertion vs measurement**: a documentation convention is "I tell it how it should be" (assertion); eval is "I measure how it actually is" (measurement). **The watershed of engineering maturity is crossing from assertion to measurement.** The self-built harness has 209 markdown files of rules, and not one line of evidence that any of them works.

---

## 4. The trade-off table: self-built vs orchestration (Forge)

| Dimension | Self-built harness | Orchestration (Forge) | Who wins |
|------|-------------|-------------|------|
| Agent core (loop/context/tokens) | Build it yourself → **depreciates the day it ships**, and drives the same model off-distribution, ending up weaker | Rent Claude Code + Codex → free upgrades every week | Orchestration |
| "Convention" mechanism | Markdown (open-loop on three levels) | Contracts + deterministic gates + eval (closed-loop on three levels) | Orchestration |
| Is quality measurable | No (self-assessment ≠ eval) | Yes (golden samples + judge + baseline) | Orchestration |
| Model-drift visibility | Invisible | Probes (interface) + eval (quality) | Orchestration |
| Multi-agent heterogeneous adversarial review | Single built-in brain; structurally unavailable | Slot-based, claude⇄codex, pi pluggable later | Orchestration |
| **Deterministic gating** | **Present, and correct (does not depreciate)** | **Also present** | Tie |

The single tied cell — **deterministic gating** — is exactly the only part of a self-built harness **worth keeping**.

---

## 5. The fair boundary: don't condemn the "gates" along with the "loop"

To keep this document from reading as "self-built harnesses are worthless", the boundary, nailed down:

- **What does not depreciate in a self-built harness is its deterministic-gating idea** (DS's `gate_run.py` + tamper-evident ledger address "the LLM skipping steps under pressure" — a real problem with a real solution).
- **What depreciates is its self-built agent core + the all-markdown open-loop conventions + the absence of eval.**

So the **correct refactoring** of a self-built harness is: **keep its gates, drop its loop (replace with claude/codex), add the eval it lacks (install the closed-loop instruments).** And once those three steps are done, it **converges into Forge** — which in turn confirms that Forge's trade-off is not taste, but drawing the lines correctly between "what to build, what to rent, what to measure".

---

## In one line

> **The agent core** should be rented (it is co-trained with the model; building your own only makes it weaker); **the deterministic shell** should be built (contracts + gates + orchestration sit on the non-depreciating side); and for the shell to be trustworthy, **it must come with the eval closed loop** — otherwise "renting a high-speed engine" turns into "driving blindfolded". A self-built harness running entirely on open-loop markdown with zero eval is the textbook counterexample of this boundary.

**Interfaces**: how this document relates to [RATIONALE.md](./RATIONALE.md) — RATIONALE is the **single source of truth for the principles** ("why not self-build / why cross-review"); this document adds the **empirical evidence** ("what self-building actually looks like") and the **third leg** ("eval = closed-loop measurement"). Engineering discipline: [CLAUDE.md](../CLAUDE.md); the control-plane split: [architecture-control-plane-split.md](./architecture-control-plane-split.md).
