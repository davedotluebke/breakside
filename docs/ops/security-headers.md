# Security response headers

Breakside currently sends **no** security response headers on either origin — no
CSP, HSTS, `X-Frame-Options`, `X-Content-Type-Options`, or `Referrer-Policy`.
This runbook applies them.

Two origins, two mechanisms, because only one of them is behind CloudFront:

| Origin | Serves | Mechanism |
|---|---|---|
| `www.breakside.pro`, `staging.breakside.pro` | the PWA, landing, docs, `/viewer/` | CloudFront response-headers policy |
| `api.breakside.pro` | the FastAPI backend | nginx `add_header` — **direct CNAME to EC2, no CloudFront** |

Distribution IDs are in `ARCHITECTURE.md` § Deployment. Interactive `aws`
commands need `--profile admin`; there is no usable default profile.

---

## Why this matters here specifically

A CSP is the durable defence against the *next* XSS, as opposed to the ones
already fixed. Two of the four code-reds found in the August 2026 audit would
have been contained by a single directive each:

- `connect-src` would have neutralised the `?api=<url>` token-exfiltration bug
  regardless of the JavaScript flaw, because the browser would have refused to
  send anything to `evil.example`.
- `script-src` would have contained the stored XSS in the public viewer, which
  executed on the same origin as the Supabase refresh token.

`Referrer-Policy` matters more than usual for this app because share hashes and
invite codes live in **URL paths** (`/view/{hash}`, `/join/{code}`), so a
cross-origin request leaks a capability token in the `Referer` header. The
current pages load Google Fonts and cdnjs on exactly those routes.

---

## Phase 1 — apply, report-only

`scripts/cloudfront-security-headers.json` ships the CSP as
**`Content-Security-Policy-Report-Only`**. It is the single most likely thing in
this whole security programme to break the app silently, so it does not enforce
on first application. Everything else in the policy (HSTS, frame options,
nosniff, referrer policy) *does* take effect immediately — those are safe.

```bash
aws cloudfront create-response-headers-policy --profile admin \
  --response-headers-policy-config file://scripts/cloudfront-security-headers.json
```

> **The CloudFront Free pricing plan blocks this step.** (Found by doing it,
> 2026-09-02.) The staging distribution is on the Free plan, and
> `update-distribution` refuses a *custom* response-headers policy with
> "Distributions with the Free pricing plan can't have the following features:
> Custom response headers policy". Prod was created the same way, so assume the
> same until the console says otherwise (distribution → General → Pricing plan;
> an `aws-cli` older than late 2025 does not show the field at all).
>
> What the Free plan *does* allow is AWS's **managed** policy
> `Managed-SecurityHeadersPolicy` (`67f7725c-6f97-4210-82d7-5512b31e9d03`):
> HSTS, `nosniff`, `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy` and
> `X-XSS-Protection` — everything in this runbook **except the CSP**. It is
> attached to staging as an interim.
>
> To get the CSP through CloudFront, move the distribution to the standard
> pricing plan; the custom policy created above survives and attaches
> afterwards. The alternative with no billing change is an **enforcing**
> `<meta http-equiv="Content-Security-Policy">` in `index.html` — but meta
> ignores `Report-Only` and `frame-ancestors`, so there is no watch phase:
> exercise it on staging (which deploys the working tree) and treat staging as
> the report-only environment before it reaches prod.

Note the returned `Id`, then attach it to each distribution's default cache
behaviour. This is a read-modify-write of the distribution config, so do it one
at a time and keep the `ETag`:

```bash
DIST=<distribution-id>          # prod, then repeat for staging
aws cloudfront get-distribution-config --profile admin --id "$DIST" \
  > /tmp/dist.json
# Set DefaultCacheBehavior.ResponseHeadersPolicyId to the new policy Id.
# Keep every other field byte-identical.
aws cloudfront update-distribution --profile admin --id "$DIST" \
  --if-match "$(python3 -c 'import json;print(json.load(open("/tmp/dist.json"))["ETag"])')" \
  --distribution-config file:///tmp/dist-config-edited.json
```

Verify:

```bash
curl -sI https://www.breakside.pro/ | grep -iE 'strict-transport|x-frame|x-content|referrer|content-security'
```

## Phase 2 — watch

`Content-Security-Policy-Report-Only` prints violations to the browser console
and does not block anything. There is **no `report-uri`/`report-to` endpoint**
configured, deliberately — standing up a report collector is more work than this
project warrants right now, and the console is sufficient for a single-operator
beta.

So "watching" means: open each surface with devtools console visible and
exercise it.

- [ ] PWA: sign in, pick a team, start a game, record a few points, export xlsx
- [ ] **Voice narration** — the highest-risk surface. It opens a WebSocket to
      `wss://api.openai.com/v1/realtime`, which is why `connect-src` names it.
      If that directive is wrong, narration fails and nothing else does.
