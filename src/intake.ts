import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { store as sessions } from './store/index.ts'; // through the SessionStore seam (the selection point), never straight to store/sessions.ts
import { readDoc, formatRef, registeredIds, type DocRef } from './docs/index.ts';
import { port } from './messaging/index.ts';
import { sessionLogDir } from './util/render.ts';
import { deriveSlug, slugify, shortId } from './util/slug.ts';
import { runClaudeBare } from './llm/runClaude.ts';
import { project, projectForChat, defaultProjectId } from './projects.ts';
import { resolveTargetRepos } from './util/targetRepos.ts';
import { reqRef, stateLabel } from './util/display.ts';
import { log } from './util/log.ts';
import type { Session } from './types.ts';

// A title or PRD is often written in a non-Latin script, which makes slugify come back empty (source is
// English, input is not). Best-effort: ask claude for an English kebab-case slug, falling back to req-<id>.
async function proposeSlug(title: string, prdText: string): Promise<string | null> {
  const direct = slugify(title);
  if (direct) return direct; // the title already has usable ASCII, so no call is needed
  const out = await runClaudeBare(
    `Give the requirement below a kebab-case slug of 3-5 English words (all lowercase, hyphen-separated, ` +
      `a-z0-9 only) that captures what it does, e.g. finance-points-report. **Output the slug and nothing ` +
      `else.**\n\nTitle: ${title}\n\nSummary: ${prdText.slice(0, 600)}`,
  ).catch(() => null);
  return out ? slugify(out) || null : null;
}

export interface AddOpts {
  // The requirement document's reference (**already claimed and parsed by a document source**). Callers:
  // listen and the backfill get it from claimDocs, and the CLI from parseAnyRef.
  // A ref is passed rather than a URL because only the source knows which source a string belongs to and what
  // its id is within that source — making intake guess again would copy the source's knowledge into the core.
  doc: DocRef;
  slug?: string;
  title?: string;
  projectId?: string; // the target project (by default it resolves through the channel-to-project mapping, then the default project)
  branch?: 'prod' | 'dev';
  chatId?: string;
  posterId?: string; // the id of whoever posted the PRD, in that IM (used to @ them in the channel)
  intakeMsgId?: string; // the id of product's message (the bot replies beneath it with the status card)
}

type AddResult = { ok: boolean; session?: Session; created?: boolean; duplicate?: boolean; msg: string };

// The single reply for a duplicate PRD (the wiring's pre-check and the concurrency-race fallback share this
// wording).
function dupResult(existing: Session): AddResult {
  return {
    ok: true,
    session: existing,
    created: false,
    duplicate: true,
    msg: `This requirement has already been reviewed (${reqRef(existing)}, currently: ${stateLabel(existing.state)}). Submitting it again will not start another review.`,
  };
}

// The V1 entry point: register a PRD by hand (read the document, then create a session). In V2 a channel
// message and the backfill call the same function.
export async function addPrd(o: AddOpts): Promise<AddResult> {
  if (!o.doc?.token) return { ok: false, created: false, msg: 'the requirement document is missing (--prd <link>)' };
  if (!registeredIds().includes(o.doc.source)) {
    // An unregistered source is never swallowed silently: registering it would produce a requirement whose
    // body can never be read, and it would simply sit parked forever.
    return { ok: false, created: false, msg: `unregistered document source "${o.doc.source}" (registered: ${registeredIds().join('/') || 'none'})` };
  }
  const ref = formatRef(o.doc);
  const url = o.doc.url ?? null;

  // PRD-level deduplication: one PRD means one thing, and it must not be duplicated anywhere from the wiring
  // through to the issues and the PR.
  // It looks up doc_ref (every URL variant and query parameter has already been normalised by the source into
  // one token, prefixed with the source's id), and blocks before reading the document, which saves a network
  // read.
  // findByPrdUrl is the fallback for the older path, left over from when deduplication was on the exact URL,
  // before doc_ref.
  const existing = (await sessions.findByDocRef(ref)) ?? (url ? await sessions.findByPrdUrl(url) : null);
  if (existing) return dupResult(existing);

  const prd = await readDoc(o.doc);
  if (!prd.ok) {
    return { ok: false, msg: `could not read the requirement document (${o.doc.source}): ${prd.error}` };
  }

  const firstLine = prd.text.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '';
  const title = (o.title?.trim()) || firstLine.slice(0, 80) || o.slug || url || o.doc.token;
  // Slug precedence: an explicit --slug > the English slug claude proposes (when the title has no usable
  // ASCII) > the req-<id> fallback
  let slug = o.slug ? deriveSlug(title, o.slug) : '';
  if (!slug) {
    const proposed = await proposeSlug(title, prd.text);
    if (proposed) log.info(`slug: claude proposed ${proposed}`);
    slug = proposed || deriveSlug(title);
  }
  // Binding the target project: an explicit --project > the channel-to-project mapping (projects.yaml chats)
  // > the default project. It is fixed when the session is created and never changes.
  const projectId = o.projectId ?? projectForChat(o.chatId) ?? defaultProjectId();
  const proj = project(projectId);
  const branchKind = o.branch ?? proj.defaultBranch;
  const branch = proj.branches[branchKind];
  const id = `${slug}-${shortId()}`;

  const dir = sessionLogDir(id);
  const prdPath = resolve(dir, 'prd.txt');
  writeFileSync(prdPath, prd.text);

  let s: Session;
  try {
    s = await sessions.create({
      id,
      slug,
      title,
      project_id: projectId, // the explicit flag / the channel-to-project mapping / the default project (see above)
      branch,
      prd_url: url,
      prd_text_path: prdPath,
      doc_ref: ref,
      // With no source channel (a manual `forge add`) it falls back to **the current provider's first watched
      // channel** — hardcoding one provider's env var would have a Slack deployment attach its status card to
      // a channel belonging to the other provider.
      chat_id: o.chatId ?? port.watchedChats()[0] ?? null,
      poster_id: o.posterId ?? null,
      intake_msg_id: o.intakeMsgId ?? null,
    });
  } catch (e) {
    // The last gate against a concurrency race: another submission with the same doc_ref inserted first while
    // this one was reading the document, so the unique index rejects this insert.
    // It falls back to the deduplication path and reuses the one that got there first, never creating the
    // requirement twice (which is what "not duplicated anywhere" means in practice).
    if (sessions.isDuplicateDocRefError(e)) {
      const winner = (await sessions.findByDocRef(ref)) ?? (url ? await sessions.findByPrdUrl(url) : null);
      if (winner) {
        log.info(`a PRD concurrency race: reusing ${winner.slug} (${winner.id}), which got there first`);
        return dupResult(winner);
      }
    }
    throw e; // any other database error is thrown as usual (the worker and the CLI report it)
  }
  return {
    ok: true,
    session: s,
    created: true,
    msg: `✓ session ${id} created (slug=${slug}, branch=${branch}). Run Gate A: ./forge tick`,
  };
}

