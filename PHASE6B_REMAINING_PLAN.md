# Phase 6b Remaining Work - Implementation Plan

This document details the remaining work for Phase 6b of the Breakside panel-based UI redesign.

**Status**: In Progress  
**Created**: 2026-01-20
**Last Updated**: 2026-01-20

---

## Overview

Six items remain to complete Phase 6b:

| # | Feature | Complexity | Files Affected |
|---|---------|------------|----------------|
| 1 | Sub Players modal for mid-point injury subs | Medium | `game/gameScreen.js`, `main.css` |
| 2 | Pull dialog auto-popup (Active Coach only) | Low | `game/pointManagement.js` |
| 3 | Conflict warning toast | Medium | `game/gameScreen.js`, `game/controllerState.js` |
| 4 | Compact layout for minimized Select Line panel | Low | `game/gameScreen.js`, `main.css` |
| 5 | New games start with panel UI | Low | `game/gameLogic.js`, `game/pointManagement.js` |
| 6 | Final cleanup | Low | Various |

---

## 1. Sub Players Modal for Mid-Point Injury Subs

### Purpose
Allow the Active Coach to substitute players during a point (e.g., for injuries). This is separate from the "next line" preparation done by the Line Coach.

### User Flow
1. Active Coach taps "Sub" button in Play-by-Play panel during a point
2. Modal opens showing current roster with checkboxes
3. Checkboxes reflect **current point lineup** (`currentPoint.players`), NOT the prepared next line
4. Coach unchecks outgoing player, checks incoming player
5. Coach taps "Confirm" to apply substitution
6. Modal closes, event is logged, `currentPoint.players` is updated

### Implementation Details

#### A. Create Modal HTML Structure (in `gameScreen.js`)

```javascript
function createSubPlayersModal() {
    const modal = document.createElement('div');
    modal.id = 'subPlayersModal';
    modal.className = 'modal sub-players-modal';
    
    modal.innerHTML = `
        <div class="modal-content sub-players-modal-content">
            <div class="dialog-header prominent-dialog-header">
                <h2>Substitute Players</h2>
                <span class="close" id="subPlayersModalClose">&times;</span>
            </div>
            <div class="sub-players-info">
                <span id="subPlayersCount">7 selected</span>
            </div>
            <div class="sub-players-table-container" id="subPlayersTableContainer">
                <table class="panel-player-table" id="subPlayersTable">
                    <tbody>
                        <!-- Player rows populated dynamically -->
                    </tbody>
                </table>
            </div>
            <div class="sub-players-buttons">
                <button id="subPlayersCancelBtn" class="ge-btn">Cancel</button>
                <button id="subPlayersConfirmBtn" class="ge-btn ge-btn-confirm">Confirm</button>
            </div>
        </div>
    `;
    
    return modal;
}
```

#### B. Populate Player Table

```javascript
function populateSubPlayersTable() {
    const tableBody = document.querySelector('#subPlayersTable tbody');
    tableBody.innerHTML = '';
    
    if (!currentTeam || !currentTeam.teamRoster || !currentPoint) return;
    
    // Get current point players
    const currentPlayers = currentPoint.players || [];
    
    // Sort roster: current players first, then alphabetical
    const sortedRoster = [...currentTeam.teamRoster].sort((a, b) => {
        const aInPoint = currentPlayers.includes(a.name);
        const bInPoint = currentPlayers.includes(b.name);
        if (aInPoint && !bInPoint) return -1;
        if (!aInPoint && bInPoint) return 1;
        return a.name.localeCompare(b.name);
    });
    
    sortedRoster.forEach(player => {
        const row = document.createElement('tr');
        
        // Checkbox
        const checkboxCell = document.createElement('td');
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = currentPlayers.includes(player.name);
        checkbox.dataset.playerName = player.name;
        checkbox.addEventListener('change', updateSubPlayersCount);
        checkboxCell.appendChild(checkbox);
        row.appendChild(checkboxCell);
        
        // Name with gender color
        const nameCell = document.createElement('td');
        nameCell.textContent = formatPlayerName(player);
        if (player.gender === Gender.FMP) nameCell.classList.add('player-fmp');
        else if (player.gender === Gender.MMP) nameCell.classList.add('player-mmp');
        nameCell.style.cursor = 'pointer';
        nameCell.addEventListener('click', () => checkbox.click());
        row.appendChild(nameCell);
        
        tableBody.appendChild(row);
    });
    
    updateSubPlayersCount();
}
```

#### C. Handle Substitution Confirmation

