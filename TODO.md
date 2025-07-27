# TODO

## Key Play Functionality Implementation Plan

### Overview
Add a "Key Play" button to Simple Mode that allows coaches to record specific events (throws, turnovers, defensive plays) without switching to full play-by-play mode. This provides a middle ground between simple scoring and detailed event tracking.

### Data Structure Requirements
- No new data structures needed - reuses existing Event classes (Throw, Turnover, Defense)
- Events are appended to the current possession of the current point
- Uses existing player selection and event creation patterns

### UI Changes

#### 1. Simple Mode Screen Modifications
- Add "Key Play" button between "They Score" button and point timer
- Button styling: same blue color as "Choose Next Line" button
- Button text: "Key Play"
- Position: above the point clock container

#### 2. Key Play Modal Dialog
- Create new modal dialog similar to score attribution dialog
- Two-column layout:
  - Left column: "Plays" (action buttons)
  - Right column: "Players" (player selection buttons)
- Modal styling: reuse existing modal CSS classes
- Close button (X) in top-right corner
- Click outside to close functionality

#### 3. Left Column - Plays Section
- Header: "Plays"
- Three main action buttons:
  1. **Throw** - opens unfurling panel with sub-buttons
  2. **Turnover** - opens unfurling panel with sub-buttons  
  3. **Defense** - opens unfurling panel with sub-buttons

#### 4. Right Column - Players Section
- Header: "Players" (dynamically changes based on selected action)
  - Tap header text to toggle between two lists of players when some actions are selected 
  - When header text can be tapped to toggle, append a "switch back and forth" emoji
- Player buttons for all active players + "Unknown Player"
- Initially greyed out until action is selected
  - For some actions, "Unknown Player" is selected by default
- Dynamic header changes based on action type:
  - Throw: "Thrower" → "Receiver"
  - Turnover: "Thrower" → "Receiver" (for some types)
  - Defense: "Defender"

### Sub-Button Specifications

#### Throw Sub-Buttons (from offensive possession screen)
- huck
- breakmark  
- dump
- hammer
- sky
- layout
- score

#### Turnover Sub-Buttons (from offensive possession screen)
- throwaway
- huck
- receiverError (drop)
- goodDefense
- stall

#### Defense Sub-Buttons (from defensive possession screen)
- block
- interception
- layout
- sky
- unforced
- Callahan

### Player Selection Logic

#### Throw Action
1. Select "Throw" → header becomes "Thrower"
2. Select thrower → header becomes "Receiver", thrower greyed out
3. Select receiver → event created and dialog closes
4. Optional: tap "Thrower" header to toggle back to thrower selection

#### Turnover Action
1. Select "Turnover" → header becomes "Thrower" (for throwaway) or "Receiver" (for drop)
2. **Throwaway**: Select thrower → "Unknown Player" auto-selected as receiver → event created
3. **Drop**: "Unknown Player" auto-selected as thrower → select receiver → event created
4. Optional: tap header to toggle between thrower/receiver selection

#### Defense Action
1. Select "Defense" → header becomes "Defender"
2. Select defender → event created and dialog closes

### Implementation Steps

#### Phase 1: HTML Structure
1. Add "Key Play" button to simple mode container
2. Create Key Play modal dialog HTML structure
3. Add left column with Plays section
4. Add right column with Players section
5. Add action panels for sub-buttons (initially hidden)

#### Phase 2: CSS Styling
1. Style Key Play button to match "Choose Next Line" button
2. Style modal dialog to match score attribution dialog
3. Style action panels and sub-buttons
4. Style player buttons with proper states (active/inactive/selected)
5. Add responsive design for small screens

#### Phase 3: JavaScript Functionality
1. Add event listener for Key Play button
2. Create `showKeyPlayDialog()` function
3. Create `createKeyPlayActionButtons()` function
4. Create `createKeyPlayPlayerButtons()` function
5. Create `handleKeyPlayAction()` function
6. Create `handleKeyPlayPlayerSelection()` function
7. Create `updateKeyPlayPlayerHeader()` function
8. Create `createKeyPlayEvent()` function
9. Add modal close functionality

### Detailed Function Specifications

#### `showKeyPlayDialog()`
- Reset dialog state
- Create action buttons (Throw, Turnover, Defense)
- Create player buttons (initially inactive)
- Show modal dialog

#### `createKeyPlayActionButtons()`
- Create Throw, Turnover, Defense buttons
- Add click handlers to show sub-panels
- Style buttons consistently with existing action buttons

#### `createKeyPlayPlayerButtons()`
- Create buttons for all active players + "Unknown Player"
- Style player and unknown player buttons to match score attribution dialog
- Initially set all buttons to inactive state
- Add click handlers for player selection

#### `handleKeyPlayAction(actionType)`
- Show appropriate sub-panel
- Generate sub-buttons using existing `generateSubButtons()` function
- Update player column header
- Enable player buttons
- Store selected action type for event creation

#### `handleKeyPlayPlayerSelection(playerName, role)`
- Handle player selection based on current action type
- Update button states (selected/inactive)
- Handle multi-player selections (thrower/receiver)
- Auto-select "Unknown Player" where appropriate
- Create event when selection is complete

#### `updateKeyPlayPlayerHeader(headerText)`
- Update the right column header text
- Handle header click for toggling between roles

#### `createKeyPlayEvent(actionType, players, flags)`
- Create appropriate Event object (Throw, Turnover, Defense)
- Add event to current possession
- Log event to event log
- Close dialog
- Update game state as needed

### Event Creation Logic

