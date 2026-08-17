# Handoff: offline-first fixes → staging

Disposable — delete once the branch is merged and staging is signed off.

## State

| | where | what |
|---|---|---|
| Code fixes (audit 1a–1d) | `claude/breakside-offline-audit-8ux2js` @ `4ecf0fb` | pushed, **not merged** |
| README wording | `main` @ `112cb1f` | pushed |
| Audit + TODO | same branch | `docs/offline-no-account-audit.md`, TODO.md § *Offline reliability, and account-free solo use* |

Suites green as of `4ecf0fb`: **27 e2e, 198 unit, 339 backend**.

**No backend changes in this branch** — nothing under `ultistats_server/`, so
**no EC2 restart is needed** for any of this.

## The one blocked task

Deploying to staging needs real AWS credentials; the cloud sandbox only has the
agent proxy's placeholder key (`AWS_ACCESS_KEY_ID` starts with `prox`). Everything
else about the deploy is pre-verified: build stamping produces build 138 /
`build-138-stg-<stamp>`, and the 135-file upload set includes the new
`vendor/supabase-js.min.js` (checked against `deploy-excludes.txt` — that file
*not* shipping is the one way this deploy could go badly wrong).

```bash
git fetch origin claude/breakside-offline-audit-8ux2js
git checkout claude/breakside-offline-audit-8ux2js
./scripts/deploy-staging.sh "offline-first"
```

**First thing after deploying**, 10 seconds and worth it — `index.html` now hard-depends
on this file, and a 404 here means a dead app, not a degraded one:

```bash
curl -sI https://staging.breakside.pro/vendor/supabase-js.min.js | head -1   # expect 200
```

## What to test on staging (the parts a sandbox can't prove)

Ordered by what would hurt most if wrong. All of this needs a **real phone**;
the first is the whole point of the change.

1. **Offline launch — the §4 fix.** Sign in on staging, load the app, then turn on
   airplane mode, force-quit, and relaunch. **Expect: the app opens to your teams.**
   Before this branch it bounced to the landing page, because supabase-js came from
   a CDN the service worker could never cache. Do this both in the browser and as
   an installed PWA. Leave it in airplane mode a day and repeat if you can — the
   old behavior was HTTP-cache roulette, so a single pass isn't proof.

2. **Sign-out guard (1a).** Record a point with no signal, then tap Sign Out.
   Expect a prompt naming the pending count and saying the data will be erased.
   Cancel → nothing lost, button returns to "Sign Out". Then reconnect and sign
   out normally — with the queue drained it should *not* prompt at all.

3. **Storage tier (1c) — genuinely unknown, please report back.** Tap the
   Online/About status; it now shows `Storage: durable` or
   `Storage: best-effort (may be evicted)`. Headless Chromium denied the grant,
   so I don't know what real iOS Safari and Android Chrome do, installed vs not.
   That answer decides whether 1c actually bought us anything.

4. **Update guard (1d).** Mid-game, About → "Update Now". Expect a confirm
   naming the in-progress game; Cancel leaves the game running. Off the game
   screen it should update with no prompt, as before.

## Notes

- Staging talks to the **production API**, so use a throwaway team for anything
  destructive — especially test 2, which really does delete local data on accept.
- Each staging deploy suffixes the SW cacheName, so the update prompt will fire
  on devices that had staging loaded before. That's expected, not a regression.
- If you run the e2e suite locally, ignore the browser-version workaround from
  the sandbox session (symlinks under `/opt/pw-browsers`) — locally
  `npx playwright install` handles it.

## Still open

Item 2 in the TODO — **there is still no way to use Breakside without an
account**, which is where this all started. 1a–1d were the reliability problems
found along the way, not the original claim. Sub-items 2a–2e are sized there;
2d (don't let an anonymous queue 401 itself into `syncDeadLetter`) is a hard
prerequisite for 2a, and 2e needs a product call from you before it's code.

README on `main` now says an account is required, so the docs are honest in the
meantime.
