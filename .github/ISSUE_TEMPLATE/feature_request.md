---
name: Feature request
about: Propose a change to the core, or a seam that downstream needs
title: ''
labels: enhancement
---

<!-- Issues, comments and PRs in this repository are written in English. See CONTRIBUTING.md. -->

## The need

What are you trying to do that the current code makes hard or impossible?

## Where it should land

AGENTS.md has a four-level table for this. Which one is it, and why?

- [ ] **L0** — lives outside the core, calling it as a CLI/library. Nothing changes here.
- [ ] **L1** — hangs off an existing seam (prompts, config, an `ExtensionPack` command/hook/doc source).
      Nothing changes here.
- [ ] **L2** — needs a new *neutral* mount point here; the implementation stays downstream.
- [ ] **L3** — needs to change existing core behaviour.

If L2: what would the hook be called? The name must describe the core's own lifecycle, not the need
behind it — `onTransition`, not `registerBillingHook`.

## Alternatives considered

<!-- Frequent L3 usually means an abstraction is wrong rather than that the rule is inconvenient.
     If this is L3, say which abstraction you think is off. -->