#### Throw Events
```javascript
new Throw({
    thrower: selectedThrower,
    receiver: selectedReceiver,
    huck: huck_flag,
    breakmark: breakmark_flag,
    dump: dump_flag,
    hammer: hammer_flag,
    sky: sky_flag,
    layout: layout_flag,
    score: score_flag
})
```

#### Turnover Events
```javascript
new Turnover({
    thrower: selectedThrower || getPlayerFromName("Unknown Player"),
    receiver: selectedReceiver || getPlayerFromName("Unknown Player"),
    throwaway: throwaway_flag,
    huck: huck_flag,
    receiverError: receiverError_flag,
    goodDefense: goodDefense_flag,
    stall: stall_flag
})
```

#### Defense Events
```javascript
new Defense({
    defender: selectedDefender || null,
    interception: interception_flag,
    layout: layout_flag,
    sky: sky_flag,
    Callahan: Callahan_flag
})
```

### CSS Classes Required

#### New Classes
- `.key-play-btn` - Key Play button styling
- `.key-play-modal` - Modal dialog container
- `.key-play-container` - Two-column layout container
- `.key-play-column` - Individual column styling
- `.key-play-header` - Column header styling
- `.key-play-action-btn` - Action button styling
- `.key-play-player-btn` - Player button styling
- `.key-play-sub-panel` - Sub-button panel styling

#### Reused Classes
- `.modal` - Modal overlay
- `.modal-content` - Modal content container
- `.close` - Close button
- `.player-button` - Player button base styling
- `.sub-action-btn` - Sub-button styling
- `.action-panel` - Action panel styling

### Error Handling
1. Validate current point exists before showing dialog
2. Handle cases where no active players are available
3. Validate event creation parameters
4. Handle modal close without event creation
5. Ensure proper cleanup of event listeners

### Testing Plan

#### Unit Tests
1. Key Play button visibility and styling
2. Modal dialog display and close functionality
3. Action button creation and sub-panel display
4. Player button creation and state management
5. Event creation for each action type
6. Player selection logic for multi-player events
7. Header toggle functionality
8. Auto-selection of "Unknown Player"

#### Integration Tests
1. Complete Key Play workflow for each action type
2. Event logging and persistence
3. Integration with existing game state
4. Modal close and cleanup
5. Responsive design on different screen sizes

### Success Criteria
- Key Play button appears in correct position with proper styling
- Modal dialog opens and closes properly
- All action types (Throw, Turnover, Defense) work correctly
- All sub-buttons function as expected
- Player selection works for single and multi-player events
- Events are properly created and added to game state
- No regression in existing Simple Mode functionality
- UI remains responsive and intuitive
- Code follows existing patterns and conventions

### Implementation Notes
- Reuse existing Event classes and creation patterns
- Follow existing modal dialog patterns
- Maintain consistent styling with existing UI
- Use existing sub-button generation logic
- Ensure proper event logging and state management
- Keep code modular and maintainable
- Follow existing error handling patterns 

## Appendix: prompt used to create this plan
Plan this next part carefully. Take the below description of new functionality, create a detailed plan for implementation, and document it in TODO.md. Do not produce any code yet, but analyze the requested functionality and figure out all code that needs to be written. The below includes references to sub-buttons from the offensive and defensive possession screens, but does not spell out each and every sub-button; however your design document should thoroughly document every piece of functionality including all buttons and sub-buttons. 

Keep it simple. Ask questions where the request is unclear. Re-use existing code where practical (especially HTML and CSS) but re-implement functionality where re-use would be awkward. Don't change any code, and don't attempt to write new code beyond giving interfaces, specifying functions to be written, etc. Remember, you are creating a detailed plan and documenting it in TODO.md. 

New functionality request follows: I want to add a new button to "simple mode", under the "We Score" and "They Score" buttons and above the timer box. The button should be titled "Key Play" and should be the same color (blue currently) as the "Choose Next Line" button. 

This button will bring up a "Key Play" modal dialog styled similar to  the dialog for marking assists and goals "We Score". Like that dialog, this Key Play dialog will have two columns. In the left column, labeled "Plays" at the top, will be three buttons labeled "Throw", "Turnover", and "Defense". These open the same unfurling panels and sub-buttons as the "Throw" and "Turnover" buttons on the "Offensive Possession" screen. The "Defense" button opens the same unfurling panel and sub-buttons as the "They Turnover" button on the "Defensive Possession" screen. 

In the right column, labled "Players", will be a set of buttons for the active players (including "Unknown Player"), replicating the list in the "We Score" dialog. All player buttons will be greyed out until a sub-button from "Throw", "Turnover", or "Defense" is selected. 

Some functions require selecting multiple players. For example, when a "Throw" sub-button is selected, the column of Players will be re-titled "Thrower", and the user can select the player that threw the pass, upon which the column will be re-titled "Receiver" and again the user can select which player received the pass. Tapping the column header "Thrower" or "Receiver" will toggle which column is shown; if a player is selected as a thrower they will be greyed out as a receiver and vice-versa. This functionality mirrors the "We Score" dialog, but one column of player buttons serving the function of selecting both thrower and receiver. 

Similarly, when the "Throwaway" sub-button of the "Turnover" panel is selected on the left, the player column will be retitled "Thrower" and the user can select the player that threw it away. As before the column can optionally be toggled to select a receiver, but by default "Unknown Player" will be selected for receiver of a throwaway. The "Drop" sub-button of "Turnover" will bring up the "Receiver" column by default, with the "Thrower" column optionally available but "Unknown Player" selected by default. 

The player button and throw/turnover/defense sub-button presses will produce events appended to the current possession of the current point, just as they do in non-Simple Mode. No new data structures need to be created or tracked - we are just adding an optional way to make Simple Mode less simple so coaches can include key events (without tracking EVERY event like non-Simple Mode). 