# Why Forge Works This Way (the Core Value Argument)

> This document answers two fundamental questions: **Why not build our own agent harness? Why have two AIs review each other?** It is the single source of truth for Forge's reason to exist — aligning understanding internally, and answering "is this actually best practice?" externally. Engineering discipline lives in [CLAUDE.md](../CLAUDE.md); the service and state machine in [README.md](../README.md).

## In one sentence

**Forge does not build its own coding agent. It orchestrates two world-class, fast-iterating coding agents (Claude Code + Codex, via their CLIs), backstopped by the two legs of "heterogeneous cross-review" + "deterministic gates", while preserving vendor optionality.** Cross-review and deterministic gates are a pair; neither is dispensable.

---

## Origin: not designed on paper, discovered by testing

Forge's core playbook did not start as theory that was then implemented. It was **a manual workflow run for a long time, validated repeatedly, and only then frozen into automation**.

At first, only Claude Code wrote the code and reviewed itself. Then, one day, the code / architecture docs produced by Claude Code were handed to Codex for a second review — **Codex consistently found a large number of real problems, especially edge cases** (and edge cases are exactly where the big production incidents later come from). Feeding those problems back into Claude Code, it would itself concede "yes, these are real issues", fix them, get reviewed again, get caught again, fix again — until Codex judged the result clean. Afterwards, one of the two would add **non-adversarial, non-mirror** unit + integration tests.

The measured result of this manual workflow: **features shipped with almost no manual testing, at 95%–100% accuracy**. Everything below explains **why this empirically validated pattern holds** — it is not an after-the-fact rationalization of a design.

## Why not build a harness (and instead rent Claude Code + Codex via their CLIs)

**A self-built harness is a depreciating asset; a rented harness is an appreciating one.**

The Claude Code / Codex CLIs are not "shells around a model". Each is a full stack that gets stronger every week: context management, tool loops, diff application, permissions, sub-agents, MCP, parse self-healing, prompt caching, sandboxing, model selection, session/resume… Both companies pour enormous engineering into them and iterate fast. The key point: **the capability underneath keeps improving, while the interface you call (the CLI) stays essentially stable.** Therefore:

1. **Free-riding on external R&D**: every time they upgrade, Forge's lower layer gets stronger automatically, without changing a line of the orchestration layer. Building your own puts you on a treadmill of "forever re-implementing what they just shipped", falling further behind each cycle.
2. **Commoditize your complement**: the harness layer is being commoditized by two free/cheap world-class CLIs. Durable value sits in the layer above — orchestration, domain gates, acceptance contracts, review discipline, organizational knowledge. Forge invests its scarce engineering precisely there.
3. **You rent the agent, not the model**: using the CLI (rather than the raw API) inherits their **agentic layer**. "Building Codex from a bare model" is exactly what they already spent a fortune doing; there is no reason to redo it.

**The honest cost** (small, but real): integration maintenance risk for two external CLIs + vendor risk (interfaces/auth/rate limits/pricing/ToS). But that cost is two orders of magnitude smaller than building a harness.

## Why two AIs reviewing each other (the active ingredient is *heterogeneity*, not "reviewing twice")

Two agents beat one **not because the work is reviewed one more time, but because the two are different**:

- **Partially uncorrelated error distributions**: the Claude family and the GPT/Codex family are trained differently and fail differently; the parts of their blind spots that don't overlap are exactly what the other can catch. **A model reviewing itself has correlated blind spots** (it tends to excuse its own work); switching to a different brain is what makes catching the author's invisible mistakes likely. The mechanism is the same as ensembling — "two different people reviewing beats one person reviewing twice".
- **Adversarial framing amplifies it**: asking the reviewer to **refute** (rather than vaguely "take a look") surfaces more. Forge's gates do exactly this.
- **Complementary strengths**: whichever is better at architecture/refactoring/long context, and whichever is better at edge-case bugs/certain languages/test rigor — assigning author/reviewer roles accordingly yields gains. And since this division drifts across versions, role assignment should be configurable; when degraded to single-model self-review, **independence weakens** (the README says so honestly).

## Why only a third party can do this (both vendors are structurally out)

Cross-vendor adversarial review is something **no single vendor will ever ship** — Claude Code and Codex are direct competitors: Anthropic will not make "have Codex double-check me" a first-class capability inside Claude Code, and likewise for OpenAI. Each invests in making its own self-review stronger, and **single-vendor self-review has correlated blind spots** (see above) — no amount of strength substitutes for the heterogeneity leg.

