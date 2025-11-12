## New Features for Mixed Ultimate rules
Official Mixed ultimate has several rule changes specific to mixed gender play. The ratio of female-matching players (FMPs) to male-matching players (MMPs) on the field for both teams alternates between 4:3 and 3:4, in an ABBAABB pattern (first point at one ratio, then points at the alternate ratio, then two points at the first, and so on). On defense must alternate the gender of the pulling player. The next set of changes creates a new "pull" event and the UI for specifying pulls, and then adds the features to track both alternating pulls and alternating FMP/MMP ratio for mixed-gender games. 

Create a new branch for these features and proceed to implement them in the below order. 

- **Track gender of players**: Each Player object should have a gender attribute, which may be `MMP`, `FMP`, or `Unknown`. Default is Unknown. 
  - These gender attributes will be used to track compliance with optional gender alternating rules, and provide visual feedback
  - Gender should be set while creating players during roster management. Replace the + button with a +FMP and a +MMP button. TO make room you can remove the trash can icon next to the player name textentry field, and any associated code. 
- **Add pull events**: Create a new type of Event for tracking pulls, and the corresponding UI. For now we will only track pulls by the user's team, but we will design the event so that later we can add optional tracking of opponent pulls. 
  - Add a new type of Event: "Pull". A Pull event occurs at the beginning of a Point, before any Possession. Pull events are optional. 
  - Add a field to Pull to indicate who pulled (if a defensive point). Unknown Player should be an option. 
  - Add a field to Pull to indicate gender of puller: FMP, MMP, or Unknown. 
  - On defense points, add a new modal dialog titled "Pull" that appears at the start. 
    - Consider whether instead of a dialog, this should be a screen, in the sense defined by navigation.js. Make a recommendation, explain reasoning, and let me decide before proceeding. 
  - The left side of the dialog should include a column of buttons for the players on the field, using the same CSS styles as other player buttons throughout the app. Title: "Pulling". The user will select a player (only one button can be selected, if none is selected "Unknown Player" will be credited with the pull). 
  - The right side contains four buttons in a column: "Good Pull", "Okay Pull", "Poor Pull", "Brick". 
  - Below the columns are checkboxes in a row: "Flick", "Roller", "IO", "OI"
  - At the bottom of the dialog is a "Proceed" button which creates the Event and exits the dialog into either the simple mode screen or the defensive possession screen. 
- **Track alternating-gender pulls**: Each team should alternate which gender pulls. 
  - Add a boolean field to Game to indicate whether the game should follow Mixed alternate-gender pulling rules
  - If alternating gender pulls are being tracked:
    - use title "FMP Pull" or "MMP Pull" for the Pull dialog/screen. If this is the first defensive point the title should be "Pull" regardless (because FMP/MMP is not decided until the radio button is set, per the next item).
    - Underneath the title should be "Pulling: " followed on the same line by radio buttons for "FMP" and "MMP". On the first defensive point neither should be selected, and the "Proceed" button at the bottom should be disabled (and styled accordingly, using existing app styles) until the user selects either FMP or MMP. After the first point, the radio button for the opposite gender should be pre-selected, and the "Proceed" button enabled. 
    - The column of players should visually indicate which players (based on their gender attribute and the current FMP/MMP pull state) are eligible to pull. Color the non-eligible players a light warning color (perhaps orange) but don't actually disable them. If a non-eligible player is selected, the "Proceed" button turns bright warning color (perhaps orange), but may still be clicked 
- **Track FMP- vs MMP-ratio points**: In some games, the ratio of FMPs and MMPs must alternate in a ABBAABB pattern.
  - Add a boolean field to Game to indicate whether the game should follow Mixed rules for alternating gender ratio in games with an odd number of players per side (most commonly 7). 
  - On the teamRosterScreen (where new games are launched), add checkboxes for "Alternate Gender Ratio" and "Alternate Gender Pulls" on the line below the Start Game On: [Offense] [Defense] buttons.  These checkboxes set and reflect those booleans.
  - the "Start Point (Offense/Defense)" button on the BeforePointScreen is currently turned a red warning color when the wrong number of players is selected. In alternating gender games, it should turn an orange warning color in an alternating-gender game when the wrong gender ratio is selected. 
  - player names in the BeforePointScreen roster grid for lineup selection should be colored purplish for FMPs and yellowish for MMPs. Adjust colors and use boldface to improve visibility. Feel free to suggest better color pairings, but avoid pink/blue. 
  - For alternating gender games: On the BeforePointScreen under the "Select Active Players (game/total)" line, there should be a line "Gender Ratio: +{FMP,MMP} point"

## Testing Checklist

- [x] **ABBAABB pattern correctness**
  - [x] Verify pattern sequence across multiple points (0-13+)
  - [x] Test pattern resets correctly after 7 points (point 7 matches point 0)
- [x] **Non-7 player counts**
  - [x] Test behavior with 5, 6, 8+ players
  - [x] Verify ratio display/validation behavior for non-7 counts
- [x] **Pull gender alternation across multiple points**
  - [x] Verify alternation works correctly across many defensive points
  - [x] Test edge case: consecutive offensive points (no defensive pulls)
- [ ] **Unknown gender players**
  - [ ] Test handling in gender ratio calculations
  - [ ] Test handling in pull eligibility
  - [ ] Test visual styling
- [x] **Warning color distinction**
  - [x] Orange warning for wrong gender ratio (correct count)
  - [x] Red warning for wrong count
- [x] **Starting ratio selection**
  - [x] First point requires ratio selection before starting
  - [x] Changing starting ratio mid-game (if possible)
- [x] **Pull dialog edge cases**
  - [x] No players have gender set
  - [x] All players are ineligible (e.g., all FMP when MMP expected)
  - [x] Unknown Player selection behavior
- [x] **Data persistence**
  - [x] `alternateGenderRatio`, `alternateGenderPulls`, `startingGenderRatio` persist when saving/loading games
- [x] **Visual feedback consistency**
  - [x] Gender ratio text color updates correctly when switching between correct/wrong ratios
  - [x] Player button styling updates correctly when gender radio buttons change
- [x] **Integration between features**
  - [x] Games with both `alternateGenderRatio` and `alternateGenderPulls` enabled
  - [x] Games with only one feature enabled 