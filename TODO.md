# Breakside PWA Refactoring Plan

## Overview
The application currently has over 4500 lines of code in a single `main.js` file, making it difficult to maintain, test, and extend. This document outlines a strategic refactoring plan to break the monolithic architecture into modular, maintainable components.

## Goals
1. Improve code organization and maintainability
2. Prepare codebase for future enhancements (cloud sync, real-time collaboration, AI narration)
3. Make the application more testable and debuggable
4. Enable easier feature additions without affecting existing functionality

## Proposed File Structure

### Core Modules

#### 1. `data/` - Data Layer
**Purpose**: Define data structures and manage persistence

- **`models.js`** (~300 lines)
  - Data structure definitions (Player, Game, Team, Point, Possession, Event classes)
  - Constants (Role, UNKNOWN_PLAYER, etc.)
  - Global state definitions

- **`storage.js`** (~200 lines)
  - Serialization/deserialization logic (serializeTeam, deserializeTeams, serializeEvent, deserializeEvent)
  - Local storage operations (saveAllTeamsData, loadTeams)
  - Data initialization (initializeTeams, createSampleTeam)

**Future Enhancement**: This layer will be extended with cloud storage adapter for Google Sheets and real-time sync

---

#### 2. `utils/` - Utility Functions
**Purpose**: Pure utility functions and helpers

- **`helpers.js`** (~150 lines)
  - Pure utility functions (formatPlayTime, capitalize, etc.)
  - Time calculations (getPlayerGameTime)
  - Player lookups (getPlayerFromName, getPlayerGameTime)
  - Current state accessors (currentGame, getLatestPoint, getLatestPossession, getLatestEvent, getActivePossession)

- **`statistics.js`** (~200 lines)
  - Statistics calculation (calculatePlayerStatsFromEvents)
  - Game summary generation (summarizeGame)
  - Roster display calculations (populatePlayerStats, etc.)

**Future Enhancement**: AI narration will utilize these stats for real-time game commentary

---

#### 3. `screens/` - Screen Management
**Purpose**: Centralized screen navigation and state management

- **`navigation.js`** (~150 lines)
  - Screen management (showScreen function)
  - Screen constants and IDs
  - Header/layout management based on screen

---

### Feature-Specific Modules

#### 4. `teams/` - Team Management
**Purpose**: Handle team selection, roster management, and team-level operations

- **`teamSelection.js`** (~200 lines)
  - Team selection screen logic
  - Create/edit/delete teams
  - Team switching logic

- **`rosterManagement.js`** (~300 lines)
  - Roster screen functionality
  - Add/remove players
  - Player editing (names, nicknames)
  - Line creation and management
  - Display roster with statistics (updateTeamRosterDisplay, updateGameSummaryRosterDisplay)

---

#### 5. `game/` - Game Management
**Purpose**: Core game logic and game state transitions

- **`gameLogic.js`** (~250 lines)
  - Game initialization (startNewGame)
  - Score management (updateScore)
  - Game state transitions
  - Simple mode scoring (We Score, They Score handlers)

- **`pointManagement.js`** (~200 lines)
  - Point creation and initialization (startNextPoint, moveToNextPoint)
  - Point timing logic (updatePointTimer, pause/resume functionality)
  - Point summary and statistics

- **`beforePointScreen.js`** (~400 lines)
  - Before Point Screen logic
  - Active players list display (updateActivePlayersList, createActivePlayersTable)
  - Player selection and checkboxes
  - Line selection dialog (showLineSelectionDialog)
  - Next line selection mode (enterNextLineSelectionMode, exitNextLineSelectionMode)
  - Swipe gesture handling

---

#### 6. `playByPlay/` - Detailed Play Tracking
**Purpose**: Detailed play-by-play event tracking screens

- **`offenseScreen.js`** (~400 lines)
  - Offense Play-by-Play Screen
  - Player button display (displayOPlayerButtons)
  - Player selection handling (handleOPlayerButton)
  - Action buttons (Throw, Turnover, Violation)
  - Action panel display (displayOActionButtons, showActionPanel, generateSubButtons)
  - Event creation and logging

- **`defenseScreen.js`** (~350 lines)
  - Defense Play-by-Play Screen
  - Player button display (displayDPlayerButtons)
  - Player selection handling (handleDPlayerButton)
  - Defense action buttons and event creation
  - Button state management (markAllDPlayerButtonsInvalid/Valid)

