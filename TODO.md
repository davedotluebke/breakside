# Implementation Plan: Data Model Refactor - Cloud-First Architecture

This plan outlines a major refactoring to move from embedded data (games inside teams, players inside teams) to a normalized, cloud-first architecture where Games, Players, and Teams are all top-level entities with ID-based references.

**Key Principles:**
- Cloud is source of truth, but clients can create/modify data offline
- IDs are short and human-readable: `{name}-{4-char-hash}` (e.g., `Alice-7f3a`)
- Static viewer is updated each phase for debugging/verification
- Server maintains an index for efficient cross-entity queries

---

## Current Architecture (To Be Replaced)

```
Team
├── name: string
├── games: Game[]              # Games EMBEDDED in team
├── teamRoster: Player[]       # Players EMBEDDED in team
└── lines: Line[]

Game
├── team: string               # Team NAME (not ID)
├── opponent: string
├── points: Point[]
└── ...

Player
├── name: string               # Name used as identifier
├── stats...
└── (no unique ID)
```

**Problems:**
- Games and players can't be shared or referenced independently
- No unique player IDs (name collisions possible)
- Data duplication if player plays for multiple teams
- No server-side player/team management
- Difficult to query games across teams

---

## Target Architecture

```
Player (top-level, cloud-first)
├── id: string                 # Short ID: "Alice-7f3a"
├── name: string
├── nickname: string
├── gender: FMP|MMP|Unknown
├── number: string|null
└── createdAt, updatedAt

Team (top-level, cloud-first)
├── id: string                 # Short ID: "Sample-Team-b2c4"
├── name: string
├── playerIds: string[]        # References to Player IDs
├── lines: Line[]
└── createdAt, updatedAt

Game (top-level, cloud-first)
├── id: string                 # Existing format: YYYY-MM-DD_Team_vs_Opponent_Timestamp
├── teamId: string             # Reference to Team ID
├── opponentName: string       # Keep as string (opponent may not be in system)
├── points: Point[]
├── rosterSnapshot: {...}      # Snapshot of player info at game time
└── ...

Index (server-side, rebuilt on demand)
├── playerGames: { playerId -> [gameId, ...] }
├── teamPlayers: { teamId -> [playerId, ...] }
├── teamGames: { teamId -> [gameId, ...] }
└── gameRoster: { gameId -> [playerId, ...] }
```

**Key Changes:**
1. Players have short, human-readable unique IDs
2. Teams reference players by ID (not embed them)
3. Games reference teams by ID
4. Games include a "roster snapshot" for historical accuracy
5. Cloud server is source of truth, but offline creation is supported
6. Server maintains an index for efficient queries (rebuildable)

---

## Phase 1: Backend Infrastructure for Players & Teams

Target: Create server-side storage, API, and index for Players and Teams. Update viewer with entity browser.

### 1.1 Server Storage Layer

- [ ] Create `ultistats_server/storage/player_storage.py`
    - [ ] `save_player(player_data) -> player_id`
    - [ ] `get_player(player_id) -> player_data`
    - [ ] `list_players() -> player_list`
    - [ ] `update_player(player_id, player_data)`
    - [ ] `delete_player(player_id)`
    - [ ] File structure: `data/players/{player_id}.json`

- [ ] Create `ultistats_server/storage/team_storage.py`
    - [ ] `save_team(team_data) -> team_id`
    - [ ] `get_team(team_id) -> team_data`
    - [ ] `list_teams() -> team_list`
    - [ ] `update_team(team_id, team_data)`
    - [ ] `delete_team(team_id)`
    - [ ] `get_team_players(team_id) -> player_list` (resolve player IDs)
    - [ ] File structure: `data/teams/{team_id}.json`

