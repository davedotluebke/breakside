## New feature: cLoud-based backend hosted on Google Sheets

I want to store Teams, Players, and Games in a backend hosted on the cloud. I want to use Google Sheets as a robust human-readable storage strategy. This app is restricted to "friends and family" for now, so it is fine to use a single Google Sheet to store all Teams (Players etc). Each Game is a separate tab in the spreadsheet, and are represented as a few header rows followed by a row-by-row serialization of each Point, Possession, and Events. The sheet should be optimized for human readability of the play-by-play events, for example with columns representing common plays (first throws - a column each for thrower, receiver, and a string listing modifiers [huck, sky, etc]; then defense, with column for defender then a string of modifier flags; then turnovers etc.). The rare events (timeouts, injury sub, etc)should be the rightmost columns.  The first couple of columns can be reserved for Point beginnings (including roster) and endings (including defense plays including "They Score" events). 

One of the first tasks will be to create a Google Sheets-based serialization and fine-tune the appearance for readability. 

As for the cloud backend, I already have a small EC2 instance and can run a Node or (slightly preferred) Python server. I have already vibe-coded a simple Google Sheets-based license plate game and gotten it working using FastAPI, but I am not attached to that app - it might be good to just directly reuse the Google Sheets API keys and other authentication mechanism from that repo, since that was a pain to get working. 

There are a few major reason to do this refactor:
- Robust cloud backup of games 
- Persistent between users, which allows:
- Interactive handoff bwetween users - one player or coach can take on updating the game when the other sets down their phone to play or talk to players etc. 
- More easily human-readable summaries of games

Note that Google Sheets can be slow to respond, and the app must continue working even if it loses connectivity. This means the Google Sheets storage is probably more of a continuously and aysnchronously updated log of the game, than the actual storage relied on by the app for play-by-play event updates.  

### Detailed plan

#### Phase 1: Google Sheets Schema Design

**Master Spreadsheet Structure:**
- **Teams Sheet** - Single sheet listing all teams
  - Columns: `team_id`, `team_name`, `created_at`, `last_updated`
  - One row per team
  
- **Players Sheet** - All players across all teams
  - Columns: `player_id`, `team_id`, `name`, `nickname`, `gender`, `number`, `created_at`
  - Multiple rows per team (one per player)
  
- **Games Sheet** - Game metadata
  - Columns: `game_id`, `team_id`, `team_name`, `opponent_name`, `starting_position`, `game_start_timestamp`, `game_end_timestamp`, `alternate_gender_ratio`, `alternate_gender_pulls`, `starting_gender_ratio`, `final_score_team`, `final_score_opponent`, `sheet_name` (tab name)
  - One row per game
  
- **Game Tabs** - One tab per game (named with game_id or descriptive name)
  - Each tab contains play-by-play data for a single game
  - Format optimized for human readability

**Game Tab Schema (Human-Readable Play-by-Play):**

Header rows (rows 1-3):
- Row 1: Game metadata (team name, opponent, date, etc.)
- Row 2: Column headers
- Row 3: (Optional) Column descriptions/formatting hints

Data columns (left to right, most common first):
1. **Point Start Columns** (Columns A-C)
   - `Point #` - Sequential point number
   - `Point Start Time` - Timestamp when point started
   - `Starting Position` - "Offense" or "Defense"
   - `Active Players` - Comma-separated list of player names (7 players)

2. **Throw Columns** (Columns D-F) - Most common events
   - `Thrower` - Player name
   - `Receiver` - Player name  
   - `Throw Modifiers` - Space-separated flags: "huck", "break", "dump", "hammer", "sky", "layout", "score"
   - Example: "huck sky score" means a huck that was caught with a sky for a score

3. **Defense Columns** (Columns G-H)
   - `Defender` - Player name
   - `Defense Modifiers` - Space-separated flags: "interception", "layout", "sky", "Callahan", "stall", "unforced"
   - Example: "interception layout" means a layout interception

4. **Turnover Columns** (Columns I-K)
   - `Turnover Type` - "throwaway", "drop", "stall", "unforced"
   - `Turnover Player` - Player name (thrower or receiver depending on type)
   - `Turnover Modifiers` - Space-separated flags: "huck", "defense"
   - Example: "drop defense huck" means a dropped huck due to good defense

