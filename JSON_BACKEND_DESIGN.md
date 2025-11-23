# JSON Files Backend - Detailed Design

## Overview

This document details the implementation of Option 1 (JSON files) with specific solutions for versioning, undo support, sync strategy, game viewer, and handoff flow.

---

## 1. Versioning Strategy for Robust Backup

### Approach: Git-based Versioning with Timestamps

**File Structure:**
```
/data/
  games/
    {game_id}/
      current.json          # Latest version (symlink or actual file)
      versions/
        2024-01-15T10-30-45.json
        2024-01-15T10-35-12.json
        2024-01-15T10-40-23.json
      .git/                 # Git repo for this game (optional)
  teams/
    {team_id}.json
  users/
    users.json
```

**Versioning Strategy:**

1. **Automatic Versioning on Every Sync**
   - Every time a game is synced, create a timestamped version file
   - Keep `current.json` as the latest version (for fast access)
   - Timestamp format: `YYYY-MM-DDTHH-MM-SS.json` (filesystem-safe)

2. **Git Integration (Optional but Recommended)**
   - Initialize a git repo in each game directory
   - Auto-commit each version: `git add versions/*.json && git commit -m "Sync at {timestamp}"`
   - Provides full history, diff viewing, and rollback capability
   - Can use `git log` to see all changes

3. **Retention Policy**
   - Keep all versions for active games (games updated in last 30 days)
   - For completed games older than 30 days: keep daily snapshots only
   - For completed games older than 1 year: keep weekly snapshots only
   - Cleanup script runs monthly

**Implementation:**
```python
# ultistats_server/storage/game_storage.py

import json
import os
from pathlib import Path
from datetime import datetime
import shutil

GAMES_DIR = Path("/data/games")

def save_game_version(game_id: str, game_data: dict):
    """Save game with versioning."""
    game_dir = GAMES_DIR / game_id
    game_dir.mkdir(parents=True, exist_ok=True)
    versions_dir = game_dir / "versions"
    versions_dir.mkdir(exist_ok=True)
    
    # Create timestamped version
    timestamp = datetime.now().strftime("%Y-%m-%dT%H-%M-%S")
    version_file = versions_dir / f"{timestamp}.json"
    
    with open(version_file, 'w') as f:
        json.dump(game_data, f, indent=2)
    
    # Update current.json
    current_file = game_dir / "current.json"
    shutil.copy(version_file, current_file)
    
    # Optional: Git commit
    if (game_dir / ".git").exists():
        import subprocess
        subprocess.run(["git", "-C", str(game_dir), "add", "versions/", "current.json"], 
                      check=False)
        subprocess.run(["git", "-C", str(game_dir), "commit", "-m", f"Sync at {timestamp}"], 
                      check=False)
    
    return str(version_file)

def get_game_current(game_id: str) -> dict:
    """Get current version of game."""
    current_file = GAMES_DIR / game_id / "current.json"
    if not current_file.exists():
        raise FileNotFoundError(f"Game {game_id} not found")
    
    with open(current_file, 'r') as f:
        return json.load(f)

def get_game_version(game_id: str, timestamp: str) -> dict:
    """Get specific version of game."""
    version_file = GAMES_DIR / game_id / "versions" / f"{timestamp}.json"
    if not version_file.exists():
        raise FileNotFoundError(f"Version {timestamp} not found")
    
    with open(version_file, 'r') as f:
        return json.load(f)

def list_game_versions(game_id: str) -> list:
    """List all versions of a game."""
    versions_dir = GAMES_DIR / game_id / "versions"
    if not versions_dir.exists():
        return []
    
    versions = sorted([f.stem for f in versions_dir.glob("*.json")], reverse=True)
    return versions
```

