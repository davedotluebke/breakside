# Player elevation (privacy, linking, claiming)

Status: Phase 1 (access-control lockdown) shipped: `require_player_read_access` guards the per-player GET endpoints and `GET /api/players` is scoped to what the caller may see (verified in `breakside_server/routers/players.py` 2026-09-05). Everything else below is design only, never built. The plan dates from 2026-03-20.

## Goal

Players become first-class entities with:

- Optional user-player linking; one user can link to several players (a parent with two kids).
- Team-scoped visibility: only team members can see a team's players.
- Field-level privacy:
  - **Private (the linked user and admins only):** emails (primary plus two optional), phone numbers.
  - **Coach-only:** free-text notes, injured flag, position roles (handler, cutter, hybrid, O-line, D-line).
  - **Team-visible:** name, nickname, number, gender.
- A claiming flow with coach approval.
- Admin-only player merge.
- Membership roles that can combine: a user can be coach, player, and viewer at once.

Why: before Phase 1 any authenticated user could list every player globally. Youth teams carry parent and guardian contact details, so scoping and field privacy matter more than the feature's size suggests.

## What Phase 1 was

No data-model change. A `require_player_read_access` dependency (member of a team containing the player), the list endpoint restricted, and the client's `pullFromCloud()` switched from a global player list to team-scoped aggregation via `GET /api/teams/{id}/players`. Tests gained auth headers on player reads.

## Later context

In-app messaging is planned so users can email or text players without ever seeing the contact details. Treat phone numbers exactly like emails for privacy. The August 2026 privacy work (erasure, consent line, disclosure modal) is separate and shipped; see ARCHITECTURE.md and `privacy.html`.
