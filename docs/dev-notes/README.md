# Dev notes

One file per topic: the things about a feature or a workflow that are **not derivable from the code or git history**. Why a design landed the way it did, which alternatives were rejected, the traps that cost real time, and how to verify the thing. ARCHITECTURE.md describes how the system works; these describe what we learned building it.

Conventions:

- Every note opens with a `Status:` line (shipped / in progress / unmerged / superseded) and a last-verified date. Absolute dates only.
- Plain Markdown, relative links. No tool-specific syntax; these are meant to be read by any contributor or any AI agent.
- Do not restate what ARCHITECTURE.md already says; link to the section.
- Nothing about the production deployment goes here. That lives in the private `breakside-ops` repo.

These notes were seeded on 2026-09-05 from an AI agent's per-project memory, verified against the tree at that date. Later notes are added as topics come up.

| Note | Topic |
|---|---|
| [dark-mode.md](dark-mode.md) | Theme verification workflow and open questions |
| [e2e-and-unit-tests.md](e2e-and-unit-tests.md) | Per-worktree e2e ports, the `node --check` trap, data-dir hygiene |
| [es-modules-migration.md](es-modules-migration.md) | What the ESM migration changed and the bugs it shook out |
| [fastpass-eval.md](fastpass-eval.md) | Narration fast-pass Phase 1 results (branch `fastpass-eval`, unmerged) |
| [invite-url-flow.md](invite-url-flow.md) | Why `/join/<code>` works the way it does, and how to test it locally |
| [logo-wordmark.md](logo-wordmark.md) | Wordmark rollout, iOS notch decision, remaining spots |
| [on-deck-line.md](on-deck-line.md) | Design convergence and conventions for `pendingNextLine` fields |
| [player-elevation.md](player-elevation.md) | Player privacy/linking design; Phase 1 shipped, rest unbuilt |
| [polling-and-multi-coach.md](polling-and-multi-coach.md) | The constraints behind the solo-coach ping backoff |
| [possession-sets.md](possession-sets.md) | Set tracking: the design call and three bug patterns |
| [preview-testing.md](preview-testing.md) | Driving game flows in an in-IDE browser preview |
| [share-links.md](share-links.md) | Same-origin viewer chain and its deploy corollaries |
