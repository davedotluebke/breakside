# Running the test suites

Status: current as of 2026-09-05.

## Backend

`pytest breakside_server/` from the repo root. Since July 2026 the suite is isolated via `tmp_path_factory` in each test file (there is no data-dir isolation in `conftest.py`; it only registers the `live_llm` marker). Running the suite from a checkout older than that writes fixture teams and players into the real `data/` directory; that happened four times in one morning before the fix. Rebase old worktrees onto main before running backend tests.

## Frontend unit tests

```bash
node --test 'tests/unit/*.test.mjs'
```

Quote the glob. On Node 25 the bare directory form (`node --test tests/unit/`) fails with "Cannot find module". `tests/package.json`'s `npm test` is the Playwright suite, not these.

### `node --check` is a silent no-op on this repo's modules

Verified 2026-08-24 on Node 25.8. `node --check file.js` parses a bare `.js` file as CommonJS. If the file contains `import` or `export`, which every frontend module here does, it exits 0 regardless of syntax errors:

```
printf 'const = 1;\n'                          > a.js   # node --check a.js -> exit 1 (caught)
printf 'import{a}from"./x.js";\nconst = 1;\n'  > b.js   # node --check b.js -> exit 0 (MISSED)
```

Use one of:

```bash
node --input-type=module --check < path/to/file.js
cp file.js /tmp/x.mjs && node --check /tmp/x.mjs
```

The extension drives the parse goal, and there is no root `package.json` with `"type": "module"`.

## Playwright e2e

Ports are derived per worktree in `tests/helpers/constants.ts`: `slot = fnv1a(repoRoot) % 800`, frontend `3100 + slot`, backend `8200 + slot`. Concurrent worktrees never collide or silently reuse each other's servers. Overrides: `BREAKSIDE_E2E_FRONTEND_PORT`, `BREAKSIDE_E2E_BACKEND_PORT`. The ranges avoid dev-server 3000, human worktree ports 3001 and up, backend 8000, and `dev-backend.sh`'s 8000 to 8099 auto-pick.

From a worktree:

```bash
cd <worktree>/tests && npm ci && npx playwright install chromium   # each worktree needs its own node_modules
CI=1 npx playwright test                                            # CI=1 forces fresh servers from THIS worktree
```

Flakiness was root-caused in July 2026: specs raced the offline-first first game sync (controller endpoints 404 until it lands; `waitForGameOnServer` in `tests/helpers/controllerApi.ts` fixes that) and slept fixed margins against server staleness (now condition-polls). `retries: 2` is still configured and could probably drop. Known gap: the `visibilitychange` wake handler is not exercised by spec 04. See also the multi-coach trap in [polling-and-multi-coach.md](polling-and-multi-coach.md).

The pre-merge hook on the main checkout runs this whole suite on non-fast-forward merges into `main`.