- [ ] Create `ultistats_server/storage/index_storage.py`
    - [ ] `rebuild_index()` - scan all entities and rebuild
    - [ ] `get_player_games(player_id) -> [game_ids]`
    - [ ] `get_team_games(team_id) -> [game_ids]`
    - [ ] `get_game_players(game_id) -> [player_ids]`
    - [ ] `update_index_for_game(game_id, game_data)` - incremental update
    - [ ] File structure: `data/index.json` (single file, rebuilt on demand)

- [ ] Update `ultistats_server/storage/game_storage.py`
    - [ ] Add `teamId` field to game schema
    - [ ] Add `rosterSnapshot` field to preserve historical player data
    - [ ] Update `list_all_games()` to include team ID
    - [ ] Call `update_index_for_game()` on save

### 1.2 Server API Endpoints

- [ ] Add Player endpoints to `ultistats_server/main.py`:
    - [ ] `POST /players` - Create player
    - [ ] `GET /players` - List all players
    - [ ] `GET /players/{player_id}` - Get player
    - [ ] `PUT /players/{player_id}` - Update player
    - [ ] `DELETE /players/{player_id}` - Delete player
    - [ ] `GET /players/{player_id}/games` - Get games player participated in (via index)

- [ ] Add Team endpoints to `ultistats_server/main.py`:
    - [ ] `POST /teams` - Create team
    - [ ] `GET /teams` - List all teams
    - [ ] `GET /teams/{team_id}` - Get team
    - [ ] `PUT /teams/{team_id}` - Update team
    - [ ] `DELETE /teams/{team_id}` - Delete team
    - [ ] `GET /teams/{team_id}/players` - Get team's players (resolved)
    - [ ] `GET /teams/{team_id}/games` - Get team's games (via index)

- [ ] Add Index endpoints:
    - [ ] `POST /index/rebuild` - Force rebuild of index
    - [ ] `GET /index/status` - Get index stats (counts, last rebuild time)

- [ ] Update Game endpoints:
    - [ ] Ensure games include `teamId` reference
    - [ ] Add query param: `GET /games?teamId={team_id}`

### 1.3 Viewer Updates (Phase 1)

- [ ] Create new viewer home page: `ultistats_server/static/viewer/index.html`
    - [ ] Navigation tabs: Games | Teams | Players
    - [ ] Game list with team name, opponent, date, score
    - [ ] Team list with player count, game count
    - [ ] Player list with team affiliations, game count
    - [ ] Click any item to view details
- [ ] Update `viewer.js`:
    - [ ] Add API calls for `/teams`, `/players`
    - [ ] Add entity list rendering functions
    - [ ] Game detail view remains the same
- [ ] Add team detail view:
    - [ ] Show team info, player list, game history
- [ ] Add player detail view:
    - [ ] Show player info, teams, games played

### 1.4 Data Directory Structure

```
data/
├── players/
│   ├── Alice-7f3a.json
│   ├── Bob-2d9e.json
│   └── ...
├── teams/
│   ├── Sample-Team-b2c4.json
│   ├── Thunder-a1f3.json
│   └── ...
├── games/
│   ├── 2024-01-15_Sample-Team_vs_Thunder_1234567890/
│   │   ├── current.json
│   │   └── versions/...
│   └── ...
└── index.json              # Rebuilt on demand
```

---

## Phase 2: Client-Side Data Model Refactor

Target: Update PWA data models to match new architecture. Support offline creation.

### 2.1 Update `data/models.js`

- [ ] Add short ID generation utility:
    ```javascript
    function generateShortId(name) {
        const safeName = name.replace(/[^a-zA-Z0-9]/g, '-').substring(0, 20);
        const hash = Math.random().toString(36).substring(2, 6);
        return `${safeName}-${hash}`;
    }
    ```
- [ ] Update `Player` constructor:
    - [ ] Add `id` field (generated client-side if offline)
    - [ ] Add `createdAt`, `updatedAt` timestamps
    - [ ] Remove game-specific stats (move to per-game tracking)
