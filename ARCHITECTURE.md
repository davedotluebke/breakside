# Breakside Architecture

This document describes the technical architecture of the Breakside ultimate frisbee statistics tracker.

## System Overview

Breakside uses a hybrid architecture with a Progressive Web App (PWA) frontend hosted on CloudFront/S3 and a FastAPI backend on EC2.

```
                              USERS
                                │
         ┌──────────────────────┼──────────────────────┐
         ▼                      ▼                      ▼
   breakside.pro          www.breakside.pro      api.breakside.pro
   (apex domain)                                        
         │                      │                      │
         ▼                      ▼                      ▼
   EC2 / nginx              CloudFront             EC2 / nginx
   (301 redirect)             (CDN)                 (proxy)
         │                      │                      │
         └──────────────►  S3 Bucket              FastAPI
                          (PWA + Viewer)         (port 8000)
```

### Live URLs

| Service | URL | Hosted On |
|---------|-----|-----------|
| **PWA** | https://www.breakside.pro | CloudFront (`E6M9KCXIU9CKD`) → S3 |
| **PWA (redirect)** | https://breakside.pro | EC2 → www |
| **Staging PWA** | https://staging.breakside.pro | CloudFront (`E12N2STN9MM8FA`) → S3 |
| **Static Viewer** | https://www.breakside.pro/viewer/ | CloudFront → S3 |
| **API** | https://api.breakside.pro | EC2 → FastAPI |
| **Health Check** | https://api.breakside.pro/health | EC2 |

Staging uses the same production API. The API endpoint can be overridden via `?api=<url>` query parameter (saved to localStorage, clear with `?api=reset`).

---

## Frontend Architecture

### PWA Structure

The frontend is a vanilla JavaScript Progressive Web App with no framework dependencies.

```
ultistats/
├── index.html              # Main HTML entry point
├── main.js                 # Application bootstrap (~436 lines)
├── main.css                # Application styles
├── manifest.json           # PWA manifest
├── service-worker.js       # Service worker for offline functionality
├── version.json            # Version tracking
│
├── store/                   # Data layer
│   ├── models.js           # Data structure definitions (Player, Game, Team, etc.)
│   ├── storage.js          # Serialization/deserialization and local storage
│   └── sync.js             # Server synchronization logic
│
├── utils/                   # Utility functions
│   ├── helpers.js          # Pure utility functions and state accessors
│   └── statistics.js       # Statistics calculation and game summaries
│
├── screens/                 # Screen management
│   └── navigation.js       # Screen navigation and state management
│
├── teams/                   # Team management
│   ├── teamSelection.js    # Team selection and team CRUD operations
│   ├── rosterManagement.js # Roster display, player and line management
│   └── teamSettings.js     # Team settings, member list, invite management
│
├── game/                    # Game core logic
│   ├── gameLogic.js        # Game initialization, scoring, undo
│   ├── gameScreen.js       # Game screen with tabbed panel layout (Simple / Full / Line / Log / All)
│   ├── pointManagement.js  # Point creation, timing, transitions
│   ├── controllerState.js  # Multi-coach role management
│   └── genderRatioDropdown.js # Gender ratio rule selection
│
├── playByPlay/              # Play-by-play tracking
│   ├── keyPlayDialog.js    # Key play recording dialog (Simple mode)
│   ├── pullDialog.js       # Pull tracking dialog
│   ├── scoreAttribution.js # Score attribution dialog
│   ├── fullPbp.js          # Full PBP tab — every-event entry surface (see docs/full-pbp-requirements.md)
│   └── fullPbp.css         # Full PBP layout + density styles
│
├── narration/               # AI speech narration (mic → transcript → events)
│   ├── micButton.js        # Floating mic FAB (tap or hold-to-record)
│   ├── micButton.css       # Mic button + transcript panel styles
│   ├── eventBus.js         # Tiny pub/sub for client update pipeline
│   ├── realtimeSession.js  # OpenAI Realtime API WebSocket client
│   ├── narrationEngine.js  # Orchestrator: fast pass + slow pass + apply
│   └── transcriptDisplay.js # Live transcript panel above the mic button
│
├── ui/                      # UI components
│   ├── panelSystem.js       # Panel layout and drag-to-resize system
│   ├── panelSystem.css      # Panel system styles
│   ├── activePlayersDisplay.js # Active players table
│   ├── eventLogDisplay.js   # Event log management
│   └── buttonLayout.js      # UI consistency functions
│
└── images/                  # App icons and logos
    ├── logo.png            # Full logo with text
    ├── logo.disc.only.png  # Icon-only logo
    └── favicon-*.png       # Various favicon sizes
```

### Module Loading

- Modules are loaded in order via `<script>` tags in `index.html`
- Data layer (`store/`) loads first, followed by utilities, then feature modules
- Global state is managed through shared variables in `store/storage.js`
- No circular dependencies - clear data flow: data → utils → features → UI

### Line Selection Mode Toggle

Player-selection tables (main panel, O/D split panels, injury sub dialog) support a three-state mode toggle:

```
Manual ──tap──▶ Wholesale ──tap──▶ Auto ──tap──▶ Manual
                (all unchecked)    (suggested)    (restored snapshot)
```