- [ ] Team settings → set a team icon from a URL (exercises `/api/proxy-image`)
- [ ] Public viewer via a real share link, signed out, in a clean profile
- [ ] Landing page and the `/join/{code}` invite flow
- [ ] Offline: load, kill the network, reload (service worker + manifest)

## Phase 3 — enforce

Only once Phase 2 is clean. Edit the policy so the header name is
`Content-Security-Policy` instead of `Content-Security-Policy-Report-Only`, keep
the value identical, and `update-response-headers-policy`. Roll back by renaming
it back — that is the whole reason to keep the value unchanged between phases.

---

## Directive rationale

Each of these was checked against what the pages actually load, not assumed.

| Directive | Value | Why |
|---|---|---|
| `script-src` | `'self' 'unsafe-inline'` | `index.html` has several inline `<script>` blocks that must run before the module graph (staging detection, the `/view/{hash}` redirect shim). `'unsafe-inline'` is unavoidable without refactoring those into files. **This is the weakest part of the policy** — it means the CSP does not fully stop injected inline script. It still blocks external script origins, which is most of the value. Removing it is a worthwhile follow-up; a nonce would need the HTML to be templated, which it currently isn't. |
| `connect-src` | `'self' https://api.breakside.pro https://mfuziqztsfqaqnnxjcrr.supabase.co wss://api.openai.com` | The API, Supabase auth, and the narration Realtime socket. **Omitting the `wss:` entry silently breaks narration.** This is the directive that would have contained the `?api=` bug. |
| `style-src` | `'self' 'unsafe-inline' fonts.googleapis.com cdnjs.cloudflare.com` | Google Fonts and Font Awesome are loaded as external stylesheets. Self-hosting both would let this tighten to `'self'` and would also remove a third-party IP/User-Agent disclosure on the public viewer. |
| `font-src` | `'self' fonts.gstatic.com cdnjs.cloudflare.com` | Where those two stylesheets pull their font files from. |
| `img-src` | `'self' data:` | **Verified, not assumed:** team icons are *not* external URLs. `POST /api/proxy-image` returns `{"dataUrl": "data:<mime>;base64,..."}` and `teams/teamSettings.js` assigns that to `team.iconUrl`; there is no fallback path that stores a raw remote URL. So `data:` covers icons and no wildcard is needed. If a future change stores remote URLs directly, this directive breaks icons — check here first. |
| `script-src` external | *(none)* | The Supabase SDK and xlsx are vendored under `vendor/`, so there is no external `<script src>` anywhere. Keep it that way; re-introducing a CDN script would need this directive widened. |
| `frame-ancestors` / `X-Frame-Options: DENY` | — | Nothing embeds Breakside. Both are set; `frame-ancestors` is the modern one and `X-Frame-Options` covers older agents. |
| `object-src`, `frame-src` | `'none'` | No plugins, no iframes. Free hardening. |
| `base-uri`, `form-action` | `'self'` | Blocks `<base>` hijacking and off-origin form posts. |
| `media-src` | `'self'` | The tutorial clips under `docs/clips/` are same-origin. |
| `worker-src`, `manifest-src` | `'self'` | Service worker and PWA manifest. |
| HSTS | `max-age=31536000; includeSubDomains` | `preload` is deliberately **off** — preload is effectively irreversible and should not be set until subdomain coverage is certain. |

---

## The API origin — nginx, not CloudFront

`api.breakside.pro` is a direct CNAME to EC2, so the CloudFront policy does not
apply to it. A CSP is close to pointless on a JSON API, but HSTS and nosniff are
not, and the API also serves `/join/{code}` and `/view/{hash}` redirects.

Add to the `server` block in `/etc/nginx/conf.d/` (read the existing file first —
nginx there serves the apex domains too, not just the API):

```nginx
add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
add_header X-Content-Type-Options "nosniff" always;
add_header Referrer-Policy "strict-origin-when-cross-origin" always;
add_header X-Frame-Options "DENY" always;
```

The `always` matters: without it nginx omits the header on error responses,
which are exactly the ones an attacker is most likely to provoke.

Two nginx cautions:
- `add_header` at a lower level **replaces** all inherited headers rather than
  merging. If any `location` block already sets one, these must be repeated
  there.
- Reload, don't restart: `sudo nginx -t && sudo systemctl reload nginx`.

---

## Not done here

- No CSP report collector (`report-uri`/`report-to`). Console-only, by choice.
- Nothing has been applied — this document and the JSON are the whole change.
- The `'unsafe-inline'` in `script-src` is a known weakness, recorded above
  rather than solved.