**API Endpoints:**
```python
@app.get("/games/{game_id}/versions")
async def list_versions(game_id: str):
    """List all versions of a game."""
    versions = list_game_versions(game_id)
    return {"game_id": game_id, "versions": versions}

@app.get("/games/{game_id}/versions/{timestamp}")
async def get_version(game_id: str, timestamp: str):
    """Get specific version of a game."""
    game_data = get_game_version(game_id, timestamp)
    return game_data

@app.post("/games/{game_id}/restore/{timestamp}")
async def restore_version(game_id: str, timestamp: str):
    """Restore game to a specific version."""
    game_data = get_game_version(game_id, timestamp)
    save_game_version(game_id, game_data)
    return {"status": "restored", "timestamp": timestamp}
```

**Benefits:**
- ✅ Full history of all changes
- ✅ Can rollback to any point in time
- ✅ Git provides diff viewing
- ✅ Automatic, no manual backup needed
- ✅ Space-efficient (git compresses well)

---

## 2. Undo Support & Sync Efficiency

### Game Size Analysis (Based on Real Data)

**Actual Analysis of 6 Real Games:**
- **Average game size**: 5.85 KB (5,990 bytes)
- **Smallest game**: 4.15 KB (4,249 bytes)
- **Largest game**: 7.33 KB (7,504 bytes)
- **Median game size**: 6.00 KB (6,139 bytes)

**Breakdown:**
- **Game metadata**: ~320 bytes (team name, opponent, timestamps, etc.)
- **Points data**: ~4-7 KB (varies by number of points/events)
- **Size per point**: ~350-500 bytes
- **Size per event**: ~200-500 bytes (varies by event type)

**With gzip compression:**
- **Average compressed**: ~1.17 KB
- **Largest compressed**: ~1.47 KB

**Conclusion: Full game sync is highly efficient!**
- Even the largest game (7.33 KB) syncs in <50ms on a good connection
- With gzip compression, average sync is ~1.17 KB
- Network overhead is negligible

### Recommendation: **Stateless Full Game Sync**

**Why:**
1. **Small data size** - 50-100KB is tiny for modern networks
2. **Simpler code** - no incremental update logic needed
3. **Easier undo** - just send previous game state
4. **Easier conflict resolution** - compare full game states
5. **Easier debugging** - can inspect complete game state

**Sync Strategy:**
- Every event/undo operation sends **entire game state** to server
- Server stores complete game state (no incremental updates)
- Client always has complete game state locally
- Sync is idempotent (can send same state multiple times safely)

**Implementation:**
```python
# ultistats_server/main.py

@app.post("/games/{game_id}/sync")
async def sync_game(game_id: str, game_data: dict):
    """
    Full game sync - replaces entire game state.
    Idempotent: can be called multiple times safely.
    """
    # Validate game data structure
    if not validate_game_data(game_data):
        raise HTTPException(status_code=400, detail="Invalid game data")
    
    # Save with versioning
    version_file = save_game_version(game_id, game_data)
    
    # Return sync confirmation
    return {
        "status": "synced",
        "game_id": game_id,
        "version": Path(version_file).stem,
        "timestamp": datetime.now().isoformat()
    }

@app.get("/games/{game_id}")
async def get_game(game_id: str):
    """Get current game state."""
    game_data = get_game_current(game_id)
    return game_data
```

**Client-Side Sync:**
```javascript
// data/sync.js

async function syncGameToServer(gameId, gameData) {
    try {
        const response = await fetch(`${API_BASE}/games/${gameId}/sync`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${getAuthToken()}`
            },
            body: JSON.stringify(gameData)
        });
        
        if (!response.ok) {
            throw new Error(`Sync failed: ${response.statusText}`);
        }
        
        const result = await response.json();
        console.log(`Game synced: ${result.version}`);
        return result;
    } catch (error) {
        console.error('Sync error:', error);
        // Queue for retry
        queueSyncOperation(gameId, gameData);
        throw error;
    }
}

