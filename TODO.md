# Implementation Plan: Game Viewer & Handoff

This plan outlines the steps to implement the HTML Game Viewer, Handoff functionality, and Git-based backups, following the design in `JSON_BACKEND_DESIGN.md`.

## Phase 1: HTML Game Viewer (Completed)
Target: Create a read-only, sharable view of a game that updates as the game progresses.

- [x] Create directory structure `ultistats_server/static/viewer/`
- [x] Update `ultistats_server/main.py` to mount static files
- [x] Create `index.html` for viewer
- [x] Create `viewer.css` (including responsive design, info panel)
- [x] Create `viewer.js` (including polling, rendering, auto-scroll)
- [x] Fix: Viewer score/winner display bugs
- [x] Fix: Point ordering (oldest to newest)
- [x] Fix: Game duration calculation
- [x] Feature: Rich event details (summaries)
- [x] Feature: Point roster display
- [x] Feature: Collapsible game info header

## Phase 2: End-to-End Testing & Verification (In Progress)
Target: Verify the "live" updating capability, working with user to enter a game in the PWA while watching the web viewer to verify the right things happen.

- [x] Ensure Game objects have IDs in `data/models.js`
- [x] Ensure new games get an ID in `game/gameLogic.js`
- [x] Fix: PWA reloading due to Live Server watching backend files (Added `.vscode/settings.json`)
- [x] Fix: Real-time syncing of intra-point events (Added `saveAllTeamsData` calls in PWA event handlers)
- [x] Verify intra-point updates in Viewer
- [ ] Verify Undo functionality in Viewer

## Phase 3: Handoff / "Take Over" Functionality
Target: Allow multiple users to follow a game and transfer write-control.

### 3.1 Backend State (`ultistats_server/main.py` or `handoff.py`)
- [ ] Implement in-memory state `game_controllers` (Dict mapping game_id to controller info).
- [ ] Implement Endpoints:
    - [ ] `GET /games/{game_id}/status`: Returns current controller and pending requests.
    - [ ] `POST /games/{game_id}/follow`: Register user as follower (implicit in status check?).
    - [ ] `POST /games/{game_id}/request-takeover`: Add user to pending requests.
    - [ ] `POST /games/{game_id}/approve-takeover`: Current controller approves request.
    - [ ] `POST /games/{game_id}/dismiss-takeover`: Current controller denies request.

### 3.2 Frontend Integration (`data/sync.js` + UI)
- [ ] Add UI components to Navigation bar or Game Header:
    - [ ] "Controller" Badge (Green/Red).
    - [ ] "Request Take Over" Button (visible if not controller).
    - [ ] "Approve Request" Modal/Toast (visible if controller and request comes in).
- [ ] Update `sync.js`:
    - [ ] Polling loop for Game Status (`checkGameStatus`).
    - [ ] Handle "Take Over" logic (send request, wait for approval).
    - [ ] Handle "Approve" logic.
    - [ ] **Critical**: Disable "Add Event" / "Undo" buttons if not controller? (Or just warn?).

## Phase 4: Git-Based Backup (Lowest Priority)
Target: Robust version history using Git.

### 4.1 Verification & Enablement
- [ ] Check `ultistats_server/config.py` (or env vars) for `ENABLE_GIT_VERSIONING`.
- [ ] Verify `save_game_version` in `game_storage.py` correctly initializes repo and commits.
- [ ] Test:
    - [ ] Sync a game.
    - [ ] Check `.git` log in `data/games/{game_id}/`.