```javascript
function confirmSubstitution() {
    if (!currentPoint) return;
    
    const checkboxes = document.querySelectorAll('#subPlayersTable input[type="checkbox"]');
    const newPlayers = [];
    
    checkboxes.forEach(cb => {
        if (cb.checked) {
            newPlayers.push(cb.dataset.playerName);
        }
    });
    
    // Determine who came in and who went out
    const previousPlayers = currentPoint.players || [];
    const playersOut = previousPlayers.filter(p => !newPlayers.includes(p));
    const playersIn = newPlayers.filter(p => !previousPlayers.includes(p));
    
    // Update current point players
    currentPoint.players = newPlayers;
    
    // Log substitution event(s)
    playersOut.forEach((outPlayer, index) => {
        const inPlayer = playersIn[index] || 'Unknown';
        const subEvent = new Other({
            description: `Substitution: ${inPlayer} in for ${outPlayer}`
        });
        
        // Add to current possession
        const currentPossession = currentPoint.possessions.length > 0
            ? currentPoint.possessions[currentPoint.possessions.length - 1]
            : null;
        if (currentPossession) {
            currentPossession.events.push(subEvent);
        }
        
        logEvent(subEvent.summarize());
    });
    
    // Save and update UI
    saveAllTeamsData();
    hideSubPlayersModal();
    updateGameLogEvents();
    
    // Show confirmation
    showControllerToast(`Substitution: ${playersIn.join(', ')} in`, 'success');
}
```

#### D. Points-Played Counting

**Important**: Both the outgoing and incoming players should have this point counted as "played". The current system counts points based on `point.players` at point end. Since we're updating `currentPoint.players` mid-point, the outgoing player would lose credit.

**Solution**: Track substituted-out players separately:

```javascript
// In currentPoint, add tracking for substituted players
if (!currentPoint.substitutedOutPlayers) {
    currentPoint.substitutedOutPlayers = [];
}
playersOut.forEach(p => {
    if (!currentPoint.substitutedOutPlayers.includes(p)) {
        currentPoint.substitutedOutPlayers.push(p);
    }
});
```

Then, wherever points-played is calculated (in `activePlayersDisplay.js` and `gameScreen.js`), include `substitutedOutPlayers`:

```javascript
// When checking if player played a point:
const playedPoint = point.players.includes(player.name) || 
                   (point.substitutedOutPlayers && point.substitutedOutPlayers.includes(player.name));
```

#### E. Wire Up Button Handler

Update `handlePbpSubPlayers()` in `gameScreen.js`:

```javascript
function handlePbpSubPlayers() {
    if (!canEditPlayByPlayPanel()) {
        showControllerToast('You need Play-by-Play control to sub players', 'warning');
        return;
    }
    
    // Check if point is in progress
    if (!isPointInProgress()) {
        showControllerToast('No point in progress - use Select Next Line instead', 'info');
        return;
    }
    
    showSubPlayersModal();
}
```

#### F. CSS Styling

Add to `main.css`:

```css
.sub-players-modal-content {
    max-width: 400px;
    max-height: 80vh;
}

.sub-players-table-container {
    max-height: 50vh;
    overflow-y: auto;
}

.sub-players-info {
    padding: 8px 16px;
    font-size: 14px;
    color: #666;
}

.sub-players-buttons {
    display: flex;
    gap: 12px;
    padding: 16px;
    justify-content: flex-end;
}

.ge-btn-confirm {
    background-color: #4CAF50;
    color: white;
}
```

---

## 2. Pull Dialog Auto-Popup (Active Coach Only)

### Purpose
Ensure only the Active Coach sees the Pull dialog when starting a defensive point. Other users should not be able to start points at all.

### Current Behavior
In `game/pointManagement.js`, `startNextPoint()` calls `showPullDialog()` for defense points regardless of role.

### Implementation

#### A. Add Role Check Before Starting Point

In `startNextPoint()` (around line 50-100 in `pointManagement.js`):

```javascript
function startNextPoint() {
    // Check if user has permission to start a point
    // Only Active Coach (or someone holding both roles) can start points
    if (typeof canEditPlayByPlay === 'function' && !canEditPlayByPlay()) {
        console.warn('User does not have Active Coach role - cannot start point');
        alert('Only the Active Coach can start a new point.');
        return;
    }
    
    // ... existing code continues ...
}
```

#### B. Ensure Pull Dialog Only Shows for Active Coach

The check above handles this - if the user can't start a point, they never reach the code that shows the Pull dialog.

#### C. Update Panel UI Start Point Handler

In `handlePanelStartPoint()` in `gameScreen.js`, the existing role check should already prevent non-Active-Coach users from starting. Verify and add explicit check:

```javascript
function handlePanelStartPoint() {
    // Existing check is good, but make it more explicit
    if (!canEditPlayByPlayPanel()) {
        showControllerToast('Only the Active Coach can start a new point', 'warning');
        return;
    }
    
    // ... rest of existing code ...
}
```

---

## 3. Conflict Warning Toast

### Purpose
Warn both coaches when they're editing the same line (O, D, or O/D) within 5 seconds of each other. This helps prevent confusion from overwriting each other's work.

### Conditions
- Only check when point is NOT in progress (both coaches can edit between points)
- Only warn if editing the SAME line type (O, D, or O/D)
- 5-second window for "recent" edits
- Maximum one toast per point to avoid spam

### Implementation

#### A. Track Last Remote Modification

Add state tracking in `gameScreen.js`:

```javascript
// Track conflict detection state
let lastConflictToastPointIndex = -1;  // Prevent multiple toasts per point
let lastKnownRemoteModification = {
    oLineModifiedAt: null,
    dLineModifiedAt: null,
    odLineModifiedAt: null,
    modifiedBy: null  // userId of last modifier
};
```

#### B. Check for Conflicts on Local Edit

When the user changes a checkbox in the Select Line panel:

```javascript
function checkForLineEditConflict() {
    const game = currentGame();
    if (!game || !game.pendingNextLine) return;
    
    // Only check between points
    if (isPointInProgress()) return;
    
    // Check if we already showed a toast for this point
    const currentPointIndex = game.points.length;
    if (lastConflictToastPointIndex === currentPointIndex) return;
    
    const activeType = game.pendingNextLine.activeType || 'od';
    const myUserId = getCurrentUserId();
    
    // Get the modification timestamp for the current line type
    const modTimestampKey = activeType + 'LineModifiedAt';
    const remoteModTimestamp = game.pendingNextLine[modTimestampKey];
    
    if (!remoteModTimestamp) return;
    
    const remoteTime = new Date(remoteModTimestamp).getTime();
    const now = Date.now();
    const fiveSecondsAgo = now - 5000;
    
    // Check if modified within last 5 seconds by someone else
    // We need to track who made the modification - this requires sync info
    // For now, compare against our last known edit time
    if (remoteTime > fiveSecondsAgo) {
        // Get the other coach's name from controller state
        const state = getControllerState();
        let otherCoachName = null;
        
        if (state.isActiveCoach && state.lineCoach) {
            otherCoachName = state.lineCoach.displayName;
        } else if (state.isLineCoach && state.activeCoach) {
            otherCoachName = state.activeCoach.displayName;
        }
        
        if (otherCoachName) {
            showControllerToast(`Warning: ${otherCoachName} also modifying this line`, 'warning');
            lastConflictToastPointIndex = currentPointIndex;
        }
    }
}
```

#### C. Hook Into Checkbox Change Handler

Update `handlePanelCheckboxChange()`:

```javascript
function handlePanelCheckboxChange(e) {
    // ... existing permission check ...
    
    // Check for conflicts with other coach
    checkForLineEditConflict();
    
    // ... rest of existing code ...
}
```

#### D. Reset Conflict Tracking on Point End

In `transitionToBetweenPoints()`:

```javascript
function transitionToBetweenPoints() {
    // Reset conflict tracking for new between-points phase
    lastConflictToastPointIndex = -1;
    
    // ... existing code ...
}
```

#### E. Enhanced Tracking via Sync

For more accurate conflict detection, we need to know WHO made the last edit. This requires server-side tracking. A simpler approach for now:

- Track locally when WE last edited each line type
- Compare remote timestamp to our local timestamp
- If remote is newer than our local, someone else edited

```javascript
let localLineEditTimestamps = {
    oLine: 0,
    dLine: 0,
    odLine: 0
};

// In savePanelSelectionsToPendingNextLine():
function savePanelSelectionsToPendingNextLine(updateTimestamp = true) {
    // ... existing code ...
    
    if (updateTimestamp) {
        localLineEditTimestamps[activeType + 'Line'] = Date.now();
    }
}

// In checkForLineEditConflict():
function checkForLineEditConflict() {
    // ... setup code ...
    
    const localEditTime = localLineEditTimestamps[activeType + 'Line'] || 0;
    
    // If remote timestamp is newer than our last edit AND within 5 seconds,
    // someone else edited after us
    if (remoteTime > localEditTime && remoteTime > fiveSecondsAgo) {
        // Show warning...
    }
}
```

---

## 4. Compact Layout for Minimized Select Line Panel

### Purpose
When the Select Next Line panel is minimized, show the selected player names in the title bar subtitle area.