// Hook into undo function
function undoEvent() {
    // ... existing undo logic ...
    
    // After undo, sync entire game state
    const game = currentGame();
    syncGameToServer(game.id, serializeGame(game)).catch(err => {
        console.error('Failed to sync after undo:', err);
    });
}
```

**Performance Considerations (Based on Real Data):**
- **5-7KB JSON**: Compresses to ~1-1.5KB with gzip (FastAPI auto-compresses)
- **Network time**: <20ms on good connection (even on 3G: <100ms)
- **Server write time**: <5ms (filesystem write)
- **Total sync time**: ~25-50ms (negligible, feels instant)

**Real-World Performance:**
- Average game sync: ~25ms total time
- Largest game sync: ~50ms total time
- Even on slow 3G: <200ms total time
- **Conclusion**: Full sync is so fast that incremental updates would add complexity without meaningful benefit

**If Game Size Grows (Unlikely):**
- If games exceed ~100KB (20x current size), consider:
  1. Compression (already handled by FastAPI gzip)
  2. Incremental updates (only sync changed points)
  3. But based on real data, games are consistently small

---

## 3. Incremental Updates vs Full Sync

### Decision: **Full Sync Only** (Confirmed by Real Data)

**Rationale:**
1. **Data is tiny** - 5-7KB average (10x smaller than initial estimate!)
2. **Simpler code** - no need to track what changed
3. **Easier undo** - just send previous state
4. **Easier conflict resolution** - compare full states
5. **Stateless server** - server doesn't need to track game state
6. **Negligible performance impact** - ~25-50ms sync time

**Real Data Confirms:**
- Average game: 5.85 KB → ~1.17 KB compressed
- Largest game: 7.33 KB → ~1.47 KB compressed
- Sync time: <50ms even for largest game
- **Conclusion**: Incremental updates would add complexity for zero benefit

**When to Consider Incremental Updates (Unlikely):**
- If games regularly exceed 100KB (20x current size)
- If sync becomes noticeably slow (>500ms)
- If network bandwidth becomes a concern
- **But**: Real data shows games are consistently small

**Future Incremental Update Design (if needed):**
```python
# Only sync changed points
@app.post("/games/{game_id}/points/{point_index}")
async def sync_point(game_id: str, point_index: int, point_data: dict):
    game = get_game_current(game_id)
    game['points'][point_index] = point_data
    save_game_version(game_id, game)
    return {"status": "synced"}
```

But for MVP, **full sync is the right choice**.

---

## 4. Human-Readable Game Viewer

### Design: HTML Viewer with Unfurling Points

**File Structure:**
```
ultistats_server/
  static/
    viewer/
      index.html          # Game viewer page
      viewer.js           # Viewer logic
      viewer.css          # Styling
```

**Features:**
- **Unfurling Points** - Click to expand/collapse each point
- **Unfurling Possessions** - Within each point, expand/collapse possessions
- **Event Timeline** - Visual timeline of events within each possession
- **Statistics Panel** - Player stats, team stats, point summaries
- **Responsive Design** - Works on phone and desktop
- **Print-Friendly** - Can print game summary

**API Endpoint:**
```python
@app.get("/games/{game_id}/view")
async def view_game(game_id: str):
    """Serve game viewer HTML page."""
    return FileResponse("static/viewer/index.html")

@app.get("/games/{game_id}/view/data")
async def get_game_for_viewer(game_id: str):
    """Get game data formatted for viewer."""
    game_data = get_game_current(game_id)
    return game_data  # Same JSON, viewer formats it
```

**Viewer HTML Structure:**
```html
<!DOCTYPE html>
<html>
<head>
    <title>Game Viewer - {team} vs {opponent}</title>
    <link rel="stylesheet" href="/static/viewer/viewer.css">
</head>
<body>
    <div class="game-header">
        <h1>{team} vs {opponent}</h1>
        <div class="game-meta">
            <span>Date: {date}</span>
            <span>Final Score: {score}</span>
        </div>
    </div>
    
    <div class="game-stats">
        <!-- Player stats table -->
    </div>
    
    <div class="points-container">
        <!-- Dynamically generated points -->
        <div class="point" data-point-num="1">
            <div class="point-header" onclick="togglePoint(1)">
                <span>Point 1</span>
                <span class="point-summary">Team 1-0</span>
            </div>
            <div class="point-content">
                <div class="possessions">
                    <!-- Possessions with events -->
                </div>
            </div>
        </div>
    </div>
    
    <script src="/static/viewer/viewer.js"></script>