**States:**
- **Manual** (default): User's own checkbox selections. Standard behavior.
- **Wholesale**: All checkboxes cleared — a fresh start for building a line.
- **Auto**: App suggests a lineup by selecting players with the fewest points played in the current game, respecting the game's gender ratio settings. Falls back to ignoring ratio if available players can't satisfy it.

**Snapshot behavior:**
- When leaving Manual (first tap), the current checked set is saved as `manualLineSnapshot`.
- When returning to Manual (third tap), the snapshot is restored.
- Any direct checkbox change while in Wholesale or Auto immediately transitions back to Manual and updates the snapshot to the new state.

**State management:**
- Each table context (main, O split, D split, injury sub) maintains its own `lineSelectionMode` and `manualLineSnapshot`.
- Mode resets to Manual at the start of each new point.
- The toggle is rendered as a tappable text label ("Manual" / "Wholesale" / "Auto") in the table header.

**Auto algorithm (v1):**
1. Determine expected player count and gender ratio from game settings.
2. Sort roster by points played ascending (fewest first).
3. Fill the line respecting ratio: pick from the under-represented gender first, then alternate.
4. If ratio can't be met with available players, fill remaining slots regardless of gender.

### In-Game Tab System

The in-game UI is organized into five tabs, switched via a segmented control in the orange header:

- **Simple** — The legacy Key Play–driven Play-by-Play panel only, full-screen. Streamlined buttons (We Score / They Score / Key Play / Undo / Sub / Events / More) plus the Key Play modal for granular event entry.
- **Full** — The new every-event-entry panel (`playByPlay/fullPbp.js`), full-screen. Player rows + per-row contextual action buttons (drop / score / throwaway / break / block / interception / …), a horizontal modifier-flag chip strip below, a bottom-row "They turnover / Events / They score" action set in D-mode, and a flex-sized mini event log at the bottom. See **docs/full-pbp-requirements.md** for the full design and **Full PBP integration** below for the runtime architecture.
- **Line** — Select Next Line panel only, full-screen (in split mode, the O and D panels stack).
- **Log** — Game Log (Follow) panel only, full-screen.
- **All** — The full vertical panel stack with drag-to-resize (see next section). Default tab. Uses Simple PBP — the Full PBP layout is excluded from All-view because its custom-shaped panel doesn't compose well with the drag-to-resize stack.

