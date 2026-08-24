# Security Policy

Breakside is beta software maintained by one person in their spare time. There
is no security team and no bug bounty. Reports are still very welcome — please
just calibrate your expectations accordingly.

## Reporting a vulnerability

**Please do not open a public GitHub issue for a security problem.** A public
issue is visible to everyone the moment it is filed, including before there is
a fix.

Use one of these instead:

1. **GitHub private vulnerability reporting** — go to the repository's
   **Security** tab and choose **Report a vulnerability**. This creates a
   private draft advisory visible only to the maintainer.
   TODO(owner): confirm private vulnerability reporting is enabled for this
   repository (Settings → Advanced Security → Private vulnerability reporting).
   If it is off, this link does not appear and finders have no private route.
2. **Email** — TODO(owner): add a monitored address for security reports. Do
   not assume the address in the git commit history is the right one; pick an
   address you actually watch, and consider a dedicated alias.

Please include enough for the problem to be reproduced: the URL or endpoint,
what you did, what you got back, and why you believe it is a problem. A
proof-of-concept request or a short screen recording helps a lot.

## What to expect

- **Acknowledgement:** best effort, usually within a week.
- **Fix:** no committed timeline. Breakside is a side project. Serious issues
  (anything exposing other people's data) get priority over everything else.
- **Credit:** happy to credit you in the fix commit or release notes if you
  want it, and happy to keep you anonymous if you don't.
- **Bounty:** none. There is no money in this project.

## Scope

In scope:

- The web app at `www.breakside.pro` and `staging.breakside.pro`
- The API at `api.breakside.pro`
- The public game viewer served at `/viewer/` and `/view/{hash}`
- The code in this repository, including the deploy scripts under `scripts/`
  and the GitHub Actions workflow

Out of scope:

- **Third-party services.** Supabase (authentication), OpenAI (speech
  transcription), Anthropic (narration processing), Google (fonts and OAuth),
  Cloudflare's cdnjs (icon font), and AWS (hosting) each run their own
  disclosure programs — report issues in their infrastructure to them. A
  *misconfiguration on Breakside's side* of one of those integrations is in
  scope.
- Volumetric denial of service, load testing, or anything that degrades
  service for real users mid-game.
- Social engineering of the maintainer or of any Breakside user.
- Attacks that require an already-compromised device, browser, or account.
- Reports consisting only of automated-scanner output with no demonstrated
  impact, and best-practice observations with no exploit path (missing
  hardening headers, TLS cipher preferences, and similar). These are still
  useful — just file them as normal public issues rather than as
  vulnerabilities.

## Testing rules

Breakside holds rosters of real people, some of them minors. When testing:

- Use your own account, your own team, and your own test data.
- Do not access, modify, or download another user's teams, players, or games.
  If a bug gives you access to someone else's data, stop, note what you saw,
  and report it — do not enumerate further and do not keep a copy.
- Do not delete or corrupt data you did not create.
- Prefer `staging.breakside.pro` over production where the bug reproduces
  there. Note that staging currently talks to the **production API**, so
  server-side testing on staging still touches real data — be careful.

Testing that follows these rules will not be treated as an attack.

## Known limitations

These are documented deliberately rather than reported as vulnerabilities:

- Anyone holding a share-link URL can view that game, without signing in.
  Share links are unguessable and expire, but they are not access-controlled.
  See [privacy.html](privacy.html).
- Deleting a player removes them from the roster but does not erase historical
  game records that already reference them, and there is no self-service
  account deletion. See the privacy policy for how to request removal.

Last updated: 2026-08-24