- [ ] Update `Team` constructor:
    - [ ] Add `id` field (generated client-side if offline)
    - [ ] Change `teamRoster: Player[]` to `playerIds: string[]`
    - [ ] Remove `games` array (games are separate)
    - [ ] Add `createdAt`, `updatedAt` timestamps
- [ ] Update `Game` constructor:
    - [ ] Change `team: string` to `teamId: string`
    - [ ] Add `rosterSnapshot` for historical player data
    - [ ] Keep `opponent` as string (opponent team may not be in system)

### 2.2 Create Per-Game Stats Tracking

- [ ] Create new structure for in-game player stats:
    - [ ] Stats are stored per-point in the game's `points` array
    - [ ] Aggregate stats calculated from events (already done in `calculatePlayerStatsFromEvents`)
- [ ] Remove cumulative stats from Player object:
    - [ ] `totalPointsPlayed`, `consecutivePointsPlayed`, etc. become derived values
    - [ ] Can still compute these from game history if needed

### 2.3 Update `data/storage.js`

- [ ] Update `serializeTeam()` → `serializePlayer()`, `serializeTeam()` (separate)
- [ ] Update `serializeEvent()` - player references become player IDs
- [ ] Update `deserializeTeams()` → separate `deserializePlayers()`, `deserializeTeams()`
- [ ] Update `getPlayerFromName()` → `getPlayerById()`
- [ ] Update localStorage structure:
    - [ ] `localStorage.ultistats_players` - cached players (map by ID)
    - [ ] `localStorage.ultistats_teams` - cached teams (map by ID)
    - [ ] `localStorage.ultistats_games` - cached game metadata
    - [ ] `localStorage.ultistats_current_game` - full current game data

### 2.4 Viewer Updates (Phase 2)

- [ ] Add data model version indicator to viewer
- [ ] Show legacy vs. new format games differently
- [ ] Add migration status display

---

## Phase 3: Sync Layer Refactor

Target: Update sync to handle Players, Teams, and Games as separate entities. Full offline support.

### 3.1 Offline-First ID Generation

- [ ] Generate IDs client-side immediately (no server round-trip needed)
- [ ] ID format: `{name}-{4-char-hash}` (e.g., `Alice-7f3a`)
- [ ] Handle rare collision: append extra characters if ID exists on server
- [ ] Mark locally-created entities with `_localOnly: true` until synced

### 3.2 Update `data/sync.js`

- [ ] Add player sync functions:
    - [ ] `syncPlayerToCloud(player)` - create or update
    - [ ] `loadPlayerFromCloud(playerId)`
    - [ ] `listCloudPlayers()`
    - [ ] `createPlayerOffline(playerData)` - generate ID, save locally, queue sync
- [ ] Add team sync functions:
    - [ ] `syncTeamToCloud(team)` - create or update
    - [ ] `loadTeamFromCloud(teamId)`
    - [ ] `listCloudTeams()`
    - [ ] `createTeamOffline(teamData)` - generate ID, save locally, queue sync
- [ ] Update game sync:
    - [ ] `prepareGameForSync()` - include teamId and rosterSnapshot
    - [ ] `loadGameFromCloud()` - resolve teamId
    - [ ] `createGameOffline(gameData)` - works fully offline
- [ ] Add full sync function:
    - [ ] `syncAllData()` - sync players, teams, games in correct order
    - [ ] `pullFromCloud()` - fetch latest from server, merge with local

### 3.3 Offline Queue & Conflict Resolution

- [ ] Extend sync queue to handle different entity types:
    - [ ] `{type: 'player', action: 'create'|'update', id, data, timestamp}`
    - [ ] `{type: 'team', action: 'create'|'update', id, data, timestamp}`
    - [ ] `{type: 'game', action: 'sync', id, data, timestamp}`
- [ ] Process queue in dependency order: players → teams → games
- [ ] Handle conflicts:
    - [ ] "Last write wins" for simple conflicts
    - [ ] Track `updatedAt` timestamps for conflict detection
    - [ ] Show warning if server version is newer than local edit

### 3.4 Viewer Updates (Phase 3)

