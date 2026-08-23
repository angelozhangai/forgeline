// The web operations panel's write gateway: it dispatches a panel action to the real function in actions.ts.
// It **never rebuilds a gate** — permissions, the lint, assignment and the state machine's red lines are all
// enforced by the real action being called (the same set the cards and the CLI go through). The gateway only
// does four things: allow-list the action name, sign it with the panel's actor, record a panel_action audit
// event, and resolve the slug.
// The signing actor is runtime.web_actor (defaulting to routing.lead); it has to be on the relevant
// permission list, or the action itself returns !ok — the gateway does not wave anything through.
import * as actions from '../actions.ts';
import type { ActionResult } from '../actions.ts';
import { configForProject } from '../projects.ts';
import { store } from '../store/index.ts';
const { resolve: resolveSession, appendEvent } = store; // taking the local implementation's methods through the SessionStore seam (they are free functions with no this, so destructuring is safe)
import type { State } from '../statemachine/states.ts';

type Dispatch = (idOrSlug: string, by: string) => ActionResult | Promise<ActionResult>;

// The actions the panel can trigger, mapped to the real action. It only accepts **button** actions of the
// "a human authorises progress, decides, or retries" kind; the *_INPUT submissions that need written answers
// (submitGateB/C/DAnswers) are handled separately.
const DISPATCH: Record<string, Dispatch> = {
  confirm: (id, by) => actions.confirm(id, by), // GATE_A_STALLED: force it through
  gateb: (id, by) => actions.requestGateB(id, by), // CONFIRMED -> produce a technical plan
  force_go: (id, by) => actions.forceGateBGo(id, by), // GATE_B_STALLED: force the work open
  go: (id, by) => actions.go(id, by), // AWAITING_GO -> open the work (without --force: a failing lint or assignment returns !ok and leaves it to a human)
  deny: (id, by) => actions.deny(id, by), // AWAITING_GO -> send it back
  implement: (id, by) => actions.requestGateC(id, by), // DONE -> start the implementation
  review_pr: (id, by) => actions.requestReviewPr(id, by), // AWAITING_GATE_D -> open the PR
  merged: (id, by) => actions.ackMerged(id, by), // AWAITING_HUMAN_MERGE -> confirm it was merged (without --force)
  retry: (id, by) => actions.retry(id, by), // *_FAILED -> retry (the real action authorises against the gate that failed)
};

// State -> the action keys the panel offers in that state (**the single source of truth**: the board's detail
// view renders its buttons from this, and the real validation still lives in the action being called).
const BY_STATE: Partial<Record<State, string[]>> = {
  GATE_A_STALLED: ['confirm'],
  CONFIRMED: ['gateb'],
  GATE_B_STALLED: ['force_go'],
  AWAITING_GO: ['go', 'deny'],
  DONE: ['implement'],
  AWAITING_GATE_D: ['review_pr'],
  AWAITING_HUMAN_MERGE: ['merged'],
  GATE_A_FAILED: ['retry'],
  GATE_B_FAILED: ['retry'],
  GATE_C_FAILED: ['retry'],
  GATE_D_FAILED: ['retry'],
  WRITE_FAILED: ['go'], // WRITE_FAILED has to re-run go (planRetry returns null for it, so retry would say there is nothing to retry); go accepts WRITE_FAILED and skips what created_issues says already exists
};

// The action keys the panel offers in this state (the front end draws its buttons from it). A pure function,
// exported for unit tests.
export function panelActionsFor(state: State): string[] {
  return BY_STATE[state] ?? [];
}

// The short code a panel write action is signed with: runtime.web_actor, falling back to **that project's**
// routing.lead (configuration diverges: a project can have its own lead).
export function panelActor(pid?: string): string {
  const cfg = configForProject(pid);
  return cfg.runtime.web_actor ?? cfg.routing.lead;
}

// Run one panel action: validate the action name, resolve the requirement, record the panel_action audit
// event, and dispatch to the real action (inheriting its permissions, lint and red lines).
// An unknown action or a requirement that cannot be found -> !ok, never silence.
export async function runPanelAction(action: string, slug: string): Promise<ActionResult> {
  const fn = DISPATCH[action];
  if (!fn) return { ok: false, msg: `unknown panel action: ${action}` };
  const s = await resolveSession(slug);
  if (!s) return { ok: false, msg: `no such requirement: ${slug}` };
  // "Which buttons a state offers" has to be a write-gateway policy, not merely what the front end displays:
  // the server checks again that the action is in the current state's BY_STATE. Otherwise someone could
  // bypass the interface and POST an action that the real action happens to allow in that state but the panel
  // policy does not offer (forcing a confirm on a session that is not stalled, say).
  if (!panelActionsFor(s.state).includes(action)) {
    return { ok: false, msg: `the action ${action} is not available in the state ${s.state}` };
  }
  const by = panelActor(s.project_id);
  await appendEvent(s.id, 'panel_action', { action, by }); // the audit trail records where this came from: the web panel (the action being called records its own events too)
  return fn(s.id, by);
}