5. **Violation Columns** (Columns L-M)
   - `Violation Type` - "offensive", "strip", "pick", "travel", "contested", "doubleTeam"
   - `Violation Player` - Player name (if applicable)

6. **Pull Column** (Column N)
   - `Pull` - Format: "PlayerName (quality) [flags]"
   - Example: "John Doe (Good Pull) flick io" or "Unknown Player (Brick)"

7. **Other Events Columns** (Columns O-R) - Rare events
   - `Timeout` - "team" or "opponent" or empty
   - `Injury Sub` - Player name or empty
   - `Time Cap` - "hard" or "soft" or empty
   - `Side Switch` - "yes" or empty
   - `Halftime` - "yes" or empty

8. **Point End Columns** (Columns S-U)
   - `Point End Time` - Timestamp when point ended
   - `Point Duration` - Duration in seconds
   - `Point Winner` - "team" or "opponent"
   - `Score After Point` - Format: "team_score-opponent_score"

9. **Possession Tracking** (Columns V-W) - Optional, for detailed analysis
   - `Possession #` - Sequential possession number within point
   - `Possession Type` - "offensive" or "defensive"

**Row Structure:**
- Each row represents either:
  - A point start (Point Start columns filled, other columns mostly empty)
  - An event within a possession (Throw/Defense/Turnover/Violation/Pull/Other columns filled)
  - A point end (Point End columns filled)
- Possessions are implicit - a new possession starts when there's a turnover or point start
- Events within a possession are sequential rows between point start and point end

**Example Row:**
```
Point # | Point Start Time | Starting Position | Active Players | Thrower | Receiver | Throw Modifiers | Defender | Defense Modifiers | ...
1       | 2024-01-15 10:00 | Offense          | Alice,Bob,...  |         |          |                 |          |                   | ...
1       |                  |                  |                | Alice   | Bob      | huck            |          |                   | ...
1       |                  |                  |                | Bob     | Charlie  | break           |          |                   | ...
1       |                  |                  |                |         |          |                 | Dave     | interception      | ...
1       |                  |                  |                |         |          |                 |          |                   | ... (point end)
```

#### Phase 2: Server Architecture

**Directory Structure:**
```
ultistats_server/
├── main.py                    # FastAPI application entrypoint
├── requirements.txt           # Python dependencies
├── config.py                  # Configuration (reuse from license_plate_server)
├── auth/                      # Authentication (reuse from license_plate_server)
│   ├── __init__.py
│   ├── models.py
│   └── routes.py
├── sheets/                    # Google Sheets integration
│   ├── __init__.py
│   ├── service.py             # Reuse SheetsService class pattern
│   ├── operations.py          # CRUD operations for Teams, Players, Games
│   └── serialization.py       # Convert between app data models and Sheets format
├── websocket/                 # WebSocket handlers
│   ├── __init__.py
│   └── handlers.py           # Real-time game update handlers
└── static/                    # Static files (if needed)
```

**Server Components:**

1. **Google Sheets Service** (`sheets/service.py`)
   - Reuse `SheetsService` class from license_plate_server
   - Methods: `get_values()`, `append_values()`, `update_values()`, `create_sheet()`, `delete_row()`
   - Handle authentication via service account (reuse credentials/config)

2. **Sheets Operations** (`sheets/operations.py`)
   - `get_teams()` - Read all teams from Teams sheet
   - `create_team(team_data)` - Add team to Teams sheet
   - `get_players(team_id)` - Get all players for a team
   - `create_player(player_data)` - Add player to Players sheet
   - `get_games(team_id)` - Get all games for a team
   - `create_game(game_data)` - Create game in Games sheet + create new tab
   - `get_game_data(game_id)` - Read play-by-play from game tab
   - `append_game_event(game_id, event_data)` - Add event row to game tab
   - `update_point_end(game_id, point_data)` - Update point end columns

3. **Sheets Serialization** (`sheets/serialization.py`)
   - `serialize_point_to_rows(point)` - Convert Point object to sheet rows
   - `serialize_event_to_row(event, point_num, possession_num)` - Convert Event to row
   - `deserialize_game_tab(game_id)` - Read tab and reconstruct Game object
   - `format_throw_modifiers(throw_event)` - Convert flags to space-separated string
   - `parse_throw_modifiers(modifier_string)` - Parse string back to flags
   - Similar functions for Defense, Turnover, Violation, Pull, Other events