- **`simpleModeScreen.js`** (~200 lines)
  - Simple Mode Screen
  - Score attribution dialog (showScoreAttributionDialog)
  - Score button handlers
  - Integration with core game logic

- **`keyPlayDialog.js`** (~500 lines)
  - Key Play Dialog (largest dialog in the app)
  - Panel creation and management (createKeyPlayPanels, createKeyPlayPanel)
  - Player selection within dialog
  - Event creation for key plays (createKeyPlayThrowEvent, createKeyPlayTurnoverEvent, createKeyPlayDefenseEvent)
  - Panel toggle and state management (handleKeyPlayHeaderToggle, updateKeyPlayPlayerButtonStates)
  - Sub-button handling for throws, turnovers, defense

---

#### 7. `ui/` - UI Update Functions
**Purpose**: DOM manipulation and display updates

- **`activePlayersDisplay.js`** (~250 lines)
  - Active players table rendering
  - Player checkbox management
  - Column sticky behavior (makeColumnsSticky)
  - Statistics display within table

- **`eventLogDisplay.js`** (~150 lines)
  - Event log management (logEvent)
  - Event log toggle display
  - Bottom panel management

- **`buttonLayout.js`** (~100 lines)
  - Button width matching (matchButtonWidths)
  - UI consistency functions

---

#### 8. `services/` - External Services Integration
**Purpose**: Handle integration with external services

- **`audioNarrationService.js`** (~200 lines)
  - Audio capture and processing (already exists as audioNarration.js)
  - Integration with speech-to-text and LLM services
  - Audio level monitoring and UI updates

**Future Enhancement**: This service will be expanded for voice-to-event transcription (see Future Enhancement section below)

---

### Main Entry Point

#### 9. `main.js` - Application Bootstrap (~300 lines)
**Purpose**: Minimal bootstrap and coordination

- Service worker registration
- Event listener setup (DOM ready, page load)
- Initial app initialization
- Import and coordinate all modules
- Global event delegation for app-level concerns

---

### Legacy/Configuration Files
- `index.html` - Main HTML (updated to reference new modules)
- `main.css` - Styles (no changes needed)
- `manifest.json` - PWA manifest (no changes needed)
- `service-worker.js` - Service worker (no changes needed initially)

---

## Migration Strategy

### Phase 1: Data Layer Extraction (Week 1)
1. Create `data/models.js` and `data/storage.js`
2. Move all data structure definitions
3. Move all serialization/deserialization logic
4. Update all references in main.js to use imported modules
5. Test thoroughly - ensure data persistence still works

### Phase 2: Utilities and Statistics (Week 1-2)
1. Create `utils/helpers.js` and `utils/statistics.js`
2. Extract pure utility functions
3. Move statistics calculation functions
4. Update references

### Phase 3: Screen and Navigation (Week 2)
1. Create `screens/navigation.js`
2. Extract screen management logic
3. Create `teams/teamSelection.js` and `teams/rosterManagement.js`
4. Extract team and roster management
5. Test screen transitions

### Phase 4: Game Core (Week 2-3)
1. Create `game/gameLogic.js`, `game/pointManagement.js`, `game/beforePointScreen.js`
2. Extract game state management
3. Extract point logic
4. Extract before point screen (largest screen module)
5. Test game flow

### Phase 5: Play-by-Play Screens (Week 3)
1. Create `playByPlay/offenseScreen.js`, `playByPlay/defenseScreen.js`, `playByPlay/simpleModeScreen.js`, `playByPlay/keyPlayDialog.js`
2. Extract screen-specific logic for each play-by-play mode
3. Extract Key Play Dialog logic
4. Test each mode independently

### Phase 6: UI Updates (Week 3-4)
1. Create `ui/` modules
2. Extract DOM manipulation functions
3. Ensure UI updates work correctly

### Phase 7: Integration and Cleanup (Week 4)
1. Create new streamlined `main.js`
2. Import all modules
3. Set up event delegation
4. Remove duplicate code
5. Comprehensive testing
6. Update documentation

---

## Future Enhancement Considerations

### Cloud Sync and Real-Time Collaboration
**Key Changes Required**:
- **Storage Abstraction**: Create a storage interface that supports both localStorage and cloud storage
- **Data Synchronization Service**: New `services/syncService.js` to handle:
  - Periodic sync with cloud database (Google Sheets or cloud DB)
  - Conflict resolution for simultaneous edits
  - Real-time updates from other clients
  - Offline queue for sync when connection restored