</body>
</html>
```

**Viewer JavaScript:**
```javascript
// static/viewer/viewer.js

async function loadGame(gameId) {
    const response = await fetch(`/games/${gameId}/view/data`);
    const game = await response.json();
    renderGame(game);
}

function renderGame(game) {
    // Render game header
    document.querySelector('.game-header h1').textContent = 
        `${game.team} vs ${game.opponent}`;
    
    // Render points
    const pointsContainer = document.querySelector('.points-container');
    game.points.forEach((point, index) => {
        const pointElement = createPointElement(point, index + 1);
        pointsContainer.appendChild(pointElement);
    });
    
    // Render stats
    renderStats(game);
}

function createPointElement(point, pointNum) {
    const div = document.createElement('div');
    div.className = 'point';
    div.innerHTML = `
        <div class="point-header" onclick="togglePoint(${pointNum})">
            <span>Point ${pointNum}</span>
            <span class="point-summary">${formatPointSummary(point)}</span>
        </div>
        <div class="point-content" id="point-${pointNum}-content">
            ${renderPossessions(point.possessions)}
        </div>
    `;
    return div;
}

function togglePoint(pointNum) {
    const content = document.getElementById(`point-${pointNum}-content`);
    content.classList.toggle('expanded');
}
```

**Integration with PWA:**
- Add "View Game" button in game summary screen
- Opens viewer in new tab/window: `/games/{game_id}/view`
- Can also be accessed directly via URL

**Future Enhancements:**
- Export to PDF
- Share game via link
- Embed game viewer in iframe
- Print-friendly CSS

---

## 5. Handoff Flow with "Take Over" Button

### Design: Multi-User Game Following with Control Transfer

**Game State Tracking:**
```python
# Track who's currently controlling the game
game_controllers = {
    "game_id_123": {
        "controller_user_id": "user_abc",
        "controller_name": "Alice",
        "last_activity": "2024-01-15T10:30:00Z",
        "followers": [
            {"user_id": "user_def", "name": "Bob"},
            {"user_id": "user_ghi", "name": "Charlie"}
        ],
        "pending_takeover_requests": [
            {"user_id": "user_def", "name": "Bob", "requested_at": "2024-01-15T10:35:00Z"}
        ]
    }
}
```

**API Endpoints:**
```python
@app.get("/games/{game_id}/status")
async def get_game_status(game_id: str, current_user: User = Depends(get_current_user)):
    """Get current game status including controller info."""
    game_data = get_game_current(game_id)
    controller_info = game_controllers.get(game_id, {})
    
    is_controller = controller_info.get("controller_user_id") == current_user.id
    
    return {
        "game_id": game_id,
        "controller": {
            "user_id": controller_info.get("controller_user_id"),
            "name": controller_info.get("controller_name"),
            "last_activity": controller_info.get("last_activity")
        },
        "is_controller": is_controller,
        "followers": controller_info.get("followers", []),
        "pending_requests": [
            r for r in controller_info.get("pending_takeover_requests", [])
            if r["user_id"] != current_user.id  # Don't show own requests
        ] if is_controller else []
    }

@app.post("/games/{game_id}/follow")
async def follow_game(game_id: str, current_user: User = Depends(get_current_user)):
    """Start following a game (receive updates)."""
    if game_id not in game_controllers:
        game_controllers[game_id] = {
            "controller_user_id": current_user.id,
            "controller_name": current_user.name,
            "last_activity": datetime.now().isoformat(),
            "followers": [],
            "pending_takeover_requests": []
        }
    
    # Add to followers if not already controller
    controller_info = game_controllers[game_id]
    if controller_info["controller_user_id"] != current_user.id:
        if not any(f["user_id"] == current_user.id for f in controller_info["followers"]):
            controller_info["followers"].append({
                "user_id": current_user.id,
                "name": current_user.name
            })
    
    return {"status": "following"}