// The standalone entry point (a bare issue): it skips Gates A and B and creates a task straight into Gate C
// (implementation plus local CI).
// It shares Gate C's engine with the chained path (DONE -> implement); the only difference is that there is
// no outer-ring acceptance contract, so the target criteria fall back to "CI is green plus the issue's
// acceptance points" — weaker, and noted in the event stream.
export interface ImplementTaskOpts {
  issueRef: string; // the deduplication key: owner/repo#n, or the issue's URL
  title: string;
  body?: string; // the issue's body (the CLI can prefetch it with gh; without it, only the title is used)
  projectId?: string;
  repo?: string; // which repo to change in a multi-repo project (defaulting to the project's first)
  branch?: 'prod' | 'dev';
  by: string;
}

export async function addImplementTask(o: ImplementTaskOpts): Promise<AddResult> {
  if (!o.issueRef) return { ok: false, created: false, msg: 'missing --issue <owner/repo#n or URL>' };
  if (!o.title?.trim()) return { ok: false, created: false, msg: 'missing --title (a standalone bare issue needs a title; gh can prefetch it)' };
  const existing = await sessions.findByIssueRef(o.issueRef);
  if (existing) {
    return {
      ok: true,
      session: existing,
      created: false,
      duplicate: true,
      msg: `an implementation task already exists for this issue (${reqRef(existing)}, currently: ${stateLabel(existing.state)}); it is not created twice.`,
    };
  }
  const projectId = o.projectId ?? defaultProjectId();
  const proj = project(projectId);
  // standalone --repo is normalised through repoMap (a letter C/U/A/E or a repo name both work); given
  // explicitly it must be a valid repo of that project, so an implementation worktree or PR is never created
  // in the wrong one. Not given -> it falls back to the first repo (resolveTargetRepos handles it).
  const repoNorm = o.repo ? (proj.repoMap[o.repo] ?? o.repo) : undefined;
  if (o.repo && (!repoNorm || !proj.repos.includes(repoNorm))) {
    return { ok: false, created: false, msg: `✗ --repo ${o.repo} is not among the project ${projectId}'s repos (${proj.repos.join(', ')})` };
  }
  const targetRepos = resolveTargetRepos(repoNorm ? [repoNorm] : [], proj.repos, proj.repoMap);
  const branch = proj.branches[o.branch ?? proj.defaultBranch];
  const title = o.title.trim();
  const slug = deriveSlug(title);
  const id = `${slug}-${shortId()}`;
  // Write the implementation context to disk (Gate C's gateCContext reads it when there is no Gate B draft).
  writeFileSync(resolve(sessionLogDir(id), 'gatec-input.md'), `# ${title}\n\nFrom issue: ${o.issueRef}\n\n${o.body ?? '(no body; implement from the title and the existing code)'}`);
  let s: Session;
  try {
    s = await sessions.create({
      id, slug, title, project_id: projectId, branch,
      state: 'GATE_C_REQUESTED', source_kind: 'issue', issue_ref: o.issueRef,
    });
  } catch (e) {
    // The last gate against a concurrency race: another row with the same issue_ref inserted first after this
    // findByIssueRef, so the unique index rejects this insert.
    // It falls back to deduplication and reuses the one that got there first, never creating the
    // implementation task twice (which would mean a duplicate worktree and PR).
    if (sessions.isDuplicateIssueRefError(e)) {
      const winner = await sessions.findByIssueRef(o.issueRef);
      if (winner) {
        log.info(`a standalone concurrency race: reusing ${winner.slug} (${winner.id}), which got there first`);
        return {
          ok: true,
          session: winner,
          created: false,
          duplicate: true,
          msg: `an implementation task already exists for this issue (${reqRef(winner)}, currently: ${stateLabel(winner.state)}); it is not created twice.`,
        };
      }
    }
    throw e; // any other database error is thrown as usual
  }
  await sessions.patch(s.id, { gate_c_requested_by: o.by, target_repos: JSON.stringify(targetRepos) });
  log.info(`standalone implementation task ${reqRef(s)} (${o.issueRef}) -> straight into Gate C`);
  return {
    ok: true,
    session: (await sessions.get(s.id))!,
    created: true,
    msg: `✓ implementation task ${id} created (${o.issueRef}) -> straight into Gate C. The next ./forge tick creates the worktree, implements, and runs local CI automatically.`,
  };
}
