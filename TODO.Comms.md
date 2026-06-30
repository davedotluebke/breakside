# Breakside Comms — Roadmap

> **Status**: design draft, not yet implemented. This is the kickoff plan for a fresh session to take on **team communications** as a major new pillar of Breakside, separate from the stats-tracking core.
>
> The main [TODO.md](TODO.md) tracks the existing stats app. Comms is large enough — and orthogonal enough — to live in its own doc until a meaningful MVP ships. When the first v1 milestones land, the headline items will be backported to TODO.md and this doc will become the canonical detail reference.

---

## Vision

Breakside today is a stats app. Comms turns it into the **single tool a youth ultimate team uses** for everything: stats, scheduling, surveys, carpools, emergency alerts, and the day-to-day chat that today is fragmented across Slack, Discord, GroupMe, group SMS, email, and TeamSnap.

The pitch isn't "another chat app." It's:

- **Opinionated and safe by default.** SafeSport-aligned rules are baked in — no coach can have a private 1:1 conversation with a youth player or a parent. Channels and audit logs are structured so that the *right* adults see the *right* messages without any setup.
- **First-class for the team's actual workflow.** Seasons, events, rosters, carpools, RSVPs, polls — all native, not bolted on with bots.
- **Integrated with Breakside stats.** Live game scores in `#announcements`, player stat-line chips in chat, post-game auto-summaries, eventual video highlights per player.
- **Privacy-respecting.** Parents who refuse to use Google tools (real cohort) get a system that doesn't depend on Google. Phone-number onboarding. Photo opt-out enforced. Audit logs immutable.

## Non-goals (explicit)

- **No true DMs in v1.** No player↔player, no parent↔parent, no coach↔coach private chat. The only "DM-like" surfaces are pseudo-DMs that auto-include the right adults.
- **No cross-team / cross-organization messaging.** Captain-of-our-team chatting with captain-of-their-team is out of scope. Stays within one team.
- **No user-created channels in v1.** Channel taxonomy is system-managed.
- **No federation, no public channels, no share-by-link.** Membership is always explicit and identity-verified.
- **No native iOS/Android wrapper in v1.** PWA only. This caps emergency-alert delivery (no Critical Alerts on iOS, no full-screen intent on Android) — SMS is the override channel for true emergencies. Native apps are a v2 conversation.

---

## User & identity model

Three user types in the system:

| Type | Account | Role on a team |
|---|---|---|
| **Coach** | Existing (Supabase auth) | Coach on team membership |
| **Player** | **New for v1**: first-class user account. Folds in the long-deferred [player↔user linking](TODO.md#player-features) work. | Player on team membership |
| **Guardian** | **New for v1**: first-class user account. Linked to one or more players on a team. | Guardian on team membership |

**Per-team sub-roles** layered on top:

- `head_coach` — moderation powers, audit log access
- `assistant_coach` — regular coach
- `parent_coordinator` — guardian promoted to coach-level posting on `#announcements` (settable)
- `team_captain` — player promoted to coach-level posting on `#announcements` (settable)

**Multiple guardians per player** is fully supported. A player can have any number of guardian accounts linked (divorced parents, grandparent, godparent, etc.). All linked guardians receive coach↔player pseudo-DM copies.

**Onboarding**: phone-number-based.
- Phone is the primary identifier (Twilio Verify or Supabase Phone Auth on the verification leg).
- Email captured for echo/recovery, optional but recommended.
- Display name + avatar in profile; coaches can set a placeholder display name for players who don't have accounts yet.
- An invited user gets an SMS with a join link → app open → phone verify → joins the team in their assigned role.

**COPPA punt**: player accounts are 13+. Under-13 players are represented in the roster but cannot have their own account — their guardian(s) act on their behalf. The `#players` channel is hidden (or read-only — TBD) for teams where any active player is under 13, unless the head coach has explicitly enabled it.

## Hard rules (non-negotiable, server-enforced)

These live in the server's authorization layer (Postgres RLS policies if Supabase, or FastAPI middleware), **never** trusted to the client:

1. **No true 1:1 DMs exist in the app.** No private channel can have exactly two members. The minimum-membership rule is enforced on channel creation.
2. **No coach↔player private channel.** Any coach-initiated message to a player creates (or reuses) a pseudo-DM channel that *automatically* includes:
   - The player
   - **All** of the player's guardian accounts
   - **All** coaches on the team
3. **No coach↔parent private channel.** A coach-initiated message to a guardian creates a pseudo-DM channel that automatically includes:
   - The guardian
   - **All** coaches on the team
   - (NOT the other guardians of that guardian's player by default — see Open Q1)
4. **Coaches can read any channel on their team.** `#players` looks player-only to the players, but coaches see it. This is surfaced *prominently* in the channel description ("Coaches can read this channel").
5. **Coaches can post to any channel.** No channel is coach-restricted on the write side.
6. **Audit log is immutable.** Captures every message (including edits and deletes with full diff), photo upload, channel membership change, role grant/revoke, emergency broadcast (with delivery roster), survey response, and login event. Head coaches and Breakside admins can view; nobody can purge. Soft-delete only.
7. **Photo opt-out is honored at upload time.** Three states per player (set by guardian):
   - `allow` — photos OK in any team-visible channel
   - `watermark` — photos containing this player are auto-watermarked "Do Not Post / Do Not Share" before delivery
   - `block` — photos containing this player cannot be uploaded to team channels at all
   v1 enforcement is honor-system on which photos contain which player; the uploader is shown the warning and must confirm. The override is audit-logged. (v2: ML-based face detection.)
8. **No share-by-link for channels.** Every join is by explicit invite to an identified phone number.

These rules apply uniformly to all coaches, including head coaches and Breakside admins. A coach who is also a parent of a player on the team operates in whichever role the action invokes; the audit log tags it.

---

## Channel taxonomy

System-managed channel set. v1 has no user-created channels.

### Permanent team channels

Created at team creation; enable/disable per channel by head coach (some are non-disableable).

| Channel | Who's in it | Who can post | Notes |
|---|---|---|---|
| `#announcements` | Everyone on team | Coaches by default; team setting toggles captains and parent_coordinators to coach-level posting (default ON in v1; approval-queue flow deferred to v1.1+) | Cannot be disabled |
| `#coaches` | Coaches only | Coaches | Replaces the need for coach↔coach DMs in v1 |
| `#parents` | Coaches + all guardians | Coaches + guardians | |
| `#team-chat` | Everyone | Everyone in channel | |
| `#players` | Coaches (read) + players | Players + coaches | Disabled by default. Head coach enables. **Always coach-readable** — surfaced in description. |
| `#carpool` | Coaches + guardians | Coaches + guardians | |
| `#emergency-alerts` | Everyone | Coaches only | Cannot be disabled. Cannot be muted by recipients. See [Emergency broadcast](#emergency-broadcast) below. |

### Pseudo-DM channels (auto-created on first message)

These look like DMs in the UI but have ≥3 members enforced server-side. Header always shows full membership (e.g. "Coach Dave, Alice, Alice's guardians Bob & Carol, Coaches Eve, Frank, Grace").

- **Coach → Player pseudo-DM** (or player → any coach): coach + player + **all** of player's guardians + **all** coaches on the team
- **Coach → Guardian pseudo-DM** (or guardian → any coach): guardian + **all** coaches on the team
- **No coach↔coach pseudo-DM**: use `#coaches`
- **No player↔player or guardian↔guardian pseudo-DM**: use `#team-chat` or appropriate group channel

Pseudo-DM "subject lines" are optional but encouraged (e.g. "About Alice's travel for Saturday").

### Per-event channels

When an Event is scheduled (game, practice, tournament, team dinner, fundraiser), an event channel auto-spawns:

- Naming: `#sat-aug-12-vs-flying-circus` (event date + label, slugified)
- Members: everyone on the team by default; head coach can restrict (e.g. tournament travel squad only)
- Posting: open to all members
- Carpool/hotel sub-threads or sign-up surveys can be pinned in the channel header
- **Auto-archive 96 hours after event end** — channel becomes read-only but remains visible and searchable
- Head coach can un-archive at any time (for "the photos are finally posted, a month late" scenarios)

### Season archive

When a season ends, all that season's channels become read-only. Members can still read; nothing new can be posted. Starting a new season **does not** copy message history (see [Seasons](#seasons-and-the-season-copy-flow) below).

---

## Threading

Slack-style, one level of nesting:

- Thread view opens in a side panel.
- Each thread reply has a "Also post to channel" checkbox (default off).
- No nested threads.
- Reactions on individual messages, in-thread or in-main.
- Edit/delete: soft-only. Audit log holds the full diff. Edited messages show an "edited" tag in the UI.

---

## Notifications

Push delivery: **web push (VAPID)** to PWA installs on iOS 16.4+ and Android. Email and SMS echo as alternate paths (see [Echo](#echo-to-email-and-sms) below).

### Defaults

| Channel | Default | Tunable by user? |
|---|---|---|
| `#emergency-alerts` | Push + sound + vibrate; SMS + email forced ON | **No — cannot be muted** |
| `#announcements` | Push + sound on every message | Yes (mute), but a "you've muted announcements" banner appears in-app until unmuted |
| `#coaches`, `#parents`, `#team-chat`, `#carpool` | Push for @-mention, badge-only otherwise | Yes |
| `#players` | Badge-only | Yes |
| Per-event channels | Push on first message, badge-only after | Yes |
| Pseudo-DM channels | Push to all parties on every message | Yes (per-channel mute) |
| Surveys/polls targeted at you | Push on creation, push reminder T-24h if unresponded | Yes (reminders only) |

### Quiet hours

Per-user quiet hours setting (e.g. 10pm–7am) that suppresses push notifications for non-emergency channels. `#emergency-alerts` ignores quiet hours. Default off in v1; settable per user.

---

## Emergency broadcast

The "lightning is here, come get your kids" / "your kid sprained an ankle, meet me at UrgentCare" surface. The single most-important youth-team feature.

### UI

Distinct red "Emergency Alert" button on the coach UI, separate from the regular message composer. Tapping it opens a sheet:

1. **Template picker**: Weather / Injury / Travel disruption / Logistics / Custom
2. **Audience scope**:
   - All guardians (default for Weather, Logistics)
   - Guardians of a specific player (default for Injury — coach taps player)
   - Everyone on the team
3. **Free-text body** (optional; templates have sensible defaults)
4. **Send confirmation step** — see [Butt-dial protection](#butt-dial-protection)

### Delivery fan-out (server-side)

For each member of the resolved audience:

1. Web push to all their active sessions
2. SMS to their phone number — **regardless** of their normal SMS echo preference (this is the override)
3. Email — belt-and-suspenders, also overrides preference

Delivered as a single audit-logged event with per-recipient delivery status ("delivered: 14, push-only: 2, SMS-only: 1, failed: 0").

### Butt-dial protection

Must work with a **single coach** present, but resistant to accidental pocket taps. Mechanism:

1. The Emergency Alert button requires a **long-press of 1.5 seconds** to open the sheet (prevents inadvertent taps).
2. The send confirmation step shows a **4-digit code** generated client-side (e.g. "7392") and an empty number-pad. The coach must type the code to send. This defeats butt-dial / pocket-tap end-to-end without needing a second human.
3. **Rate limit**: max 3 emergency broadcasts per team per hour, server-enforced. Returns a clear error if hit.
4. (Optional, v1.1) **Second-coach approval** for non-emergency-template messages: if a coach selects "Custom" template and another active coach is online, the second coach gets a 60-second approval prompt before send. Skipped if only one coach is online.

---

## Surveys, polls, and sign-ups

First-class object type, not "a message with reactions." Stored separately, queryable.

### Survey types

- **Single-choice poll** ("Practice Tuesday at 6 or 7pm?")
- **Multi-choice** ("Which weeks can you attend the summer clinic?")
- **Yes/No** (RSVP — special-cased)
- **Free-text** ("Anything we should know for travel?")
- **Sign-up slots** (driver: 4 slots × 4 passengers, hotel: room slots) — first-come-first-served with optional waitlist
- **Date/time picker** ("When does weekly practice work? Pick all that apply.")

### Audience targeting

Audience is a **query**, not a static list, so members joining mid-season auto-included in active recurring surveys:

- Roles: any combination of `coaches`, `players`, `guardians`, `captains`, `parent_coordinators`
- Saved groups: e.g. "starters," "travel squad" (head-coach-managed)
- Individual ad-hoc additions
- Filter expressions: "guardians of [player X]," "anyone who hasn't responded to [other survey]"
- **Explicit `target_guardian` flag**: even for player-related questions, this flag routes the question to the guardian instead of the player. Coach picks at survey creation.

### Recurrence

- One-shot
- Weekly recurring (e.g. "Tuesday practice attendance?")
- Auto-reminder at T-24h to unresponded users (push, with optional email/SMS echo per their settings)

### Response visibility

- `coach_only` — coach sees individual responses; nobody else
- `anonymous` — channel sees aggregate counts only; coach sees individuals
- `public` — channel sees individual responses

Coach always sees individual responses regardless of setting.

### Carpool / hotel sign-ups

These are surveys with `sign_up_slots` type and a UI template:

- **Carpool**: each driver creates their own slot ("Bob, mini-van, 4 seats, departing 6:45am") with passenger sub-slots. Guardians sign up their player(s) into any open passenger slot. Waitlist if all full.
- **Hotel rooms**: head coach defines rooms (e.g. "Room 217: 2 beds"). Guardians sign players in. Coach approval optional.

---

## Echo to email and SMS

Per-user × per-channel-category preferences:

| Channel category | Default email echo | Default SMS echo |
|---|---|---|
| `#emergency-alerts` | Forced ON (cannot disable) | Forced ON (cannot disable) |
| `#announcements` | ON | OFF |
| Pseudo-DMs to me | ON | OFF |
| `#parents`, `#carpool` | OFF | OFF |
| `#team-chat`, `#players` | OFF | OFF |
| Per-event channels | OFF | OFF |
| Surveys/polls targeted at me | ON | OFF |

**SMS replies**: not supported in v1 (cost + complexity). Outbound SMS includes a deep link to open the app and reply, plus an option to "Reply by email if configured."

**Email replies**: supported. Inbound email goes to a unique `team-<id>+channel-<id>+user-<id>@reply.breakside.pro` address baked into outbound mail; replies post as a message attributed to the verified sender. Quote-stripping required.

**Cost note**: SMS at scale is material (~$0.008/segment via Twilio). For one team (current state) this is rounding error. Plan for tiering: free tier gets emergency-only SMS; paid tier gets full SMS echo. Not blocking for v1.

---

## Audit log & moderation

### What's logged

Every:
- Message (post, edit, soft-delete) — with full content + diff history
- Photo/file upload (with opt-out warnings shown + overrides)
- Channel membership change
- Role grant or revoke
- Emergency broadcast (with full delivery roster + per-recipient status)
- Survey creation + response
- Login event (timestamp, IP, user agent)
- Mute / suspend / unsuspend actions

### Access

- **Head coach** of the team: full read access via an in-app audit log viewer (filter by user, channel, action type, date range).
- **Breakside admin**: full read access across all teams (for safety incidents, support).
- **All other coaches**: no audit access. (Open Q2 — confirm.)
- **Players, guardians**: no audit access.

### Retention

- Forever during active team life.
- On team deletion: exportable as JSON by head coach; then purged after a 90-day grace window.
- On user-account deletion: their messages remain (replaced with "User removed" placeholders in UI); audit log retains original content under retention rules.

### Moderation tools (head coach)

- Soft-delete a message (visible in audit; visible to other moderators)
- Mute a member from a specific channel (timed or permanent)
- Suspend a member from the entire team (revokes access; can be reinstated)
- Edit channel permissions (within allowed bounds — can't break the [hard rules](#hard-rules-non-negotiable-server-enforced))

### SafeSport alignment

The hard rules are explicitly designed to satisfy SafeSport's no-1:1-electronic-communication standard for youth participants. Document this prominently in the team-creation flow so coaches understand. (Verify SafeSport documentation references during implementation — they update periodically.)

---

## Photos and media

- Upload to channel: photo, video clip, document
- Storage: Supabase Storage (or S3 via the existing AWS account) — TBD architecture decision
- Per-player photo flag (`allow` / `watermark` / `block`) set by guardian in player profile, visible to all coaches
- **At upload time**: uploader is shown a checklist of players in the channel audience with their flags, and a confirmation step. Watermarked photos get a server-side watermark applied before delivery. Blocked-player uploads are refused.
- v2: integrate with external photo services (Google Photos, Shutterfly, UltiPhotos) — pull-in albums, post album links, with the same opt-out enforcement.

---

## Teams, Seasons, and Events

### Promotion to first-class concepts

Today, Breakside has Team and `TournamentEvent`. For Comms, both need to compose with a new **Season** concept:

- **Team** (existing): the persistent organization. One messaging surface.
- **Season** (new): a time-bounded chapter of the team. Has start/end dates, an active roster (subset of all-time players), a coaching staff, channel enablement settings, recurring schedule (e.g. "practices Tue/Thu 6–8pm at Field 3"). Exactly one season is "active" per team at a time.
- **Event** (existing `TournamentEvent`, extended): expand beyond tournaments to all event types — practice, scrimmage, game, tournament, dinner, fundraiser, travel. Each event optionally spawns a per-event channel (default ON for tournaments and trips, OFF for routine practices).

### Season copy flow

New Season → "Start from prior season" → wizard:

- **Copy**: coach list, roster (with checkboxes to drop departing players), channel enablement state, notification defaults, recurring schedule template, saved groups
- **Do NOT copy**: message history (archived in previous season), archived events, audit log, photo uploads

Implementation note: existing TournamentEvent + Game data model already supports the event side. Season is the new model object that owns roster snapshots + channel state.

---

## Breakside-specific integrations (the "we're not just Slack" pitch)

In priority order — v1.3+, but worth designing toward from day one:

1. **Live game feed in `#announcements`**: when a game starts, an auto-message appears with live score, updating in place. Tap → opens the spectator view. Final score auto-posts on game end with key stats (breaks, top performers).
2. **Player stat-line chips**: `@alice` in chat renders as a chip; tap → mini-card with season-to-date stats. Coaches see a fuller card than guardians/players (per privacy levels from existing stats screens).
3. **Roster-aware audience targeting**: surveys can target "guardians of starters," "U14 players," "anyone who hasn't RSVPed yet." Uses the same query layer as the survey audience.
4. **Auto-event-channel population**: when an Event is created, its channel is born with the right people and stays alive through the event (then archives 96h later).
5. **Post-game auto-summary**: when a game ends, auto-post `[Game vs X — final 13-11, breaks: 3]` to `#announcements` with tap-through to box score and game log.
6. **Player highlight reels** (v2+): folds in the [video sync] major feature. Each player gets a per-game (or per-week) auto-generated highlight-reel channel drop with their throws/Ds/scores clipped from the game video.
7. **Animated playbook**: separate feature; integration is that plays render inline in chat with scrub bars.

---

## Architecture sketch

Two real options:

### Option A — Supabase Realtime + Postgres (recommended)

- Leverages existing Supabase tenancy (already used for auth)
- Postgres tables: `channels`, `channel_members`, `messages`, `message_edits`, `surveys`, `survey_responses`, `audit_log`, `photo_uploads`, `player_photo_flags`, `seasons`
- Row-level security (RLS) policies enforce the hard rules. RLS is the *correct* place for "no 1:1 channels" because it's the only layer the client can't bypass.
- Realtime subscriptions for message delivery, presence (typing indicators), and survey responses
- Supabase Storage for photos, with bucket policies aligned to channel access
- Pros: fastest path; auth already there; RLS is purpose-built for these constraints; realtime is solved
- Cons: introduces a Postgres dependency Breakside doesn't have today (currently file-based JSON on EC2). New operational surface.

### Option B — Stay on EC2 with FastAPI + JSON files

- Consistent with the existing backend
- Would require building: real-time delivery (Server-Sent Events or WebSocket layer), presence tracking, authorization middleware that approximates RLS, file-based message storage with reasonable performance
- Pros: no new infra
- Cons: significant reinvention of solved problems. Chat-shaped workloads are not great for JSON-file storage.

**Recommendation**: **Option A**. The hard rules are easier to verify on RLS than on hand-written middleware, and the realtime layer is non-negotiable for chat UX. Treat this as the moment Breakside grows a real database. The stats side can stay on JSON files indefinitely or migrate later.

### Other infrastructure

- **Push notifications**: web push via VAPID, sent from FastAPI (or Supabase Edge Functions). Subscription tokens stored per device per user.
- **SMS**: Twilio (programmable SMS for outbound; SMS verify for onboarding). Free trial credit for development; production tier required at launch.
- **Email**: Postmark (transactional) or AWS SES (cheaper at scale). Postmark recommended for v1 due to easier deliverability story.
- **Inbound email** (for email replies): Postmark inbound webhook → FastAPI → message-create.

---

## Phasing

### v1.0 — Comms MVP

Ship when these work end-to-end:

- [ ] User types: Coach (existing), Player (new account model, folded in from deferred player↔user linking), Guardian (new). Phone-number onboarding via Supabase Phone Auth + Twilio Verify.
- [ ] Permanent channels: `#announcements`, `#parents`, `#team-chat`, `#coaches`, `#players` (disabled by default), `#carpool`, `#emergency-alerts`
- [ ] Pseudo-DM creation and membership rules (server-enforced)
- [ ] [Hard rules 1–6](#hard-rules-non-negotiable-server-enforced) enforced via RLS or middleware
- [ ] Threading (one level, with "also post to channel" option)
- [ ] Web push notifications with the [default notification matrix](#defaults)
- [ ] Emergency broadcast with long-press + 4-digit-code confirm + rate limit; SMS + email + push fan-out
- [ ] Email echo (outbound) for announcements and pseudo-DMs to me
- [ ] Inbound email replies via Postmark
- [ ] Audit log (write side) — all event types captured
- [ ] Audit log viewer for head coach (basic filter UI)
- [ ] Photo upload with per-player opt-out flag enforcement (block + watermark + allow)
- [ ] Soft-delete + edit on messages, with audit
- [ ] Mute / suspend moderation tools
- [ ] Onboarding: invite-by-phone flow, SMS join links, profile setup

### v1.1 — Events and Seasons

- [ ] Season model + active-season selection
- [ ] Season-copy flow (roster, coaches, channel state, recurring schedule)
- [ ] Event model expanded beyond TournamentEvent (practice, scrimmage, dinner, fundraiser)
- [ ] Per-event channels with 96h auto-archive + head-coach un-archive
- [ ] Recurring practice schedule in season settings
- [ ] Surveys and polls (single-choice, multi-choice, yes/no, free-text)
- [ ] RSVP as a special-cased yes/no survey on Events
- [ ] Carpool sign-up template
- [ ] Hotel room sign-up template

### v1.2 — Polish + photo features

- [ ] SMS echo (beyond emergency) for opted-in users — tiering model decided
- [ ] Quiet hours per user
- [ ] Reactions
- [ ] Pinned messages per channel
- [ ] Search across a season's channels
- [ ] Read-receipts on `#announcements` and emergency broadcasts ("seen by 12 of 18")
- [ ] Approval queue for parent_coordinator / captain posts to `#announcements` (when team setting is "approval required")
- [ ] Photo gallery view per channel
- [ ] Animated playbook integration (renders inline if posted)

### v1.3 — Breakside integrations

- [ ] Live game feed message in `#announcements` (auto-update during game)
- [ ] Player stat-line chips on `@mention`
- [ ] Post-game auto-summary message
- [ ] Roster-aware survey audience targeting
- [ ] Game-log tap-through from chat

### v2 — Bigger asks

- [ ] Native iOS/Android wrapper (unlocks Critical Alerts on iOS, full-screen-intent on Android — real DND bypass)
- [ ] Video highlight reels per player (folds in the time-synced-video major feature)
- [ ] External photo service integration (Google Photos, Shutterfly, UltiPhotos)
- [ ] Free tier vs paid premium plan
- [ ] Cross-season search / archive browser
- [ ] ML-based photo opt-out enforcement (face detection)

---

## Open questions

1. **Coach↔parent pseudo-DM membership**: confirmed to *not* include other guardians of the same player by default? A parent asking a coach about dues shouldn't necessarily loop in the ex-spouse. Current default in this doc: no, only coaches are auto-CCed. Revisit if uncomfortable.
2. **Audit log read access for non-head-coach coaches**: this doc says head coach + Breakside admin only. Confirm assistant coaches don't need visibility (e.g. for "did the head coach really say that?" disputes).
3. **`#players` for under-13 teams**: doc says "hidden or read-only by default." Pick one. Lean: hidden entirely — under-13 teams just don't get a `#players` channel until they age up.
4. **Coach-multi-player nudge** ("you three, lock in travel"): doc assumes `#team-chat` with @-mentions. Confirm, or add a "create group" affordance.
5. **Player accounts and parental consent**: COPPA implications for the 13–17 cohort still need legal review. Probably: require guardian to approve player account creation up through age 17. Defer to legal review during v1 implementation.
6. **Phone number changes**: a guardian's phone changes — how is account recovery / re-verification handled? Need a real flow, not "ask Breakside admin."
7. **Multiple teams per user**: one user can be a coach on Team A and a guardian on Team B. Confirm UI shows team-scoped channels cleanly. (Should be straightforward, but worth verifying onboarding.)
8. **Photo opt-out granularity**: doc has 3 levels (`allow`/`watermark`/`block`). Are there sub-cases — e.g. "OK in `#parents` but not `#team-chat`"? Lean: no, three levels is enough; add granularity only if asked.
9. **Database migration plan**: introducing Postgres alongside the existing file-based JSON storage — does the stats data also migrate eventually, or do they coexist permanently? Out of scope for Comms v1 but worth a head-coach decision.
10. **GDPR/COPPA/SafeSport compliance documentation**: needs explicit written policy at MVP launch (consent flow, data residency, retention). Treat as v1 launch-blocker, not a v1 build-blocker.

---

## Implementation references (existing code that will be touched)

- **Auth & user model**: `auth/` (frontend Supabase auth), `ultistats_server/auth/` (JWT validation), `ultistats_server/storage/users.py` and `memberships.py` (existing membership model — new types added here)
- **Player ↔ user linking** (currently deferred): see [`memory/project_player_elevation.md`](../.claude/projects/-Users-luebke-src-ultistats/memory/project_player_elevation.md) and TODO.md "Player Features → Player ↔ User account linking." Fold this into Comms MVP.
- **Team model**: `store/models.js` (Team), `ultistats_server/storage/teams.py`. Will need to gain Season + Channel concepts.
- **Event model**: `store/models.js` (TournamentEvent), needs expansion to non-game event types.
- **Existing notification surface**: there isn't one yet — push notifications are net-new infrastructure.
- **Existing sync layer**: `store/sync.js`. The realtime delivery for chat is parallel infrastructure; don't try to bolt chat onto the game-sync polling loop.

---

## Suggested kickoff sequence for the implementing session

1. **Read this doc and TODO.md** — get full context on existing app and where Comms fits.
2. **Decide architecture** (Option A vs B above). I recommend Option A. Document the decision in `ARCHITECTURE.md`.
3. **Scaffold the data model** — channels, members, messages, audit log, photo flags, seasons. Get RLS policies right for the hard rules **first**, before any UI work.
4. **Build the onboarding flow** — phone verify, role assignment, guardian↔player linking. Test with 1–2 dummy users.
5. **Build the channel list + message view + composer** — bare-bones, no fancy features, but the hard rules visible on the channel header.
6. **Build pseudo-DM creation** — verify the auto-membership rules end-to-end.
7. **Add web push notifications** with the default matrix.
8. **Add audit log** — write path first, viewer later.
9. **Build the emergency broadcast** with butt-dial protection + SMS/email fan-out.
10. **Photo upload + opt-out enforcement.**
11. **Onboard one real team** (yours) and iterate.

Phasing details for v1.1+ in the [Phasing](#phasing) section above.