The segmented control DOM lives in `createHeaderPanel()` (`game/gameScreen.js`); switching logic and persistence live in `panelSystem.js` (`switchTab()`, `applyTabState()`, `updateSegmentedSlider()`). Active tab is persisted in `localStorage` under `breakside_active_tab`. The most-recent PBP tab choice (`simple` or `full`) is separately tracked under `breakside_last_pbp_tab` so post-score auto-navigation (Line tab → user's preferred PBP tab) routes back to whichever the user was last using.

**Single-tab mode** sets the visible panel's class to `tab-fullscreen`, which hides its title bar and applies `flex: 1 1 auto` so it fills the viewport. All other content panels get `hidden`. **All mode** removes the class and re-applies saved panel states via `applyAllPanelStates()`, restoring drag heights.

`updatePanelsForRole()` re-applies the tab state at the end so role-based visibility (e.g. viewer mode hiding play/line panels) doesn't leak into single-tab mode. `enterSplitMode`/`exitSplitMode` adjust `selectLine` vs `selectOLine`/`selectDLine` visibility independently of the tab state, and the Line tab routes to whichever panels are appropriate.

### Panel Drag-to-Resize System

The in-game UI is a vertical stack of panels managed by `ui/panelSystem.js`. Panels are resized by dragging their title bars. The last panel (Follow/Game Log) is flex-fill and absorbs remaining space. This system is active in the **All** tab; in the other tabs, drag handles are hidden and a single panel fills the viewport.

**Layout model:** Panels `P[0], P[1], …, P[N-1]` are stacked vertically. Each has a title bar (~36px) at its top edge and a content area below. Each has a `minHeight` (title-bar-only for most; larger for PBP and Follow). Title bar position of panel `i` equals the sum of heights of panels `0` through `i-1`.

**Drag algorithm — `moveTitleBar(i, delta)`:** A recursive function that moves title bar `i` by `delta` pixels. Moving down grows the panel above and shrinks the panel below. When the panel being shrunk hits its `minHeight`, the function recurses to push the next neighbor in the same direction (cascading). Title bar 0 is pinned (never moves). Follow (last panel) absorbs freely with no title bar below to push.

```
moveTitleBar(i, delta):
    if delta > 0 (moving down):
        canShrink = height[i] - minHeight[i]
        if canShrink < delta and not last panel:
            pushed = moveTitleBar(i + 1, delta - canShrink)  // cascade
            canShrink += pushed
        actual = min(delta, canShrink)
        height[i-1] += actual    // panel above grows
        height[i]   -= actual    // panel below shrinks

    if delta < 0 (moving up):
        canShrink = height[i-1] - minHeight[i-1]
        if canShrink < |delta| and i-1 > 0:
            pushed = moveTitleBar(i - 1, delta + canShrink)  // cascade
            canShrink += |pushed|
        actual = max(delta, -canShrink)
        height[i-1] += actual    // panel above shrinks
        height[i]   -= actual    // panel below grows
```

**Two drag modes** (toggled in Settings):

- **Spring-back (default):** Each frame resets heights to their start-of-drag values and applies the absolute delta from the drag start position. When the finger reverses, all panels spring back to their original sizes.
- **Physical:** Each frame applies an incremental delta from the previous frame's position. Pushed panels stay where they are because nothing asks them to move back — the recursion only pushes, never pulls.

**Line type toggle:** The O/D button on the Select Next Line toolbar cycles through four modes: `od` → `o` → `d` → `split` → `od`. Each mode manages a separate player selection stored in `pendingNextLine` (`odLine`, `oLine`, `dLine`). When a point ends, `selectAppropriateLineAtPointEnd()` decides which view to show next:
- If the coach was in combined `od` view, it stays in `od` (sticky preference).
- If in `o` or `d` view, auto-switches to `o` or `d` based on who scored (team scored → defense next, opponent scored → offense next).
- Split view is always preserved.

**Split mode:** In split view, the `selectLine` panel is hidden (`display: none`) and two stacked panels `selectOLine`/`selectDLine` are shown. The drag system filters out non-rendered panels (`offsetParent === null`) to avoid dragging invisible elements.

### Full PBP integration

The "Full" tab (`playByPlay/fullPbp.js`) is a self-contained panel that subscribes to `narrationEventBus` and writes events through the same code paths the manual Key Play flow and AI narration use — `ensurePossessionExists`, stat updates, `logEvent`, `updateScore` / `moveToNextPoint`, `saveAllTeamsData`. There's no separate Full-PBP data model.

Key runtime properties:

- **State reconstruction.** Every `render()` call walks the current point's possessions and derives `(mode, holder)` from the most recent event, rather than storing UI state. Drop a Simple Mode event mid-stream, undo via the global Undo, or have narration finalize a slow-pass — the Full panel reflects the new truth on the next render.
- **Inferred events.** A boolean `inferred_flag` on the base `Event` class (default `false`) is set on synthetic events created by the Full panel's O/D pill toggle (Turnover / Defense{unforcedError}). Surfaces as `(inferred)` prefix in `summarize()` output. Tap the pill twice in a row with no events between → second tap retracts the inferred event rather than stacking another one.
- **Bus integration.** Full PBP publishes `eventAdded` (source `'manual'`), `eventAmended` (modifier-chip toggles), and `eventRetracted` (Undo, pill-toggle retraction) so other subscribers (transcript display, future ultra-compact log) see all manual edits the same way they see narration events.
- **Layout.** Player rows fill the panel's full width; modifier chips live in a horizontal strip below the rows; a bottom action row holds `[They turnover] [⚙ Events] [They score]` in D-mode and just `[⚙ Events]` centered in O-mode; a mini event log fills whatever vertical slack remains. Density is governed by a small set of CSS knobs that can be flipped between "compact" (build-206 values) and "roomy" (build-207 values) — the toggle itself is a TODO.
- **Score auto-tab-switch.** `moveToNextPoint()` (in `game/pointManagement.js`) auto-switches to the **Line** tab if the current user holds the Line Coach role, regardless of which PBP mode (Simple, Full, narration) triggered the score. Conversely, `startNextPoint()` auto-switches from the Line tab back to the user's last-used PBP tab — so a solo coach round-trips Simple/Full → Line → Simple/Full automatically.

Full design + decision history: **docs/full-pbp-requirements.md**.

### Feature Worktrees

For parallel development, feature branches use git worktrees in `.worktrees/<feature-name>`. See CLAUDE.md for the workflow.

### Offline Support

The service worker implements a network-first strategy with cache fallback:

1. Try network request first
2. On success, cache the response
3. On failure (or timeout), serve from cache
4. API calls to `api.breakside.pro` are never cached

---

## Backend Architecture

### Server Stack

| Component | Details |
|-----------|---------|
| **Runtime** | Python 3.8 with venv |
| **Framework** | FastAPI with uvicorn |
| **Web Server** | nginx (reverse proxy, SSL termination) |
| **Process Manager** | systemd |
| **Data Storage** | JSON files on filesystem |
| **SSL** | Let's Encrypt (certbot) |

### Server File Structure

```
ultistats_server/
├── main.py              # FastAPI application and routes
├── config.py            # Configuration from environment variables
├── narration.py         # AI narration router (token + finalize endpoints)
├── requirements.txt     # Python dependencies
│
├── storage/             # Data storage layer
│   ├── __init__.py
│   ├── game_storage.py  # Game CRUD operations
│   ├── team_storage.py  # Team CRUD operations
│   ├── player_storage.py# Player CRUD operations
│   ├── user_storage.py  # User account CRUD operations
│   ├── membership_storage.py # Team membership management
│   ├── invite_storage.py    # Invite code management
│   ├── share_storage.py     # Game sharing management
│   ├── controller_storage.py # In-memory game controller state
│   └── index_storage.py # Cross-entity index management
│
├── static/
│   └── viewer/          # Static game viewer
│       ├── index.html
│       ├── viewer.js
│       └── viewer.css
│
├── auth/                # Authentication
│   ├── __init__.py
│   ├── jwt_validation.py   # Supabase JWT verification
│   └── dependencies.py     # FastAPI auth dependencies
│
└── tests/
    └── narration/       # Audio-driven narration test harness
        ├── runner.py            # Streams audio → transcript → /finalize → metrics
        ├── test_scenarios.py    # pytest entry point (auto-discovers scenarios)
        ├── tools/
        │   └── generate_synthetic_audio.py   # OpenAI TTS → audio.flac
        └── scenarios/
            └── 001_single_throw/
                ├── transcript.txt   # ground-truth narration
                ├── roster.json      # on-field players + game context
                ├── expected.json    # expected events
                └── audio.flac       # 24kHz mono FLAC, lossless
```

### Data Directory Structure

```
/var/lib/breakside/data/
├── games/
│   └── {game_id}/
│       ├── current.json      # Latest game state
│       └── versions/         # Historical versions
│           ├── 2024-01-15T10-30-45.json
│           └── 2024-01-15T10-35-12.json
├── teams/
│   └── {team_id}.json
├── players/
│   └── {player_id}.json
├── users/
│   └── {user_id}.json        # User profile (synced from Supabase)
├── memberships.json          # Team membership index
└── index.json                # Cross-entity index
```

### API Endpoints

#### Games
- `POST /api/games/{game_id}/sync` - Sync complete game state
- `GET /api/games/{game_id}` - Get current game state
- `GET /api/games` - List all games
- `DELETE /api/games/{game_id}` - Delete game

#### Teams
- `POST /api/teams/{team_id}/sync` - Sync team data
- `GET /api/teams/{team_id}` - Get team
- `GET /api/teams` - List all teams

#### Players
- `POST /api/players/{player_id}/sync` - Sync player data
- `GET /api/players/{player_id}` - Get player
- `GET /api/players` - List all players

#### Index
- `POST /api/index/rebuild` - Rebuild cross-entity index
- `GET /api/index` - Get current index

#### Versions
- `GET /api/games/{game_id}/versions` - List all versions
- `GET /api/games/{game_id}/versions/{timestamp}` - Get specific version
- `POST /api/games/{game_id}/restore/{timestamp}` - Restore to version

#### Authentication
- `GET /api/auth/me` - Get current user profile (requires auth)
- `PATCH /api/auth/me` - Update current user profile
- `GET /api/auth/teams` - List teams user has access to

#### Memberships
- `POST /api/teams/{team_id}/invite` - Generate invite code
- `POST /api/invites/{code}/redeem` - Redeem invite code
- `GET /api/teams/{team_id}/members` - List team members
- `DELETE /api/teams/{team_id}/members/{user_id}` - Remove member

#### Game Control
- `GET /api/games/{game_id}/controller` - Get controller state (roles, pending handoffs)
- `POST /api/games/{game_id}/ping` - Ping to keep role alive; returns controller state + `connectedCoaches` list
- `POST /api/games/{game_id}/claim-active` - Request Active Coach role
- `POST /api/games/{game_id}/claim-line` - Request Line Coach role
- `POST /api/games/{game_id}/release` - Release current role
- `POST /api/games/{game_id}/request-handoff` - Request handoff of a role from current holder
- `POST /api/games/{game_id}/handoff-response` - Accept or deny a handoff request

#### AI Narration
- `POST /api/narration/token` - Mint an ephemeral OpenAI Realtime API session token (so the browser can open a WebSocket without seeing the real API key)
- `POST /api/narration/finalize` - Run the slow-pass: take the accumulated transcript + roster + game context, return a list of `ADD` operations from Claude Sonnet describing the events found in the narration

---

## Data Model

### Entity IDs

Human-readable IDs with collision-resistant hash suffix:

```javascript
/**
 * Generate a short, human-readable ID
 * Format: {sanitized-name}-{4-char-hash}
 * Examples: "Alice-7f3a", "Sample-Team-b2c4"
 */
function generateShortId(name) {
    const safeName = name
        .replace(/[^a-zA-Z0-9\s-]/g, '')
        .replace(/\s+/g, '-')
        .substring(0, 20)
        .replace(/-+$/, '');
    
    const hash = Math.random().toString(36).substring(2, 6);
    return `${safeName}-${hash}`;
}
```

**Collision Handling:**
- On sync, if ID exists with different data, append 2 more chars
- Example: `Alice-7f3a` collides → try `Alice-7f3a2b`
- Extremely rare with 4-char hash (1 in 1.6M chance per name)

### Server-Side Index

Cross-entity index for efficient queries:

```json
{
  "lastRebuilt": "2024-01-15T10:30:00Z",
  "playerGames": {
    "Alice-7f3a": ["game_id_1", "game_id_2"],
    "Bob-2d9e": ["game_id_1"]
  },
  "teamGames": {
    "Sample-Team-b2c4": ["game_id_1", "game_id_2"]
  },
  "gameRoster": {
    "game_id_1": ["Alice-7f3a", "Bob-2d9e", "Charlie-4k1m"]
  }
}
```

**Rebuild Logic:**
- Scan all games, extract player IDs from roster snapshots
- Scan all teams, extract player IDs
- Takes ~1 second for hundreds of games
- Triggered via `POST /api/index/rebuild` or automatically if missing

### Roster Snapshots

Games capture player state at game time for historical accuracy:

```javascript
{
  rosterSnapshot: {
    players: [
      {
        id: "Alice-7f3a",
        name: "Alice",
        nickname: "Ace",
        number: "7",
        gender: "FMP"
      }
    ],
    capturedAt: "2024-01-15T10:30:00Z"
  }
}
```

### Event References

Events reference players by ID:

```javascript
{
  type: "Throw",
  throwerId: "Alice-7f3a",
  receiverId: "Bob-2d9e",
  // ... flags
}
```

---

## Sync Strategy

### Full Game Sync (Stateless)

Every sync operation sends the **complete game state**:

- Average game size: ~6 KB (compresses to ~1.2 KB)
- Sync time: ~25-50ms
- Simple, idempotent, easy to debug

```javascript
async function syncGameToServer(gameId, gameData) {
    const response = await fetch(`${API_BASE}/api/games/${gameId}/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(gameData)
    });
    return response.json();
}
```

### Automatic Versioning

Every sync creates a timestamped version file:

1. Save to `versions/{timestamp}.json`
2. Copy to `current.json`
3. (Optional) Git commit for full history

### Offline Support

```
User creates/edits while offline:
1. Save to localStorage immediately
2. Add to sync queue
3. UI works fully offline