- [ ] Add sync status indicator to viewer
- [ ] Show "pending sync" badge on entities created offline
- [ ] Add manual "refresh from server" button

---

## Phase 4: UI Updates

Target: Update UI to work with new data model.

### 4.1 Team Selection Screen

- [ ] Fetch teams from cloud (or cache if offline)
- [ ] Show team list with player counts
- [ ] Add "Create Team" flow:
    - [ ] Works offline (generates ID locally)
    - [ ] Syncs when online
- [ ] Add "Sync" button to refresh from cloud
- [ ] Show sync status indicator

### 4.2 Roster Management

- [ ] Update `teams/rosterManagement.js`:
    - [ ] Player list shows players by ID lookup
    - [ ] "Add Player" creates player (locally if offline), adds ID to team
    - [ ] "Edit Player" updates player (queued if offline)
    - [ ] "Remove Player" removes ID from team (doesn't delete player)
- [ ] Add "Import Player" to add existing player to team
- [ ] Add player search/autocomplete for existing players
- [ ] Show player ID in edit dialog (for debugging)

### 4.3 Game Flow

- [ ] Update `game/gameLogic.js`:
    - [ ] `startNewGame()` uses `teamId` instead of team name
    - [ ] Creates `rosterSnapshot` from current team players
    - [ ] Player references in events use player IDs
    - [ ] Works fully offline (syncs when online)
- [ ] Update `beforePointScreen.js`:
    - [ ] Load players by ID from team's playerIds
- [ ] Update play-by-play screens:
    - [ ] Player buttons reference players by ID
    - [ ] Events store player IDs (not names)

### 4.4 Stats & Display

- [ ] Update `updateTeamRosterDisplay()`:
    - [ ] Load players by ID
    - [ ] Compute stats from game events (not stored on player)
- [ ] Update game summary:
    - [ ] Use rosterSnapshot for historical accuracy

### 4.5 Viewer Updates (Phase 4)

- [ ] Viewer can now show complete player stats across all games
- [ ] Add player career stats view (aggregate from all games via index)
- [ ] Add team season stats view

---

## Phase 5: Data Migration ✅ SKIPPED

**Decision (2024-12-07):** Migration tooling not needed. The only data worth preserving (4 CUDO Mixed games) was already migrated using `scripts/migrate_games_to_ids.py`. 

Pre-refactor localStorage data format is no longer supported. Users starting fresh will use the new ID-based format from the start.

**What was done instead:**
- [x] Server-side Python script (`scripts/migrate_games_to_ids.py`) migrated existing game files
- [x] All 4 CUDO Mixed games have `teamId`, `rosterSnapshot`, and player ID references
- [x] 18 players exist in `data/players/` with proper IDs
- [x] Index rebuilt with all cross-references

---

## Phase 6: Testing & Verification

- [ ] Unit tests for new storage functions
- [ ] Integration tests for API endpoints
- [ ] End-to-end test: create team → add players → start game → sync
- [ ] **Offline test**: create team offline → add players → start game → come online → verify sync
- [ ] Index test: rebuild index → verify queries return correct results
- [ ] Viewer test: verify all entity views work correctly

---

## Future Phases (Deferred)

### Phase 7: Handoff / "Take Over" Functionality

Target: Allow multiple users to follow a game and transfer write-control.

- [ ] Backend: In-memory state `game_controllers`
- [ ] Endpoints: `/games/{game_id}/status`, `/request-takeover`, `/approve-takeover`
- [ ] Frontend: Controller badge, "Request Take Over" button, approval modal
- [ ] Disable event buttons if not controller

### Phase 8: Git-Based Backup

Target: Robust version history using Git.

- [ ] Verify `ENABLE_GIT_VERSIONING` in config
- [ ] Test git init and commit on game sync
- [ ] Add git log viewing endpoint

---

## Technical Notes

### Short ID Generation

Human-readable IDs with collision-resistant hash:

```javascript
/**
 * Generate a short, human-readable ID
 * Format: {sanitized-name}-{4-char-hash}
 * Example: "Alice-7f3a", "Sample-Team-b2c4"
 */
function generateShortId(name) {
    // Sanitize: keep alphanumeric and hyphens, max 20 chars
    const safeName = name
        .replace(/[^a-zA-Z0-9\s-]/g, '')
        .replace(/\s+/g, '-')
        .substring(0, 20)
        .replace(/-+$/, ''); // trim trailing hyphens
    
    // Generate 4-char alphanumeric hash
    const hash = Math.random().toString(36).substring(2, 6);
    
    return `${safeName}-${hash}`;
}

// Examples:
// generateShortId("Alice")        -> "Alice-7f3a"
// generateShortId("Sample Team")  -> "Sample-Team-b2c4"
// generateShortId("Bob Smith Jr") -> "Bob-Smith-Jr-x9d2"
```

**Collision Handling:**
- On sync, if ID already exists on server with different data, append 2 more chars
- Example: `Alice-7f3a` collides → try `Alice-7f3a2b`
- Extremely rare with 4-char hash (1 in 1.6M chance per name)

### Server-Side Index Structure

```json
{
  "lastRebuilt": "2024-01-15T10:30:00Z",
  "playerGames": {
    "Alice-7f3a": ["2024-01-15_Team_vs_Opp_123", "2024-01-16_Team_vs_Opp_456"],
    "Bob-2d9e": ["2024-01-15_Team_vs_Opp_123"]
  },
  "teamGames": {
    "Sample-Team-b2c4": ["2024-01-15_Team_vs_Opp_123", "2024-01-16_Team_vs_Opp_456"]
  },
  "gameRoster": {
    "2024-01-15_Team_vs_Opp_123": ["Alice-7f3a", "Bob-2d9e", "Charlie-4k1m"]
  }
}
```

**Rebuild Logic:**
- Scan all games, extract player IDs from rosterSnapshot
- Scan all teams, extract player IDs
- Takes ~1 second for hundreds of games
- Triggered manually via `POST /index/rebuild` or automatically if index.json missing

### Roster Snapshot Structure

Capture player state at game time for historical accuracy:

```javascript
rosterSnapshot: {
    players: [
        {
            id: "Alice-7f3a",
            name: "Alice",
            nickname: "Ace",
            number: "7",
            gender: "FMP"
        },
        // ...
    ],
    capturedAt: "2024-01-15T10:30:00Z"
}
```

### Event Player References

Events reference players by ID:

```javascript
{
    type: "Throw",
    throwerId: "Alice-7f3a",
    receiverId: "Bob-2d9e",
    // ... other flags
}
```

### Backward Compatibility

During transition, support both formats:
- If event has `thrower` (object with name), use legacy lookup
- If event has `throwerId` (string), use ID lookup
- Migration converts legacy → ID format

### Offline Creation Flow

```
User creates player while offline:
1. generateShortId("Alice") -> "Alice-7f3a"
2. Save to localStorage with _localOnly: true
3. Add to sync queue: {type: 'player', action: 'create', id: 'Alice-7f3a', data: {...}}
4. UI shows player immediately (works offline)

When online:
5. Process sync queue
6. POST /players with player data
7. If ID collision, server returns new ID, update local
8. Remove _localOnly flag
```

---

## Success Criteria

1. ✅ Players exist as independent entities with short, readable IDs
2. ✅ Teams reference players by ID
3. ✅ Games reference teams by ID and include roster snapshot
4. ✅ All data syncs to cloud server
5. ✅ App works fully offline (create teams, players, games)
6. ✅ Existing data migrates cleanly *(4 CUDO games migrated via Python script)*
7. ✅ Stats computed correctly from events
8. ✅ Server index enables efficient cross-entity queries
9. ✅ Viewer shows games, teams, and players with navigation
10. ✅ Viewer updated incrementally with each phase