4. **API Endpoints** (`main.py`)
   - `GET /teams` - List all teams
   - `POST /teams` - Create new team
   - `GET /teams/{team_id}/players` - Get team roster
   - `POST /teams/{team_id}/players` - Add player to team
   - `GET /teams/{team_id}/games` - List games for team
   - `POST /games` - Create new game (creates tab)
   - `GET /games/{game_id}` - Get game data
   - `POST /games/{game_id}/events` - Append event to game (async, non-blocking)
   - `POST /games/{game_id}/points/{point_id}/end` - Mark point as ended
   - `POST /games/{game_id}/end` - End game
   - `WebSocket /ws/{game_id}` - Real-time updates

5. **WebSocket Handler** (`websocket/handlers.py`)
   - Reuse `ConnectionManager` pattern from license_plate_server
   - Message types:
     - `new_event` - Broadcast when event is added
     - `point_started` - Broadcast when point begins
     - `point_ended` - Broadcast when point ends
     - `game_ended` - Broadcast when game ends
     - `sync_request` - Client requests full game state
     - `sync_response` - Server sends full game state

#### Phase 3: Client-Side Architecture

**Storage Strategy:**
- **Primary Storage**: LocalStorage (unchanged) - app continues to work offline
- **Secondary Storage**: Google Sheets via server - async backup and sync
- **Sync Queue**: Queue of pending operations when offline

**New Modules:**

1. **`data/sync.js`** - Synchronization layer
   - `syncToCloud()` - Send local changes to server
   - `syncFromCloud()` - Pull latest changes from server
   - `queueOperation(operation)` - Queue operation when offline
   - `processSyncQueue()` - Process queued operations when online
   - `isOnline()` - Check connectivity
   - `getLastSyncTimestamp()` - Track last successful sync

2. **`data/websocket.js`** - WebSocket client
   - `connectToGame(gameId, token)` - Establish WebSocket connection
   - `sendEvent(event)` - Send event to server
   - `onEventReceived(callback)` - Handle incoming events
   - `onPointStarted(callback)` - Handle point start broadcasts
   - `onPointEnded(callback)` - Handle point end broadcasts
   - Handle reconnection logic

3. **Modify `data/storage.js`**:
   - Add hooks after `saveAllTeamsData()` to trigger `syncToCloud()`
   - Add `syncGameToCloud(game)` - Serialize and send game to server
   - Add `syncEventToCloud(gameId, pointId, possessionId, event)` - Send single event
   - Make sync operations async and non-blocking (fire-and-forget)

**Integration Points:**

1. **Game Creation** (`game/gameLogic.js`):
   - After creating game locally, call `syncToCloud()` to create game tab
   - Store `gameId` (server-generated) in Game object

2. **Event Creation** (`playByPlay/offenseScreen.js`, `playByPlay/defenseScreen.js`, etc.):
   - After adding event locally, queue `syncEventToCloud()` operation
   - Don't wait for server response before continuing

3. **Point Management** (`game/pointManagement.js`):
   - On point start: send point start row to server
   - On point end: send point end row to server

4. **Game End** (`game/gameLogic.js`):
   - On game end: sync final game state to server
   - Update Games sheet with final scores

**Offline-First Flow:**
1. User action → Save to LocalStorage immediately (unchanged behavior)
2. Queue sync operation to background queue
3. If online: attempt sync immediately (async, non-blocking)
4. If offline: queue operation for later
5. On reconnect: process sync queue
6. On app startup: check for pending syncs and process

**Conflict Resolution:**
- Last-write-wins for events (server timestamp wins)
- On sync, compare local vs cloud timestamps
- If local is newer: send to server
- If cloud is newer: update local storage
- For simultaneous edits: server timestamp breaks tie

#### Phase 4: Authentication & Authorization

**Reuse from license_plate_server:**
- JWT-based authentication
- User registration/login endpoints
- WebSocket token authentication

**User Model:**
- Store users in Google Sheets (Users sheet)
- Track which games each user has access to
- For "friends and family" scope: simple username/password, no complex permissions