When online:
4. Process sync queue
5. POST to server
6. Handle conflicts (last-write-wins)
```

---

## AI Narration

### Overview

A floating microphone button at the bottom of the game screen lets a coach narrate plays out loud ("Alice throws to Bob, deep huck to Carla for the score"). The system extracts structured `Throw` / `Turnover` / `Defense` / score events from speech and applies them to the game state — the same events a coach would otherwise tap in via the Key Play / Score Attribution dialogs.

The architecture is a **two-pass hybrid**, with the fast pass currently configured for **transcription only** (the structured-extraction fast pass is preserved behind a feature flag for future revisit):

- **Fast pass** (during recording): browser streams audio to OpenAI's Realtime API via a WebSocket. The transcript streams back live and is shown in a floating panel above the mic button — the coach sees they're being heard in real time.
- **Slow pass** (on stop): the accumulated transcript is POSTed to `/api/narration/finalize`, which calls Claude Sonnet with a structured prompt. Claude returns a list of `ADD` operations (one per event found), which the frontend applies through the same code paths the manual Key Play dialog uses (`ensurePossessionExists`, stat updates, event log, possession transitions).

### Why this split

We tried doing structured event extraction live during recording (gpt-realtime function calling on streaming audio). It worked in quiet conditions but confabulated events in noisy outdoor conditions — extracting structured output from garbled audio fragments is brittle. Decoupling transcription from event extraction gives Claude the full possession context to reason holistically, with much higher accuracy.

The fast-pass-events code path still exists, gated by `FAST_PASS_EVENTS_ENABLED = false` in `narration/narrationEngine.js`. Tools, prompts, and event appliers are all preserved; flip the flag to re-enable.

### Frontend module layout

```
narration/
├── micButton.js           # Floating FAB. Tap toggles, hold engages temp recording
├── micButton.css          # Button + transcript panel styles (also provisional event styles)
├── eventBus.js            # ~30-LOC pub/sub. Channels: eventAdded, eventAmended,
│                          # eventRetracted, transcriptUpdated, scoreChanged, etc.
├── realtimeSession.js     # OpenAI Realtime WebSocket client. PCM16 capture via
│                          # MediaStream + AudioContext + ScriptProcessorNode.
├── narrationEngine.js     # Orchestrator. Builds the system prompt, opens the
│                          # session, accumulates transcript, runs the slow pass,
│                          # applies returned ops via the same applyThrow/etc.
│                          # functions used by the manual flow.
└── transcriptDisplay.js   # Floating panel that shows the live transcript
                           # (subscribes to transcriptUpdated channel).
