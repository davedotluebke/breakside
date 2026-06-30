# Breakside Comms — the coach's pitch

*A short read for coaches deciding whether to back this build.*

---

## The mess you're living in

Quick exercise. Count the tools you're juggling for your team right now:

- Group chat for the team (GroupMe, Discord, WhatsApp, or a green-bubble nightmare)
- A separate channel for coaches
- A parents thread that's *somehow* on a different platform than the team chat
- Email blasts for the formal stuff
- A spreadsheet, Doodle, or When2Meet for practice scheduling
- A Google Form (or paper sign-up sheet) for the tournament hotel block
- A second Google Form for the carpool
- SMS to a parent because their kid forgot cleats
- TeamSnap or SportsEngine for the parts you couldn't avoid
- And your stats are somewhere else entirely

I count seven on a good week. Eight if you include the printed roster taped to your clipboard.

Every one of those tools was added because the previous one didn't quite fit. None of them know about each other. None of them know about your team. None of them know that you're not supposed to text a 14-year-old by yourself.

You are not a communications professional. You're a coach. You shouldn't need to be a sysadmin to run a youth team.

## What Breakside Comms is

**One app where your team's whole communication life happens — with the right safety rules baked in, and your stats already there.**

That's the whole pitch. The rest of this doc is why each of those words matters.

## Why not just use what you already use?

| Tool | Why it doesn't work for youth teams |
|---|---|
| **GroupMe / WhatsApp / SMS** | No coach/player safety rules. No parent visibility. No structure. Old messages vanish. Onboarding a new family is "give me your number and I'll add you to four threads." |
| **Discord** | Built for gaming communities. Confusing for non-tech parents. No SafeSport-aligned guardrails. You'll be moderating 14-year-olds posting memes in `#general`. |
| **Slack** | Free tier limits make it useless after a season. Designed for office work, not youth contexts. You'd build all the safety rules by hand and pray nobody finds a loophole. |
| **TeamSnap / SportsEngine** | Closest competitor. Good for schedules and rosters. Chat is an afterthought, no real channel structure, no thread/reply discipline, and no stats integration. You'll still be running a side thread for "real" coach talk. |
| **Email** | Reaches everyone reliably. Nobody reads it in time. Nobody replies. |
| **Google Forms + Sheets + Drive** | Works! Until a parent says "I don't use Google" — and you discover that's at least one parent on every team. |

The problem isn't that any of these tools is bad. It's that **none of them know they're being used by a youth sports team**, so all the rules that should be defaults are left for you to build, maintain, and police. And you don't have time.

## What changes in your day-to-day

Some specific moments that are different with Comms in place. These are the ones I keep coming back to as I design the thing.

### Saturday, 8:47am, lightning at the field

You open Breakside. Tap the red Emergency button. Pick the "Weather" template. Type the 4-digit code on screen. Done.

Within five seconds, every guardian gets a push notification, an SMS, and an email. No "did you see my text?" No checking who's in which group chat. No worrying that the parent who refused to install GroupMe missed the message. The audit log records exactly who was notified, when, and how — which matters if anyone asks later why a kid was still on the field.

### Tuesday, 9:30pm, you need to talk to Alice's dad

You're not allowed to DM him alone (SafeSport, and frankly just common sense). In every other app you're using, you have to remember to CC the other coaches and your co-head every time. Half the time you don't.

In Breakside Comms, you tap Alice's dad's name. The "DM" opens — except it's not a DM. The header says, in plain text, "You + Bob (Alice's dad) + Coaches Eve and Frank." That's the only kind of conversation that can exist. You couldn't break the rule if you tried, because the server won't let you.

### Wednesday, 6pm, you need to know who's at practice tomorrow

You tap "New Survey." Pick "Weekly practice attendance." Set it to recur every Tuesday at 6pm. Audience: guardians of all players. Done. Forever.

Every Tuesday at 6pm, every parent gets a yes/no ping. Sunday morning, the ones who haven't answered get a polite nudge. By Tuesday afternoon you know exactly how many players you have for drill planning. Nobody had to maintain a spreadsheet.

### Friday, two weeks before the tournament, hotel block opens

You tap "New Sign-up." Pick "Hotel rooms." Add Room 217 (2 beds), Room 218 (2 beds), Room 219 (1 king). Parents claim slots. Waitlist is automatic when rooms fill. Nobody DMs you "wait did Sarah's family say they were sharing with us?" — because everyone can see the same live list.

Same for carpools. Same for snack rotation. Same for jersey-number assignments.

### Mid-game, the play-by-play you're tracking on Breakside auto-posts to `#announcements`

Score updates live. Final score posts itself when the game ends. The grandparent who couldn't make it is following along in the same app that delivers the practice schedule. Your assistant coach who's stuck at work taps through to the live box score during her lunch break.

This is the **Breakside-specific magic** no other comms tool will ever have, because they don't have your stats. They never will.