### Design
- Comma-separated player names
- Truncate individual names with ellipsis ("...") to fit on one line
- Example: "Al..., Bob, Cy..., Da..., Ev..."

### Implementation

#### A. Create Compact Name Display Function

```javascript
/**
 * Generate compact player names string for panel subtitle
 * Truncates individual names to fit within available width
 * @param {string[]} playerNames - Array of player names
 * @param {number} maxWidth - Maximum width in pixels (approximate)
 * @returns {string} Formatted string like "Al..., Bob, Cy..."
 */
function getCompactPlayerNames(playerNames, maxWidth = 200) {
    if (!playerNames || playerNames.length === 0) return 'No players selected';
    
    // Start with full names, progressively truncate if needed
    const CHAR_WIDTH = 7; // Approximate pixels per character
    const SEPARATOR = ', ';
    const ELLIPSIS = '...';
    
    // Try full names first
    let result = playerNames.join(SEPARATOR);
    if (result.length * CHAR_WIDTH <= maxWidth) {
        return result;
    }
    
    // Calculate target length per name
    const separatorOverhead = (playerNames.length - 1) * SEPARATOR.length;
    const availableChars = Math.floor(maxWidth / CHAR_WIDTH) - separatorOverhead;
    const charsPerName = Math.max(3, Math.floor(availableChars / playerNames.length));
    
    // Truncate names
    const truncatedNames = playerNames.map(name => {
        if (name.length <= charsPerName) return name;
        return name.substring(0, charsPerName - ELLIPSIS.length) + ELLIPSIS;
    });
    
    return truncatedNames.join(SEPARATOR);
}
```

#### B. Update Panel Subtitle on Selection Change

Add function to update subtitle:

```javascript
function updateSelectLinePanelSubtitle() {
    const game = currentGame();
    const selectedPlayers = getSelectedPlayersFromPanel();
    
    // Get short names (first name or nickname)
    const shortNames = selectedPlayers.map(name => {
        // Use first word of name, or first 6 chars
        const parts = name.split(' ');
        return parts[0].length <= 8 ? parts[0] : parts[0].substring(0, 6);
    });
    
    const compactText = getCompactPlayerNames(shortNames, 250);
    
    if (typeof setPanelSubtitle === 'function') {
        setPanelSubtitle('selectLine', compactText);
    }
}
```

#### C. Call on State Changes

Update these functions to call `updateSelectLinePanelSubtitle()`:

1. `handlePanelCheckboxChange()` - after selection changes
2. `updateSelectLineTable()` - after table is populated
3. `updateSelectLinePanelState()` - after state updates

```javascript
// In handlePanelCheckboxChange():
function handlePanelCheckboxChange(e) {
    // ... existing code ...
    
    // Update compact subtitle
    updateSelectLinePanelSubtitle();
}

// In updateSelectLineTable():
function updateSelectLineTable() {
    // ... existing code at end ...
    
    // Update subtitle after table is populated
    updateSelectLinePanelSubtitle();
}
```

#### D. CSS for Subtitle

The subtitle element already exists in `panelSystem.js`. Ensure proper styling in `panelSystem.css`:

```css
.panel-subtitle {
    font-size: 12px;
    color: #888;
    margin-left: 8px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 60%;
}

/* Only show subtitle when panel is minimized */
.game-panel:not(.expanding) .panel-subtitle {
    display: inline;
}

.game-panel.expanding .panel-subtitle {
    display: none;
}
```

---

## 5. New Games Start with Panel UI

### Purpose
When a user creates a new game and starts their first point, they should land on the panel-based game screen, not the legacy `beforePointScreen`.

### Current Flow
1. User taps "Start New Game" → `startNewGame()` in `gameLogic.js`
2. Navigates to `beforePointScreen`
3. User selects players, taps "Start Point" → `startNextPoint()` in `pointManagement.js`
4. For Simple Mode + panel UI: `enterGameScreen()` is called

### Required Changes

#### A. Update Game Creation Flow

In `gameLogic.js`, update `startNewGame()` to use panel UI:

```javascript
function startNewGame() {
    // ... existing game creation code ...
    
    // Navigate to panel-based game screen instead of legacy screen
    if (typeof enterGameScreen === 'function') {
        enterGameScreen();
    } else {
        // Fallback to legacy
        showScreen('beforePointScreen');
    }
}
```

#### B. Ensure Panel UI Handles "No Point Started" State

The Select Next Line panel should work correctly when no point has been started yet. Verify:

1. `updateSelectLinePanel()` handles empty `game.points` array
2. Start Point button shows "Start Point (Offense)" or "(Defense)" correctly
3. Player table populates from last game's roster if available

#### C. Initialize `pendingNextLine` on Game Creation