```

### Backend endpoints

`ultistats_server/narration.py` exposes two routes mounted under `/api/narration/`:

- **`POST /token`** — receives `{model}`, calls OpenAI's `https://api.openai.com/v1/realtime/sessions` with the server's `OPENAI_API_KEY`, returns the ephemeral `client_secret` to the browser. Lets the browser open a WebSocket without ever seeing the real API key. Auth: any logged-in user.
- **`POST /finalize`** — receives `{game_id, transcript, roster, provisional_events, game_context}`, builds a structured prompt (see below), calls Claude Sonnet via the Anthropic Messages API, parses the response, returns `{operations: [...]}`. Auth: any logged-in user. Falls back to confirming all provisionals if `ANTHROPIC_API_KEY` is unset, so the feature degrades gracefully.

### Operation schema

The slow pass returns a list of operations. Each is one of:

- `{op: "CONFIRM", provisional_id}` — leave a fast-pass event as-is (only relevant when the fast pass is enabled)
- `{op: "RETRACT", provisional_id}` — remove a fast-pass event (coach corrected themselves, mishearing, etc.)
- `{op: "ADD", event}` — emit a new event from the transcript

The ADD `event` object has shape:

```json
{
  "kind": "throw" | "turnover" | "defense" | "opponent_score",
  "thrower": "Alice", "receiver": "Bob",
  "huck": true, "break_throw": false, "dump": false, "hammer": false,
  "sky": false, "layout": false, "score": true,
  // turnover-specific:  "throwaway", "drop", "good_defense", "stall"
  // defense-specific:   "defender", "interception", "callahan"
}
```