@app.post("/games/{game_id}/request-takeover")
async def request_takeover(game_id: str, current_user: User = Depends(get_current_user)):
    """Request to take control of the game."""
    if game_id not in game_controllers:
        # No controller yet, take control immediately
        game_controllers[game_id] = {
            "controller_user_id": current_user.id,
            "controller_name": current_user.name,
            "last_activity": datetime.now().isoformat(),
            "followers": [],
            "pending_takeover_requests": []
        }
        return {"status": "controller", "auto_approved": True}
    
    controller_info = game_controllers[game_id]
    
    # If already controller, return
    if controller_info["controller_user_id"] == current_user.id:
        return {"status": "already_controller"}
    
    # Add takeover request
    if not any(r["user_id"] == current_user.id 
               for r in controller_info["pending_takeover_requests"]):
        controller_info["pending_takeover_requests"].append({
            "user_id": current_user.id,
            "name": current_user.name,
            "requested_at": datetime.now().isoformat()
        })
    
    return {"status": "requested"}

@app.post("/games/{game_id}/approve-takeover/{requester_user_id}")
async def approve_takeover(
    game_id: str, 
    requester_user_id: str,
    current_user: User = Depends(get_current_user)
):
    """Approve a takeover request."""
    controller_info = game_controllers[game_id]
    
    if controller_info["controller_user_id"] != current_user.id:
        raise HTTPException(status_code=403, detail="Not the current controller")
    
    # Remove from pending requests
    controller_info["pending_takeover_requests"] = [
        r for r in controller_info["pending_takeover_requests"]
        if r["user_id"] != requester_user_id
    ]
    
    # Transfer control
    requester = next(
        (f for f in controller_info["followers"] if f["user_id"] == requester_user_id),
        None
    )
    if requester:
        controller_info["controller_user_id"] = requester_user_id
        controller_info["controller_name"] = requester["name"]
        controller_info["last_activity"] = datetime.now().isoformat()
    
    return {"status": "approved"}

@app.post("/games/{game_id}/dismiss-takeover/{requester_user_id}")
async def dismiss_takeover(
    game_id: str,
    requester_user_id: str,
    current_user: User = Depends(get_current_user)
):
    """Dismiss a takeover request."""
    controller_info = game_controllers[game_id]
    
    if controller_info["controller_user_id"] != current_user.id:
        raise HTTPException(status_code=403, detail="Not the current controller")
    
    # Remove from pending requests
    controller_info["pending_takeover_requests"] = [
        r for r in controller_info["pending_takeover_requests"]
        if r["user_id"] != requester_user_id
    ]
    
    return {"status": "dismissed"}
```

**Client-Side Implementation:**
```javascript
// data/sync.js

let currentGameController = null;
let takeoverRequestTimeout = null;

async function checkGameStatus(gameId) {
    const response = await fetch(`${API_BASE}/games/${gameId}/status`, {
        headers: {
            'Authorization': `Bearer ${getAuthToken()}`
        }
    });
    const status = await response.json();
    
    currentGameController = status.controller;
    
    // Update UI
    updateControllerUI(status);
    
    return status;
}

function updateControllerUI(status) {
    const controllerBadge = document.getElementById('controller-badge');
    if (status.is_controller) {
        controllerBadge.textContent = 'You are controlling';
        controllerBadge.className = 'badge controller';
        hideTakeoverButton();
    } else {
        controllerBadge.textContent = `${status.controller.name} is controlling`;
        controllerBadge.className = 'badge follower';
        showTakeoverButton();
        
        // Show pending requests if any
        if (status.pending_requests && status.pending_requests.length > 0) {
            showPendingRequests(status.pending_requests);
        }
    }
}

