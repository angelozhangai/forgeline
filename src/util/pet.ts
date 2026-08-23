// The requirement pet, and how it evolves (the easter-egg layer). Every requirement is a little creature
// that hatches from a "requirement egg", evolves as it moves through review, and reaches its final form the
// moment it ships.
// Design discipline:
//  · Pure functions and deterministic — every "random" choice is derived from the session's id / ref_num /
//    created_at, so the same requirement always renders the same way: unit-testable and stable.
//    (Never Math.random or Date.now, or the same card would change on every render and no test could assert
//    on it.)
//  · No jargon leaks — the lines are plain language, and "Gate A"/"Gate B"/"GATE_*" must never appear (the
//    same discipline as display.ts, guarded by pet.test.ts).
//  · The master switch FORGE_FUN=0 turns the whole easter-egg layer off and cards go back to the serious
//    mode (notify.ts takes the old path from there).
import type { State } from '../statemachine/states.ts';
import type { Session } from '../types.ts';

export const FUN_ON = process.env.FORGE_FUN !== '0';

// The 5-stage evolution tree as shown. To change the theme, change this and STAGE's tiers.
export const PET_TREE = ['🥚', '🐣', '🐤', '🐔', '🦄'] as const;

export interface PetStage {
  sprite: string; // the creature as it looks now (= the tier-th one in the tree, so the headline sprite and the highlighted tree entry always agree)
  tier: number; // 1..5, which stage of the evolution tree
  stage: string; // the stage's nickname (plain language)
  voice: string; // its line for this step (plain language, no jargon)
}

// Each internal state -> an evolution tier + a stage nickname + a line. The sprite is derived from the tier
// (PET_TREE[tier-1]): one source of truth, so it cannot drift from the highlighted tree entry. A parked
// state (failed or rejected) falls back to the matching stage with its line switched to "stuck"/"back in the
// nest".
const STAGE: Record<State, Omit<PetStage, 'sprite'>> = {
  INTAKE: { tier: 1, stage: 'requirement egg', voice: 'A new requirement just landed in the nest, queued up to hatch...' },
  GATE_A_RUNNING: { tier: 2, stage: 'pecking out', voice: 'Pecking through the shell against the latest code, hunting for holes...' },
  AWAITING_PM_CONFIRM: { tier: 2, stage: 'head out, waiting to be fed', voice: 'It hatched a few questions and is craning its neck for product to feed it answers~' },
  GATE_A_REVISION_REQUESTED: { tier: 2, stage: 'chewing it over', voice: 'It tasted the answers product fed it and is pecking through one more round to see what is still missing...' },
  GATE_A_ADVERSARIAL: { tier: 2, stage: 'tempering', voice: 'Every answer is in, and it is trading pecks with the AI reviewer to temper the requirement once more...' },
  GATE_A_STALLED: { tier: 2, stage: 'fussy and stuck', voice: 'Several helpings later there is still a lump. Calling the owner over to make the call.' },
  CONFIRMED: { tier: 3, stage: 'full up', voice: 'Full of answers, waiting for the owner to teach it to fly (a technical plan).' },
  GATE_B_REQUESTED: { tier: 3, stage: 'winding up', voice: 'Queued up for flying lessons, about to spread out the blueprints...' },
  GATE_B_RUNNING: { tier: 3, stage: 'learning to fly', voice: 'Drawing up the flight plans for the technical design...' },
  ADVERSARIAL_LOOP: { tier: 4, stage: 'sparring', voice: 'Trading pecks with Codex, getting stronger every round...' },
  AWAITING_GATE_B_INPUT: { tier: 4, stage: 'scratching its head', voice: 'It hit something it is unsure about mid-spar and is tilting its head, waiting on the owner to call it~' },
  GATE_B_REVISION_REQUESTED: { tier: 4, stage: 'training to the new plan', voice: "It has the owner's call and is running the round again to match..." },
  AWAITING_GO: { tier: 4, stage: 'ready to launch', voice: 'Fully fledged, waiting on your word to leave the nest and start the work!' },
  WRITING: { tier: 4, stage: 'taking off', voice: 'Creating the work items and laying down the runway...' },
  DONE: { tier: 5, stage: 'fully evolved', voice: 'Evolution complete - wings out and airborne!' },
  // Downstream: implementation + local CI
  GATE_C_REQUESTED: { tier: 4, stage: 'ready to break ground', voice: 'Blueprints in hand, queued up to slip into its own nest and start writing code...' },
  GATE_C_RUNNING: { tier: 4, stage: 'breaking ground', voice: 'Burrowed into its isolated nest, tapping out code from the blueprints...' },
  GATE_C_LOOP: { tier: 4, stage: 'writing and self-testing', voice: 'Writing code and testing as it goes - anything red goes back in until it is all green...' },
  AWAITING_GATE_C_INPUT: { tier: 4, stage: 'scratching its head', voice: 'Halfway through it hit something it is unsure about, head tilted, waiting on the owner to call it~' },
  GATE_C_REVISION_REQUESTED: { tier: 4, stage: 'back to work with the answer', voice: "It has the owner's call and is back to writing..." },
  // Downstream: PR review + test hardening + merge
  AWAITING_GATE_D: { tier: 4, stage: 'ready for inspection', voice: 'The code is written and its own tests pass - waiting on your word to submit it for review!' },
  GATE_D_REQUESTED: { tier: 4, stage: 'submitted for inspection', voice: 'Pushing the changes up and queuing for review...' },
  GATE_D_LOOP: { tier: 4, stage: 'sparring under inspection', voice: 'Trading pecks with Codex over the changes, getting steadier every round...' },
  AWAITING_GATE_D_INPUT: { tier: 4, stage: 'scratching its head', voice: 'The review turned up something it is unsure about, head tilted, waiting on the owner to call it~' },
  GATE_D_REVISION_REQUESTED: { tier: 4, stage: 'reworking to the review', voice: 'Going back for another round, following the review comments...' },
  GATE_D_HARDENING: { tier: 4, stage: 'forging armour', voice: 'Fitting the changes with real tests for armour (no mirror-of-the-code fakes)...' },
  AWAITING_HUMAN_MERGE: { tier: 5, stage: 'armoured and ready to merge', voice: 'Armour on, every check passed - waiting on your word to merge and ship!' },
  SHIPPED: { tier: 5, stage: 'fully evolved', voice: 'The changes are merged - wings out and shipped!' },
  // Parked states
  GATE_A_FAILED: { tier: 2, stage: 'stuck in the shell', voice: 'It got stuck breaking out. Calling the owner over for a hand.' },
  GATE_B_FAILED: { tier: 3, stage: 'stuck', voice: 'It took a tumble during flying practice. Calling the owner over to help.' },
  GATE_B_STALLED: { tier: 4, stage: 'sparring deadlocked', voice: 'Several rounds in and there is still a lump. Calling the owner over to make the call.' },
  GATE_C_FAILED: { tier: 4, stage: 'stuck', voice: 'It took a tumble breaking ground. Calling the owner over to help.' },
  GATE_C_STALLED: { tier: 4, stage: 'stuck on its own tests', voice: 'Several rounds of self-testing and it is still not all green. Calling the owner over to make the call.' },
  GATE_D_FAILED: { tier: 4, stage: 'stuck', voice: 'It tripped during review. Waiting on the owner to retry.' },
  GATE_D_STALLED: { tier: 4, stage: 'sparring deadlocked', voice: 'Several rounds of review and there is still a lump. Calling the owner over to make the call.' },
  GO_DENIED: { tier: 1, stage: 'back in the nest', voice: 'Sent back to be raised again - tweak it and try once more.' },
  WRITE_FAILED: { tier: 4, stage: 'stuck', voice: 'It tripped on the way out of the nest. Waiting on the owner to retry.' },
};