**Implementation Strategy**:
- Refactor `data/storage.js` to use a storage adapter pattern
- Add sync service that monitors data changes
- Implement optimistic UI updates with conflict resolution
- Add UI indicators for sync status

**Benefits of Modular Structure**:
- Easy to add new storage backend without touching game logic
- UI can be updated independently of data layer
- Clear separation between local state and synced state

### Voice-to-Event Transcription
**Purpose**: Allow users to narrate gameplay orally, converting speech to structured game events

**Key Changes Required**:
- **Audio Processing Service**: Enhance `services/audioNarrationService.js`, rewriting from scratch if necessary to use modern tooling
- **Speech-to-Text Integration**: Connect to cloud-based speech-to-text API
- **Event Recognition Module**: New module to convert transcribed text to structured events using LLM
- **Event Creation Engine**: Convert LLM output into game events

**Implementation Strategy**:
- Extend existing AudioNarrationService with real-time speech-to-text
- Stream audio to cloud service (Google Cloud Speech-to-Text, AWS Transcribe, or similar)
- Create NLP/LLM module to parse transcribed speech into structured events (e.g., "Player X throws to Player Y" → Throw event)
- Integrate with game event system to auto-populate events from narration
- Add confidence scoring and manual confirmation for uncertain events
- Allow user to review/edit auto-created events before confirmation

**Benefits of Modular Structure**:
- Audio service already separated from game logic
- Easy to swap between different STT providers
- Event parsing can be tested independently of audio capture
- Game event system remains independent of input method
- Can fall back to manual entry if transcription fails

### AI Sportswriter (Future Enhancement)
**Purpose**: Generate written game summaries and commentary after the game

**Key Changes Required**:
- **LLM Integration Service**: New `services/sportswriterService.js`
- **Summary Generation Module**: Analyze game data and generate natural language summaries
- **Output Formatting**: Style and structure of the written summary

**Implementation Strategy**:
- After game completion, feed all game events to LLM
- Generate comprehensive written summary of the game
- Include player highlights, key moments, and statistical analysis
- Allow export to various formats (text, markdown, HTML)
- Consider adding narration style options (formal, casual, color commentary)

**Note**: This feature is a secondary priority compared to real-time voice transcription

---

## Implementation Guidelines

### Module Dependencies
- Minimize dependencies between modules
- Use dependency injection where possible
- Create clear interfaces between modules
- No circular dependencies allowed

### Naming Conventions
- Files: camelCase for consistency
- Functions: camelCase (maintain existing style)
- Classes: PascalCase (maintain existing style)
- Constants: UPPER_SNAKE_CASE

### Testing Strategy
- Test each module independently during extraction
- Maintain existing functionality throughout migration
- Use browser developer tools for debugging
- Test offline functionality thoroughly

### Documentation
- Add JSDoc comments to each module file
- Document module purpose and key exports
- Document module dependencies
- Update README with new file structure

---

## Risks and Mitigation

### Risk: Breaking Existing Functionality
**Mitigation**: 
- Extract and test one module at a time
- Maintain comprehensive testing throughout
- Keep old code commented during transition
- Use version control extensively

### Risk: Circular Dependencies
**Mitigation**:
- Map dependencies before extraction
- Create clear data flow diagram
- Use event system for cross-module communication
- Keep global state minimal and centralized

### Risk: Performance Degradation
**Mitigation**:
- Profile before and after refactoring
- Maintain current bundling strategy (if any)
- Consider lazy loading for heavy modules
- Monitor network requests for cloud features

### Risk: Increased Complexity During Transition
**Mitigation**:
- Complete one phase before starting next
- Maintain working application at all times
- Create comprehensive checklist for each phase
- Regular commits to version control

---

## Success Criteria

1. All existing functionality works identically
2. Code is organized into logical, maintainable modules
3. Each module has clear responsibilities
4. No single file exceeds 500 lines
5. Future enhancements (cloud sync, AI narration) can be added without major refactoring
6. Application performance is maintained or improved
7. Code is more testable and debuggable
8. Documentation is comprehensive and up-to-date

---

## Estimated Timeline
- **Total Duration**: 4 weeks
- **Effort**: 1-2 days per week for phased approach
- **Recommendation**: Phase the work to avoid disrupting app usage

---

## Notes
- Keep backward compatibility with existing data
- Consider adding build step for module bundling in future
- May want to introduce a simple module system or use ES6 modules with build tooling
- Consider adding unit tests once modular structure is in place