Player names must match roster entries exactly. The slow-pass prompt explicitly tells Claude to emit bare names (not `"Alice #7"`) — this was a real bug caught by the test harness on its first run.

The fast-pass `AMEND` operation is intentionally not emitted by the prompt; corrections are always expressed as `RETRACT` + `ADD` pairs for auditability. The frontend keeps a defensive `AMEND` handler (treats it as retract) in case Claude ignores instructions.

### Environment variables

- `OPENAI_API_KEY` — required for the narration feature to work at all (token endpoint)
- `ANTHROPIC_API_KEY` — required for the slow pass to actually emit events (without it, the endpoint returns `{operations: []}`)
- `NARRATION_SLOW_MODEL` — optional override for the Claude model used by the slow pass; defaults to `claude-sonnet-4-5-20250929`

### Cost characteristics

- Fast pass (Realtime API audio in + text out): ~$0.06 per minute of audio
- Slow pass (Claude Sonnet, ~1-3K tokens per possession): $0.01-0.03 per call
- A typical full game (~25 possessions, sporadic narration): roughly $2-4 total

### Test harness

Audio-driven regression suite in `ultistats_server/tests/narration/`. Each scenario is a directory of `(audio.flac, transcript.txt, roster.json, expected.json)` files. The runner:

1. Streams the audio to OpenAI Realtime as a transcription-only session
2. Captures the accumulated transcript
3. Calls `/api/narration/finalize` via `fastapi.testclient.TestClient` (no separate server needed)
4. Compares the resulting operations to expected, computes WER + event precision/recall/F1

`tools/generate_synthetic_audio.py` produces FLAC audio from a text script via OpenAI's TTS API for cheap deterministic scenarios (~$0.002 each). Hand-recorded scenarios go in the same shape and let us measure outdoor / multi-speaker robustness.

Test deps (`websockets`, `soundfile`) are listed in `requirements.txt` under a "Test-only deps" comment.

---

## Users and Authentication

### Overview

Breakside uses **Supabase Auth** for user authentication, providing email/password login with JWT tokens. User accounts enable multi-coach collaboration during games, team-based access control, and spectator viewing.

### Authentication Flow

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Landing   │────▶│  Supabase   │────▶│    PWA      │
│    Page     │     │    Auth     │     │   (JWT)     │
└─────────────┘     └─────────────┘     └─────────────┘
                          │
                          ▼
                    ┌─────────────┐
                    │  FastAPI    │
                    │  (verify)   │
                    └─────────────┘
```

1. User visits landing page (`breakside.pro`)
2. Signs in via Supabase Auth (email/password)
3. Supabase returns JWT access token
4. PWA includes `Authorization: Bearer {token}` on all API calls
5. FastAPI validates JWT signature using Supabase JWT secret

### User Roles

#### Persistent Roles (Team-Level)

| Role | Abilities |
|------|-----------|
| **Admin** | Full system access. Can modify any team, game, player. Can grant/revoke any role. |
| **Coach** | Full access to assigned teams. Can create/edit games, modify rosters, add events. |
| **Viewer** | Read-only access to assigned teams. Can watch games live, view statistics. |

#### Dynamic Roles (Per-Game)

| Role | Abilities |
|------|-----------|
| **Active Coach** | Has write control for play-by-play events. Can modify current lineup between points. Only one per game. |
| **Line Coach** | Can prepare the next lineup during a point. Only one per game. Any Coach can claim this status. |

### Role Assignment

- **Admin**: Manually granted by existing Admin (stored in user profile)
- **Coach**: Granted via single-use invite code (7-day expiry)
- **Viewer**: Granted via multi-use invite link (permanent, revocable)
- **Active Coach**: Claimed by any Coach during a game; requires handoff from current holder
- **Line Coach**: Claimed by any Coach during a game; requires handoff from current holder

### Handoff Protocol

When a Coach requests Active Coach or Line Coach status:

```
1. Requester taps role button in sub-header
2. If role is vacant: Immediate claim, requester gets role
3. If role is occupied: Handoff request created
   - Requester sees "Handoff request sent..." toast (duration = timeout)
   - Holder sees toast with Accept (✓) and Deny (✗) buttons
4. Holder response options:
   - Tap Accept: Immediate transfer
   - Tap Deny: Request rejected, requester notified
   - Swipe toast away: Counts as Accept
   - Do nothing: Auto-accepts after timeout (configurable, default 10s)
5. Resolution:
   - On accept: Role transfers, both parties notified
   - On deny: Request cancelled, requester sees error toast