### Sunday morning, a parent doesn't want her kid in any team photos

She sets the flag once in her player's profile. From that moment on, every coach uploading a photo to any team channel sees the warning before they post. Watermarks get applied automatically if she chose that option. There's a record of every override. You don't have to remember. You don't have to remind anyone.

### Tuesday, mid-season, the question every coach dreads

"Did Coach Frank actually say that to my kid?"

In every other tool, you start scrolling, hoping the message is still there, hoping the parent isn't lying, hoping Frank wasn't being a jerk. In Breakside, the head coach opens the audit log, filters by user and date, and the truth is right there — including any edits, including any deletes. Not "trust me," but "here's the record."

## Safety isn't a feature. It's the foundation.

The most important thing about Comms isn't what it adds. It's what it **refuses to allow**, on purpose, even when you ask nicely.

- **No coach can have a private conversation with a youth player.** Ever. The server enforces this — not as a setting you might forget to flip, but as a structural property of the database. Any coach-to-player message automatically includes the player's guardians and all other coaches. The UI shows you the whole audience before you hit send.
- **No coach↔parent DMs either.** Same structural rule. Other coaches are always copied.
- **Audit log is immutable.** Every message, every edit, every delete, every photo upload, every membership change. Head coach and admin can review. Nobody can purge.
- **No public links, no anonymous joins, no DMs from strangers.** Every member is on the team because a coach invited a verified phone number.
- **Photo opt-outs are honored at upload time**, with three settings (allow / watermark / block) and audit logging on any override.
- **Emergency alerts can't be silenced by recipients.** Whatever a parent has muted, the lightning alert gets through.

This isn't just "nice to have." This is the difference between "we hope nothing goes wrong" and "we built it so the wrong thing literally cannot happen." For a SafeSport-aligned youth program, that's not paranoia — that's professionalism.

## The Breakside angle

Every other tool stops at chat. Breakside Comms is wired into the rest of your coaching life:

- **Live game feeds in `#announcements`.** Grandparents follow along from home.
- **Tap any player's name in chat → see their season stats.** Coaches see more detail than parents.
- **Surveys can target "guardians of starters" or "anyone who hasn't RSVP'd."** Because the app knows your roster.
- **Each tournament/practice gets its own channel automatically**, populated with the right people, archived 96 hours after end-of-event (with un-archive available for late photo dumps).
- **Eventually: per-player highlight reels delivered to chat after each game**, automatically clipped from the synced game video.

No other tool will catch up on this dimension, because no other tool *is* your stats app.

## What this is NOT

A few things I want to be clear about up front:

- **Not a Slack clone.** I'm not chasing feature parity with general-purpose chat. No external integrations, no app marketplace, no @here-spam fights.
- **Not a TeamSnap competitor on logistics alone.** Schedules and rosters are table stakes for me, but they're not the differentiator. The differentiator is safety + chat + stats in one place.
- **Not free forever.** Long term there will be a free tier (probably bounded by team size or message volume) and a paid tier. Pricing TBD; nothing changes for current testers.
- **Not a replacement for human coaching.** It's the tool that gets out of your way so you can do the actual job.

## How it rolls out

A rough timeline. None of this is built yet — that's why I'm asking before I sink the time.

**v1 (MVP)** — The thing you'd actually start using.
The permanent channels. The SafeSport-aligned pseudo-DMs. Push notifications. Emergency broadcast. Audit log. Photo opt-out. Phone-based onboarding. Email echo. One season per team. *This is the prove-it ship.*

**v1.1** — Events and Seasons.
Per-event channels, season copy ("start the new season from last year's"), surveys and polls, carpool and hotel sign-ups, RSVPs, recurring practice schedule.

**v1.2** — Polish.
Reactions, pinned messages, search across a season, read-receipts on announcements, the approval-queue flow for parent-coordinator / captain posts.

**v1.3** — Stats integration.
Live game feeds in chat. Player stat-line chips on @-mention. Post-game auto-summaries. Roster-aware survey audience targeting.

**v2** — The bigger stuff.
Native iOS/Android apps (so emergency alerts can truly bypass Do Not Disturb on iPhones). Per-player highlight reels. External photo service integration. The free/paid split.

## Why I want to know if you're in

Building Comms is a big lift. The stats side of Breakside today is one well-understood app on a simple backend. Adding messaging means a real database, real push infrastructure, SMS/email plumbing, and a much higher operational bar — *and* it means I'm now responsible for kids' communications going right.

I'm willing to do it. I think it's worth doing. But the only thing worse than not building it would be building it for an audience of one.

**What I'm asking:**

1. Would you actually move your team off your current tools onto this if it existed?
2. What in the pitch above lands, and what doesn't?
3. What's in your current tool stack that I haven't captured?
4. What would make you say "no, I'm staying with what I've got"?

Tell me honestly. I'd rather hear it now than after I've spent six months on it.

— Dave