In `startNewGame()` or when the game screen opens, ensure `pendingNextLine` is initialized:

```javascript
// In startNewGame() or enterGameScreen():
const game = currentGame();
if (game && !game.pendingNextLine) {
    game.pendingNextLine = {
        activeType: 'od',
        odLine: [],
        oLine: [],
        dLine: [],
        odLineModifiedAt: null,
        oLineModifiedAt: null,
        dLineModifiedAt: null
    };
}
```

#### D. Update Navigation After Game Summary

When returning from game summary to start a new game, ensure panel UI is used:

```javascript
// In gameSummaryScreen.js or wherever "New Game" button exists
document.getElementById('newGameFromSummaryBtn').addEventListener('click', function() {
    startNewGame();
    // startNewGame() now handles navigation to panel UI
});
```

---

## 6. Final Cleanup

### A. Remove Unused Stub Code

In `panelSystem.js`, the `createPanelStub()` function is no longer needed for the main panels. Options:
- Leave it for potential future use (other panels)
- Remove the `legacyScreen` parameter handling since we don't need fallback buttons

### B. Remove "Use Old Screen" Button References

Search for and remove any remaining references to legacy screen fallback buttons.

### C. Clean Up Console Logs

Review and remove excessive `console.log()` statements used during development. Keep error logs and important state change logs.

### D. Update Models for Substitution Tracking

In `store/models.js`, add `substitutedOutPlayers` to Point class:

```javascript
class Point {
    constructor() {
        // ... existing properties ...
        this.substitutedOutPlayers = []; // Players who were substituted out mid-point
    }
}
```

Update serialization in `store/storage.js` and `store/sync.js` to include this field.

### E. Verify Offline Behavior

Test that all new features degrade gracefully when offline:
- Sub Players modal should still work (local state)
- Conflict detection should not error (just skip if no state)
- Panel UI should work without controller state

### F. Version Bump (After Testing)

After testing and debugging, update `version.json`:
- Increment minor version: `1.9.0` → `1.10.0`
- Reset or increment build number as appropriate

---

## Testing Checklist

### Sub Players Modal
- [ ] Modal opens from Sub button during point
- [ ] Modal shows current point players as checked
- [ ] Unchecking/checking players updates count display
- [ ] Confirm button applies substitution
- [ ] Event logged with correct player names
- [ ] Points-played count includes both in and out players
- [ ] Modal shows warning if used between points

### Pull Dialog
- [ ] Active Coach sees Pull dialog on defense point start
- [ ] Line Coach cannot start points (gets alert)
- [ ] Coach without role cannot start points (gets alert)
- [ ] Pull dialog works correctly in panel UI

### Conflict Warning
- [ ] Toast shows when both coaches edit same line within 5 seconds
- [ ] Toast does NOT show when editing different line types
- [ ] Toast shows maximum once per point
- [ ] Toast shows other coach's name
- [ ] Works correctly with O, D, and O/D lines

### Compact Layout ✅
- [x] Subtitle shows player names when panel minimized
- [x] Names truncate with ellipsis when too long
- [x] Subtitle updates when selections change
- [x] Subtitle hidden when panel expanded

### Panel UI Entry
- [ ] New game goes directly to panel UI
- [ ] First point can be started from panel UI
- [ ] pendingNextLine initialized correctly
- [ ] Player table populates on first game

---

## File Summary

### Files to Modify

| File | Changes |
|------|---------|
| `game/gameScreen.js` | Sub Players modal, conflict detection, compact subtitle |
| `game/pointManagement.js` | Role check for starting points |
| `game/gameLogic.js` | Panel UI entry for new games |
| `store/models.js` | Add `substitutedOutPlayers` to Point |
| `store/storage.js` | Serialize `substitutedOutPlayers` |
| `store/sync.js` | Sync `substitutedOutPlayers` |
| `ui/activePlayersDisplay.js` | Include substituted players in points count |
| `ui/panelSystem.css` | Subtitle styling |
| `main.css` | Sub Players modal styling |

### Files to Review (No Changes Expected)
- `playByPlay/pullDialog.js` - Verify no changes needed
- `game/controllerState.js` - May need helper for other coach name

---

## Implementation Order

Recommended order for implementation:

1. **Compact Layout** (simplest, no new logic) ✅ COMPLETE
2. **Panel UI Entry for New Games** (enables testing other features)
3. **Pull Dialog Role Check** (simple guard clause)
4. **Conflict Warning Toast** (medium complexity)
5. **Sub Players Modal** (most complex, depends on testing other features)
6. **Final Cleanup & Testing**

Each section can be implemented independently and tested before moving to the next.