So this value is **ground structurally ceded by the vendors** — only a third-party orchestrator standing above both, playing them against each other, has the incentive to occupy it. Two corollaries:

1. **Model upgrades make it more valuable, not less**: two stronger heterogeneous reviewers crossing each other raise the error-catching ceiling. The orchestration layer and model upgrades are **complements**, not competitors — "once their models get strong enough, this becomes useless" is a misjudgment.
2. **The real competitor is not Anthropic/OpenAI, but other neutral orchestrators**: the vendors are out, but model-agnostic third parties (generic agent frameworks / model routers) could pit the two against each other. Forge's moat is therefore **not "it runs two agents"** (copyable), but **the protocol that makes the adversarial loop actually catch bugs** — code source-of-truth anchoring, no silent failure, the state machine, acceptance contracts, finding severity levels. The depth is in the protocol, not the act.

## A correction that must be nailed down: cross-review is one leg of two

**Cross-review has a ceiling**: domain rules neither model was told, ambiguity in the spec itself, blind spots the two share — cross-review cannot catch these, and two very strong models can be **confidently wrong together**. Reliability therefore comes from **two legs**:

1. **Cross-review** (claude ⇄ codex) catches "plausible-looking but wrongly reasoned" (subjective correctness);
2. **Deterministic gates** (CI green / outer-loop acceptance turned green / types / zero Blockers) catch "both agents agree, but reality disagrees" (objective correctness).

**The core value is the combination**; drop either leg and a whole class of errors slips through. And cross-review **must be bounded** (`max_rounds`, a scope-limited final round, finding severity levels) — otherwise it degenerates into ever-finer nitpicking noise + burned money, forcing changes that are unnecessary or even harmful.

> **The third leg (across time): eval = closed-loop measurement.** The two legs above only judge "is this one output correct"; since the rented engines shift under your feet daily, you also need a leg guarding "overall quality has not regressed with model/prompt drift" — golden samples + judge + A/B against a baseline (`src/eval/`) measure **quality drift**, while `probes.ts`/`contract.ts` measure **interface drift**. This is the instrument panel that makes it defensible to outsource judgment to uncontrollable external agents. For the empirical contrast with a self-built harness that "relies entirely on open-loop documentation conventions, zero eval", see [self-built-harness-tradeoff.md](./self-built-harness-tradeoff.md).

## Why automate (don't make a human the message bus; but keep the human as the regulator)

The manual workflow worked, but the human in it was doing two jobs:

1. **Message bus**: manually copy-pasting problems and changes between Claude Code and Codex, shouting "start reviewing" — purely mechanical, tiring, error-prone, unscalable. **This part must be automated**; it is Forge's most direct reason to exist.
2. **Regulator**: the human judging "dig deeper this time" vs "this is a nit, don't overdo it". Half of the manual workflow's accuracy came from this judgment steering the wheel.

**The hard part of automation is not the bus — it is not removing the regulator along with it.** `max_rounds` is a blunt substitute: it only counts rounds — cut too early and real bugs slip through; left alone, nits get polished ever finer (burning double tokens and possibly introducing new risk through needless changes). So "cross-review must be bounded" (above) should be built as a **first-class, configurable quality judgment**, not mere counting:

- **Severity gate**: only findings ≥ a threshold trigger the next round; nits are recorded but never churned.
- **Depth by risk**: use the existing `sensitive_areas` + `size` to derive review depth automatically — dig deep on sensitive/large changes, pass quickly on trivial ones — replicating the human's "review deeper this time" judgment without asking every time.

In one line: **of what Forge takes over from the human, the message bus is the most immediate; the regulator is the most valuable.**

## Vendor optionality / anti-fragility

Using two **independent vendors** buys a hedge for free: if one degrades, goes down, raises prices, or changes its ToS, you are not locked to a single vendor; reviewer/fixer are injected via drivers with `on_missing` degradation, so a stronger third CLI can slot straight into the same socket in the future. This makes "two agents" not just an accuracy play but an optionality/anti-fragility play.

## Is this best practice?

Yes — and it exceeds the mainstream in production rigor. It aligns with Anthropic's publicly advocated principle of "**prefer deterministic workflows over free-roaming agents whenever possible**" — Forge is a workflow engine (a state machine orchestrating LLM calls, with bounded adversarial loops), not an agent loose in the codebase; and it turns "manager of agents + deterministic backstop" into a team-ready orchestration platform. **The only way it falls out of best practice**: turning the autonomy knob faster than the deterministic gates can absorb failures. Hence — **deterministic gates are never skippable; the human may step back gradually** (see the progressive-autonomy roadmap in [README.md](../README.md)).