export function petStage(state: State): PetStage {
  const e = STAGE[state] ?? STAGE.INTAKE;
  return { sprite: PET_TREE[e.tier - 1], ...e };
}

// Evolution tier -> the pixel-animation asset name (assets/pet/<name>.gif, matching the keys in keys.json).
// Taken from the tier, so there is one source of truth.
export const TIER_ASSET = ['egg', 'hatch', 'chick', 'bird', 'final'] as const;
export function petAssetName(state: State): string {
  return TIER_ASSET[petStage(state).tier - 1];
}

// A deterministic hash (FNV-1a). Only so that the same requirement stably picks the same final form and
// easter egg; not for any security purpose.
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// The final form (the collectible feeling at ship time): deterministically pick one fully evolved creature
// from the session id, with a rare golden variant.
const FINAL_FORMS = ['🦄', '🐉', '🦅', '🦚', '🦖', '🦢', '🦩'];
export function finalForm(s: Pick<Session, 'id' | 'slug'>): string {
  const h = hash(s.id || s.slug || 'x');
  if (h % 20 === 0) return '✨🦄✨'; // the ~5% rare gold
  return FINAL_FORMS[h % FINAL_FORMS.length];
}

// The evolution tree on one line, with the current stage highlighted: 🥚→🐣→[🐤]→🐔→🦄
export function treeLine(state: State): string {
  const tier = petStage(state).tier;
  return PET_TREE.map((e, i) => (i + 1 === tier ? `[${e}]` : e)).join('→');
}

// Feeding (cost, made tangible). Every $0.05 counts as one bite of "compute chow".
//  · Group card: opts.showDollar=false -> only the bite count and the food emoji, with the amount hidden
//    (product should not be looking at internal cost).
//  · Direct-message card: showDollar=true -> the bite count and the real dollar figure (your budget ledger).
export function feedLine(costUsd: number, opts: { showDollar: boolean }): string {
  const bites = Math.max(1, Math.round((costUsd || 0) / 0.05));
  if (opts.showDollar) return `🍗 Fed ${bites} bites of compute chow this run · $${(costUsd || 0).toFixed(2)}`;
  const food = '🍗'.repeat(Math.min(bites, 6));
  return `${food} Fed ${bites} bites of compute chow`;
}

// The occasional hidden line (deterministic, derived from the session; null most of the time).
// Priority: milestone > night owl > lucky egg.
export function easterEgg(s: Pick<Session, 'id' | 'ref_num' | 'created_at'>): string | null {
  if (s.ref_num != null && s.ref_num > 0 && s.ref_num % 10 === 0) {
    return `🏆 Milestone reached: this is requirement egg number ${s.ref_num}!`;
  }
  if (s.created_at) {
    const hour = new Date(s.created_at).getHours(); // the machine's local time zone; purely for fun
    if (hour >= 0 && hour < 6) return '🦉 Night-owl egg: laid in the small hours, and all the wiser for it~';
  }
  if (hash(`${s.id || ''}luck`) % 13 === 0) return '🍀 Lucky egg: full of beans today, on top form!';
  return null;
}