**Client Authentication:**
- Add login screen to PWA (optional - can work offline without login)
- Store JWT token in LocalStorage
- Include token in WebSocket connection and API requests
- If no token: app works offline-only (no sync)

#### Phase 5: Implementation Phases

**Phase 5.1: Google Sheets Serialization (Foundation)**
- [ ] Create `sheets/serialization.py` with conversion functions
- [ ] Design and document exact column schema
- [ ] Write unit tests for serialization/deserialization
- [ ] Create sample game tab manually to validate readability
- [ ] Iterate on schema based on readability feedback

**Phase 5.2: Server Setup**
- [ ] Create `ultistats_server/` directory structure
- [ ] Copy and adapt `config.py` from license_plate_server
- [ ] Copy and adapt `sheets/service.py` (SheetsService)
- [ ] Copy and adapt `auth/` modules
- [ ] Set up Google Sheets API credentials
- [ ] Create master spreadsheet with Teams, Players, Games sheets
- [ ] Test basic read/write operations

**Phase 5.3: Server API Implementation**
- [ ] Implement `sheets/operations.py` for Teams, Players, Games CRUD
- [ ] Implement `sheets/serialization.py` for game tab format
- [ ] Implement REST API endpoints in `main.py`
- [ ] Test API endpoints with Postman/curl
- [ ] Implement WebSocket handler for real-time updates
- [ ] Test WebSocket connection and message passing

**Phase 5.4: Client Sync Layer**
- [ ] Create `data/sync.js` module
- [ ] Create `data/websocket.js` module
- [ ] Modify `data/storage.js` to add sync hooks
- [ ] Implement sync queue for offline operations
- [ ] Test offline/online transitions

**Phase 5.5: Client Integration**
- [ ] Integrate sync into game creation flow
- [ ] Integrate sync into event creation flows
- [ ] Integrate sync into point management
- [ ] Add WebSocket connection on game start
- [ ] Handle real-time updates from other users
- [ ] Test multi-user scenarios

**Phase 5.6: Testing & Refinement**
- [ ] Test full game tracking with cloud sync
- [ ] Test offline mode and sync queue
- [ ] Test multi-user handoff scenarios
- [ ] Validate Google Sheets readability
- [ ] Performance testing (ensure sync doesn't slow down app)
- [ ] Error handling and retry logic
- [ ] User feedback for sync status

**Phase 5.7: Deployment**
- [ ] Deploy server to EC2 instance
- [ ] Set up environment variables and secrets
- [ ] Configure CORS for production domain
- [ ] Update client to point to production server
- [ ] Test end-to-end in production
- [ ] Monitor server logs and error rates

#### Phase 6: Technical Considerations

**Performance:**
- Google Sheets API has rate limits (~100 requests/100 seconds/user)
- Batch operations where possible (append multiple rows at once)
- Debounce rapid event creation (batch events within 1-2 seconds)
- Use WebSocket for real-time updates (avoid polling)
- Cache game state on server to reduce Sheets reads

**Error Handling:**
- Retry logic with exponential backoff for failed syncs
- Queue failed operations for later retry
- Log sync errors but don't block user actions
- Show sync status indicator in UI (optional)
- Handle Sheets API quota errors gracefully

**Data Consistency:**
- Use timestamps for conflict resolution
- Validate data before writing to Sheets
- Handle partial writes (if point start succeeds but event fails)
- Periodic full sync to catch any inconsistencies

**Security:**
- Keep service account credentials secure (never commit to git)
- Use environment variables for sensitive config
- Validate all user input on server
- Rate limit API endpoints
- Sanitize data before writing to Sheets (prevent injection)

**Monitoring:**
- Log all sync operations
- Track sync success/failure rates
- Monitor WebSocket connection counts
- Alert on Sheets API errors
- Track game creation and event rates

#### Phase 7: Future Enhancements (Post-MVP)

- [ ] Conflict resolution UI (show conflicts to user)
- [ ] Sync status dashboard
- [ ] Export game data to other formats (CSV, JSON)
- [ ] Game analytics and visualization in Sheets
- [ ] Multi-team support (users can access multiple teams)
- [ ] Game sharing via links
- [ ] Historical game browsing
- [ ] Automated backups
- [ ] Mobile app notifications for sync status