```

The timeout is configurable via `HANDOFF_EXPIRY_SECONDS` in `controller_storage.py`. The server provides `expiresInSeconds` in API responses so clients can show accurate countdowns despite polling delays.

This protocol also handles connectivity loss—any Coach can take over after the timeout if the current holder loses connection.

### Team Membership Data Model

```json
{
  "team_memberships": [
    {
      "id": "mem_TeamA-1234_user-abc",
      "teamId": "TeamA-1234",
      "userId": "user-abc",
      "role": "coach",
      "invitedBy": "user-xyz",
      "joinedAt": "2025-01-15T10:30:00Z"
    }
  ],
  "user_memberships": {
    "user-abc": [/* membership objects */]
  }
}
```

### Game Controller State

Per-game controller state (in-memory, managed by `controller_storage.py`):

```json
{
  "activeCoach": {
    "userId": "user-abc",
    "displayName": "Alice",
    "claimedAt": "2025-01-15T10:30:00Z",
    "lastPing": "2025-01-15T10:35:00Z"
  },
  "lineCoach": {
    "userId": "user-xyz",
    "displayName": "Bob",
    "claimedAt": "2025-01-15T10:32:00Z",
    "lastPing": "2025-01-15T10:35:00Z"
  },
  "pendingHandoff": {
    "role": "activeCoach",
    "requesterId": "user-xyz",
    "requesterName": "Bob",
    "currentHolderId": "user-abc",
    "requestedAt": "2025-01-15T10:35:30Z",
    "expiresAt": "2025-01-15T10:35:40Z"
  }
}
```

**Connected Coaches Tracking:**

The server separately tracks all coaches actively polling each game, regardless of whether they hold a role. This is stored in-memory via `record_coach_ping()` / `get_connected_coaches()` in `controller_storage.py`.

- Every `POST /ping` records the coach's presence with `{displayName, lastPing}`
- `get_connected_coaches(game_id)` returns a list of `[{userId, displayName}]` for coaches who pinged within `STALE_TIMEOUT_SECONDS` (15s)
- The ping response includes `connectedCoaches` so clients know how many coaches are present
- The GET `/controller` endpoint does NOT return `connectedCoaches` (only POST `/ping` does)
- Note: Viewers do not call the ping endpoint, so they do not appear in connected coaches

**Client-Side Role Button Visibility:**

Role claim buttons (Play-by-Play / Next Line) are hidden when only one coach is polling a game. Once multiple coaches are detected, a **latch** keeps the buttons visible for the session (even if the second coach disconnects). The latch resets when exiting the game screen (`resetMultiCoachDetected()`). This logic lives in `updatePanelsForRole()` in `ui/panelSystem.js`.

**Timeouts:**
- `STALE_CLAIM_SECONDS` (30s): Role auto-releases if holder stops pinging
- `STALE_TIMEOUT_SECONDS` (15s): Coach removed from connected list if no ping
- `HANDOFF_EXPIRY_SECONDS` (10s): Pending handoff auto-accepts if holder doesn't respond

**API Response Enrichment:**
- `expiresInSeconds`: Server-calculated time remaining for pending handoff
- `handoffTimeoutSeconds`: Current timeout setting for client reference
- `connectedCoaches`: List of all coaches actively polling (from ping endpoint only)

### Invite Codes

URL structure for invite codes:

| Purpose | URL Format |
|---------|------------|
| Coach invite | `/join/t/{team-hash}?role=coach` |
| Viewer invite | `/join/t/{team-hash}?role=viewer` |
| Game spectator | `/join/g/{game-hash}` |

Coach invites are single-use with 7-day expiry. Viewer invites are multi-use and permanent (but revocable).

### Multi-User Polling Strategy

**Controller polling** (via `POST /ping`):

| User Type | Poll Interval | Payload |
|-----------|---------------|---------|
| Coach (holding role) | 2 seconds | Controller state + connected coaches list |
| Coach (no role) | 5 seconds | Controller state + connected coaches list |

**Game state refresh** (via `GET /games/{id}`):

| User Type | Poll Interval | Payload |
|-----------|---------------|---------|
| Line Coach / Viewer | 3 seconds | Full game state |

Coaches poll the ping endpoint to maintain role claims and detect other coaches. The game state refresh runs separately for non-Active-Coach users to sync score/event changes. Handoff requests are detected via controller polling. Future optimization: switch to WebSockets if latency becomes problematic.

### URL Structure

| Path | Purpose |
|------|---------|
| `/` | Landing page (intro, login, download instructions) |
| `/app/` | PWA entry point |
| `/view/{game-hash}` | Public game viewer (no auth required) |
| `/join/{code}` | Invite redemption handler |

### Client-Side Auth Module

```
auth/
├── config.js         # Supabase URL and anon key
├── auth.js           # Supabase client, session management
└── loginScreen.js    # Login/signup UI component

