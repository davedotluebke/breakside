# Lines Functionality Implementation Plan

## Overview
Add support for pre-defined player lines (groups of up to 7 players) that can be quickly selected during game play. This will help coaches manage player rotations more efficiently. The system will track the last-used line and provide confirmation when creating oversized lines.

## Data Structure Changes

### 1. Add Line Data Structure
- Add `lines` array to Team class
- Each line object will contain:
  - `name`: string (short identifier for the line)
  - `players`: array of player names
  - `createdAt`: timestamp
  - `lastUsed`: timestamp (null initially)

### 2. Add Game State Tracking
- Add `lastLineUsed` property to Game class to track which line was last used
- Update this property when a line is selected during gameplay

## UI Changes

### 2. Team Roster Screen Modifications
- Add checkboxes to player rows in roster table
- Add header checkbox in the first column to select/deselect all players
- Add new UI elements below "Add Player" section:
  - Text input field with placeholder "Add new line"
  - "Add Line" button
  - "Delete Line" button (initially disabled)
- Add line management section showing existing lines
- Add confirmation dialog for oversized lines

### 3. Before Point Screen Modifications
- Add "Lines" button next to "Edit Roster" button
- Add popup menu for line selection
- Add line selection functionality
- Highlight last-used line in the list
- Add visual indicator for oversized lines

## Implementation Steps

### Phase 1: Data Structure and Team Roster UI
1. Add `lines` array to Team class
2. Add `lastLineUsed` to Game class
3. Add checkbox column to roster table
4. Add line management UI elements
5. Implement "Add Line" functionality with size validation
6. Implement "Delete Line" functionality
7. Add line display section with last-used indicator

### Phase 2: Before Point Screen Integration
1. Add "Lines" button to Before Point screen
2. Implement line selection popup with highlighting
3. Add line application functionality
4. Update active players list when line is selected
5. Update last-used line tracking

## Testing Plan

### Unit Tests
1. Team class line management:
   - Add line with valid players
   - Add line with too many players (confirm dialog)
   - Delete existing line
   - Delete non-existent line
   - Get line by name
   - List all lines
   - Last-used line tracking
   - Line size validation

2. UI Tests:
   - Checkbox state persistence
   - Line creation validation
   - Oversized line confirmation dialog
   - Line deletion confirmation
   - Line selection in Before Point screen
   - Active player list updates
   - Last-used line highlighting
   - Oversized line visual indicators

### Integration Tests
1. Line creation and deletion flow
2. Line selection and application flow
3. Data persistence across sessions
4. Error handling and edge cases
5. Last-used line persistence
6. Oversized line handling

## Code Changes Required

### main.js
1. Team class modifications:
   ```javascript
   function Team(name = "My Team", initialRoster = []) {
     // ... existing properties ...
     this.lines = [];  // Add lines array
   }
   ```

2. Game class modifications:
   ```javascript
   function Game(teamName, opponentName, startOn) {
     // ... existing properties ...
     this.lastLineUsed = null;  // Track last used line
   }
   ```

3. Add line management methods:
   ```javascript
   Team.prototype.addLine = function(name, players) { ... }
   Team.prototype.deleteLine = function(name) { ... }
   Team.prototype.getLine = function(name) { ... }
   Team.prototype.validateLineSize = function(players) { ... }
   ```

4. Update roster display function to include checkboxes

5. Add line management UI event handlers

6. Add Before Point screen line selection functionality

7. Add last-used line tracking and display

### main.css
1. Add styles for:
   - Line management UI elements
   - Checkbox column in roster table
   - Line selection popup
   - Line display section
   - Last-used line highlight
   - Oversized line indicator

### index.html
1. Add line management UI elements to Team Roster screen
2. Add "Lines" button to Before Point screen
3. Add line selection popup structure
4. Add confirmation dialog for oversized lines

## Implementation Notes
- Keep UI consistent with existing design
- Maintain current data persistence approach
- Ensure backward compatibility with existing team data
- Follow existing error handling patterns
- Keep code modular and maintainable
- Use existing confirmation dialog patterns
- Maintain consistent visual indicators

## Success Criteria
- Users can create and delete lines from Team Roster screen
- Lines can be quickly selected during game play
- Line selection properly updates active players
- All changes persist across sessions
- UI remains responsive and intuitive
- No regression in existing functionality
- Oversized lines trigger confirmation dialog
- Last-used line is clearly indicated
- Oversized lines are visually marked 