async function requestTakeover(gameId) {
    const response = await fetch(`${API_BASE}/games/${gameId}/request-takeover`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${getAuthToken()}`
        }
    });
    const result = await response.json();
    
    if (result.status === 'controller' && result.auto_approved) {
        // Immediately got control
        showNotification('You are now controlling the game');
        checkGameStatus(gameId);
    } else if (result.status === 'requested') {
        // Request sent, wait for approval
        showNotification('Takeover request sent. Waiting for approval...');
        
        // Start polling for approval
        startTakeoverPolling(gameId);
    }
}

function startTakeoverPolling(gameId) {
    // Poll every 2 seconds for status update
    const pollInterval = setInterval(async () => {
        const status = await checkGameStatus(gameId);
        if (status.is_controller) {
            clearInterval(pollInterval);
            showNotification('You are now controlling the game');
        }
    }, 2000);
    
    // Auto-timeout after 30 seconds
    setTimeout(() => {
        clearInterval(pollInterval);
        showNotification('Takeover request timed out');
    }, 30000);
}

// Periodic status check (every 5 seconds when following)
function startStatusPolling(gameId) {
    setInterval(() => {
        checkGameStatus(gameId);
    }, 5000);
}
```

**UI Components:**
```html
<!-- Controller badge -->
<div id="controller-badge" class="badge">
    You are controlling
</div>

<!-- Takeover button (shown to followers) -->
<button id="takeover-btn" class="btn btn-primary" onclick="requestTakeover()">
    Request to Take Over
</button>

<!-- Pending requests (shown to controller) -->
<div id="pending-requests" class="pending-requests">
    <h3>Takeover Requests</h3>
    <div class="request-item">
        <span>Bob wants to take over</span>
        <button onclick="approveTakeover('user_def')">Approve</button>
        <button onclick="dismissTakeover('user_def')">Dismiss</button>
        <div class="auto-approve-timer">Auto-approve in 8s</div>
    </div>
</div>
```

**Auto-Approval Timer:**
```javascript
function showPendingRequest(request) {
    const requestDiv = document.createElement('div');
    requestDiv.className = 'request-item';
    requestDiv.innerHTML = `
        <span>${request.name} wants to take over</span>
        <button onclick="approveTakeover('${request.user_id}')">Approve</button>
        <button onclick="dismissTakeover('${request.user_id}')">Dismiss</button>
        <div class="auto-approve-timer" id="timer-${request.user_id}">Auto-approve in 10s</div>
    `;
    
    // Start 10-second countdown
    let timeLeft = 10;
    const timerInterval = setInterval(() => {
        timeLeft--;
        document.getElementById(`timer-${request.user_id}`).textContent = 
            `Auto-approve in ${timeLeft}s`;
        
        if (timeLeft <= 0) {
            clearInterval(timerInterval);
            approveTakeover(request.user_id);
        }
    }, 1000);
}
```

**Future: Authentication & Permissions:**
- Game creator can invite specific users
- Invited users can view/contribute
- Public games (anyone can follow)
- Private games (invite-only)

---

## Summary

### Key Design Decisions:

1. **Versioning**: Git-based with timestamped versions
2. **Sync Strategy**: Full game sync (stateless, simple)
3. **Undo Support**: Send previous game state (full sync handles it)
4. **Game Viewer**: HTML page with unfurling points/possessions
5. **Handoff**: Multi-user following with "take over" requests

### Code Complexity Estimate:

- **Game Storage**: ~200 lines (versioning, file I/O)
- **API Endpoints**: ~300 lines (CRUD + handoff endpoints)
- **Client Sync**: ~200 lines (sync logic, polling)
- **Game Viewer**: ~500 lines (HTML/CSS/JS)
- **Total**: ~1200 lines (vs ~4500 for Google Sheets approach)

### Next Steps:

1. Implement basic JSON file storage
2. Add versioning
3. Implement full game sync
4. Build game viewer
5. Add handoff flow
6. Test with real games