teams/
└── teamSettings.js   # Team settings, member list, invite management UI
```

Exported via `window.breakside.auth`:
- `initializeAuth()` - Initialize Supabase client
- `isAuthenticated()` - Check if user is logged in
- `getCurrentUser()` - Get current user object
- `getAuthHeaders()` - Get `Authorization: Bearer {token}` header
- `signIn(email, password)` - Sign in
- `signOut()` - Sign out and redirect to landing

---

## Deployment

### Infrastructure

| Component | Details |
|-----------|---------|
| **CloudFront (prod)** | Distribution `E6M9KCXIU9CKD` |
| **CloudFront (staging)** | Distribution `E12N2STN9MM8FA` |
| **S3 Bucket (prod)** | `breakside.pro` (us-east-1) |
| **S3 Bucket (staging)** | `staging.breakside.pro` (us-east-1) |
| **EC2 Instance** | Amazon Linux 2, IP: 3.212.138.180 |
| **SSL (CloudFront)** | ACM certificate |
| **SSL (EC2)** | Let's Encrypt via certbot |

### Configuration Files

| File | Purpose |
|------|---------|
| `/etc/breakside/env` | Environment variables |
| `/etc/systemd/system/breakside.service` | systemd unit |
| `/etc/nginx/conf.d/breakside.conf` | nginx config |
| `/etc/cron.d/certbot` | SSL renewal cron |

### DNS (Pair.com)

| Domain | Type | Value |
|--------|------|-------|
| `breakside.pro` | A | 3.212.138.180 |
| `www.breakside.pro` | CNAME | d17eottm1x91n5.cloudfront.net |
| `staging.breakside.pro` | CNAME | *(CloudFront distribution domain for E12N2STN9MM8FA)* |
| `api.breakside.pro` | A | 3.212.138.180 |

### CI/CD

**Production** — GitHub Actions workflow (`.github/workflows/main.yml`):
1. Triggers on push to `main` branch
2. Increments build version if not already bumped (e.g., PR merges)
3. Syncs PWA files to S3 (`breakside.pro`)
4. Syncs viewer to S3
5. Invalidates CloudFront cache (`E6M9KCXIU9CKD`)

**Version bumping** — Build number in `version.json` increments automatically:
- Direct commits to main: pre-commit hook (`.git/hooks/pre-commit`)
- PR merges: CI workflow detects missing `version.json` change and bumps
- Feature branches: hook skips to avoid merge conflicts across worktrees

**Staging** — Manual deploy via `./scripts/deploy-staging.sh "<short version description>"`:

Always pass a short version description (e.g. `"test audio narration v2"`) so testers can visually verify which build they're running. The label flows through to:

1. `version.json` `deployLabel` field, plus a `deployStamp` timestamp
2. S3 sync of working directory to `staging.breakside.pro`
3. `version.json` and service worker uploaded with no-cache headers
4. Viewer synced to S3
5. CloudFront cache invalidated (`E12N2STN9MM8FA`)

Staging has a purple header (vs production orange) via `body.staging` CSS class. The deploy stamp lets the PWA detect redeploys without a commit — tap Online/About to check for updates. The label appears in the version toast as `[label]`, making it the easiest way to confirm "am I actually on the build I just deployed?"

**Claude Desktop PATH issue** — Claude Code Desktop strips the shell PATH to a minimal `/usr/bin:/bin:/usr/sbin:/sbin`, so tools like `aws` at `/usr/local/bin` aren't found. This is a [known bug](https://github.com/anthropics/claude-code/issues/3991) — the `env.PATH` key in `settings.json` and shell dotfiles (`.zshenv`, `.zprofile`, `.zshrc`) are all ignored for Bash tool commands. The deploy script works around this by sourcing `~/.zshenv` at the top, which sets the full PATH including `/usr/local/bin` and `/opt/homebrew/bin`. Any new scripts that need tools outside the minimal PATH should do the same: `[[ -f "$HOME/.zshenv" ]] && source "$HOME/.zshenv"`.

---

## Quick Reference Commands

### EC2 / API

```bash
# SSH
ssh -i ~/.ssh/your-key.pem ec2-user@3.212.138.180

# Service management
sudo systemctl status breakside
sudo systemctl restart breakside
sudo journalctl -u breakside -f

# Deploy API updates
cd /opt/breakside && sudo git pull && sudo systemctl restart breakside

# Rebuild index
curl -X POST https://api.breakside.pro/api/index/rebuild
```

### S3 / CloudFront

```bash
# Deploy PWA
aws s3 sync . s3://breakside.pro/ \
  --exclude ".git/*" \
  --exclude "ultistats_server/*" \
  --exclude "data/*" \
  --exclude "scripts/*" \
  --exclude "*.py" \
  --exclude "*.md" \
  --exclude ".DS_Store"

# Deploy viewer
aws s3 sync ultistats_server/static/viewer/ s3://breakside.pro/viewer/

# Invalidate cache
aws cloudfront create-invalidation --distribution-id E6M9KCXIU9CKD --paths "/*"
```

---

## Performance Characteristics

| Metric | Value |
|--------|-------|
| Average game size | 5.85 KB |
| Compressed size | ~1.17 KB |
| Sync time | 25-50ms |
| Index rebuild | ~1 second (hundreds of games) |
| PWA load (cached) | <100ms |
| PWA load (network) | <500ms |

