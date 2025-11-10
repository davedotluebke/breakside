# Breakside

A real-time Progressive Web App for tracking play-by-play statistics in ultimate frisbee games.

## Overview

Breakside is a comprehensive ultimate frisbee statistics tracker designed to help coaches and teams track detailed game metrics, manage team rosters and subbing strategies, and analyze player performance. The app provides real-time tracking of gameplay events, comprehensive player statistics, and team management features across multiple games and teams.

> **⚠️ Beta Software Notice**
> 
> Breakside is currently in beta. This software may contain bugs, and backwards/forwards compatibility is not guaranteed between versions. Please export your team data regularly as a backup.
> 
> [💬 Give Feedback](https://github.com/davedotluebke/ultistats/issues/new?labels=beta_feedback&title=Beta+Feedback%3A+&body=Please+describe+your+experience+or+issue+below%3A%0A%0A---%0A%0A**Device/Browser:**%0A**App+Version:**%0A**Steps+to+reproduce:**) - Help improve Breakside by reporting bugs or sharing feedback.

<details open>
<summary><h2>Quickstart</h2></summary>

* [Install Breakside](#installation) by navigating to the Breakside website on a phone and choosing `Add to home screen`
* Launch Breakside from the icon on the home screen
* Create a new team and give it a name
* Add a bunch of players (tap the `Add player` box and enter their name, then hit enter or tap the `+` button
* Start a game! Enter the opponent name and indicate whether your team is starting on Offense or Defense
  * Select 7 players and tap `Start Point`
  * Enter a few points! 
    * Try out the `We Score`, `They Score`, and `Key Play` buttons, changing the lineup between points
    * Notice the roster screen updates the time and points played by each player
  * Tap the `Game Log` button to see a summary of the game events you've entered
  * Tap the `Simple Mode` toggle and try out full play-by-play mode
  * Tap the `End Game` button and admire your team's statistics!
* Download a copy of the game database, copy the game log summary to the clipboard for pasting in other apps, or start a new game



<details>
<summary><h2>📋 Features</h2></summary>

### Team Management
- **Multi-team support** - Create and manage multiple teams with different rosters
- **Roster management** - Add, remove, and edit player information including nicknames
- **Team data export/import** - Download team data as JSON files for backup or sharing
- **Team switching** - Easily switch between different teams during use

### Game Tracking Modes
- **Simple Mode** - Streamlined interface for basic scoring and key play tracking
- **Detailed Play-by-Play** - Comprehensive event logging for complete game analysis
- **Key Play Dialog** - Record specific important events without switching modes

### Real-Time Statistics
- **Player Performance Metrics** - Track goals, assists, turnovers, completed passes, and defensive plays
- **Playing Time Tracking** - Monitor exact time on field for each player
- **Point-by-Point Analysis** - See which players were active in each point
- **Game vs. Season Stats** - Toggle between current game and cumulative statistics

### Advanced Game Features
- **Line Management** - Select active players for each point, or sub in entire lines
- **Next-line Selection** - Select line for the next point during the current point
- **Score Attribution** - Attribute goals and assists to specific players
- **Point Timer** - Automatic timing of points with visual indicators
- **Undo Capability** - Correct mistakes with real-time undo functionality
- **Event Logging** - Detailed logging of all throws, turnovers, defensive plays, and violations

### Data & Export
- **JSON Export** - Export complete game data for analysis
- **Local Storage** - Automatic saving of all team and game data
- **Resume Games** - Pick up where you left off with in-progress games
- **Game History** - View and manage past games for each team

### User Interface
- **Responsive Design** - Optimized for both mobile and desktop use
- **Touch-Optimized** - Large buttons and gestures designed for sideline use
- **Offline Capability** - Full functionality without internet connection
- **Dark Theme** - Easy-to-read interface in various lighting conditions

</details>

<details>
<summary><h2>📱 Installation</h2></summary>

Breakside is a Progressive Web App (PWA) hosted at [https://luebke.us/ultistats](https://luebke.us/ultistats).

### Installing on Mobile Devices

**For iOS (iPhone/iPad):**
1. Open Safari and navigate to [https://luebke.us/ultistats](https://luebke.us/ultistats)
2. Tap the Share button (square with arrow pointing up)
3. Scroll down and tap "Add to Home Screen"
4. Tap "Add" to install the app on your home screen

**For Android:**
1. Open Chrome and navigate to [https://luebke.us/ultistats](https://luebke.us/ultistats)
2. Tap the three-dot menu (⋮) in the top-right corner
3. Tap "Add to Home screen" or "Install app"
4. Tap "Install" to add the app to your device

### Installing on Desktop

**For Chrome/Edge:**
1. Navigate to [https://luebke.us/ultistats](https://luebke.us/ultistats)
2. Click the install icon in the address bar (or menu → Install Breakside)
3. Click "Install" when prompted

**For Safari:**
1. Navigate to [https://luebke.us/ultistats](https://luebke.us/ultistats)
2. Go to File → Add to Desktop (or use Develop menu → Add to Dock)

Once installed, the app will work offline and provide a native app-like experience across all platforms.

</details>

<details>
<summary><h2>🗂️ Data Structure</h2></summary>

The app uses a hierarchical data model to track comprehensive game statistics:

### Teams
- Team name and roster management
- Collection of all games played
- Aggregate player statistics across all games
- Team-specific settings and configurations

### Games
- Team vs. opponent matchup with score tracking
- Starting position (offense/defense)
- Collection of individual points played
- Game start/end timestamps

### Points
- Active players selected for the point
- Starting position (offense/defense)
- Point winner (team/opponent)
- Collection of possessions within the point
- Point duration timestamps

### Possessions
- Offensive or defensive status
- Collection of all events during the possession
- Possession duration tracking
- Automatic possession switching on turnovers

### Events
- **Throw Events** - Completed passes with flags for hucks, hammers, dumps, break marks, layouts, and scores
- **Turnover Events** - Incomplete throws, drops, stalls, and throwaways
- **Defense Events** - Blocks, interceptions, defensive plays, and Callahans
- **Violation Events** - Travels, picks, and other rule violations
- Player references (thrower, receiver, defender)
- Precise timestamps for all events

</details>

<details>
<summary><h2>⚙️ Technical Implementation</h2></summary>

### Architecture
- **Progressive Web App (PWA)** - Modern web app with native app features
- **Vanilla JavaScript** - No external frameworks for optimal performance and reliability
- **Service Worker** - Offline functionality and caching for uninterrupted use
- **Local Storage** - Persistent data storage without requiring server infrastructure

### Performance Features
- **Network-First Strategy** - Optimized loading with fallback to cached content
- **Automatic Versioning** - Built-in version tracking and updates
- **Responsive CSS** - Mobile-first design with touch-optimized interactions
- **Efficient Data Structures** - Optimized for real-time updates and statistics calculation

### Browser Support
- **Full Support** - Chrome, Safari, Firefox, Edge on desktop and mobile
- **PWA Features** - Home screen installation, offline mode, and app-like experience
- **Touch Gestures** - Swipe navigation and touch-optimized controls for mobile use

### Data Persistence
- **Automatic Saving** - All changes saved immediately to local storage
- **No Setup Required** - Works immediately without configuration or accounts
- **Data Portability** - Complete JSON export/import for data backup and sharing

### File Structure

The codebase is organized into a modular architecture for maintainability and clarity:

```
ultistats/
├── data/                    # Data layer
│   ├── models.js           # Data structure definitions (Player, Game, Team, Point, Possession, Event classes)
│   └── storage.js          # Serialization/deserialization and local storage operations
│
├── utils/                   # Utility functions
│   ├── helpers.js          # Pure utility functions and current state accessors
│   └── statistics.js       # Statistics calculation and game summary generation
│
├── screens/                 # Screen management
│   └── navigation.js       # Screen navigation and state management
│
├── teams/                   # Team management
│   ├── teamSelection.js    # Team selection screen and team CRUD operations
│   └── rosterManagement.js # Roster display, player management, and line management
│
├── game/                    # Game core logic
│   ├── gameLogic.js        # Game initialization, scoring, and undo functionality
│   ├── pointManagement.js  # Point creation, timing, and transitions
│   └── beforePointScreen.js # Before Point screen with player selection and line management
│
├── playByPlay/              # Play-by-play tracking screens
│   ├── offenseScreen.js    # Offensive possession tracking and event creation
│   ├── defenseScreen.js    # Defensive possession tracking and event creation
│   ├── simpleModeScreen.js # Simple mode scoring and score attribution
│   └── keyPlayDialog.js    # Key play dialog for recording important events
│
├── ui/                      # UI update functions
│   ├── activePlayersDisplay.js # Active players table rendering and management
│   ├── eventLogDisplay.js   # Event log management and display
│   └── buttonLayout.js      # UI consistency functions (button width matching)
│
├── main.js                  # Application bootstrap (~200 lines)
│                            # - Service worker registration
│                            # - App initialization
│                            # - Simple mode toggle coordination
│                            # - Module coordination
│
├── index.html              # Main HTML with module script tags
├── main.css                # Application styles
├── manifest.json           # PWA manifest
└── service-worker.js       # Service worker for offline functionality
```

**Module Dependencies:**
- Modules are loaded in order via `<script>` tags in `index.html`
- Data layer (`data/`) loads first, followed by utilities, then feature modules
- Global state is managed through shared variables defined in `data/storage.js`
- No circular dependencies - clear data flow from data → utils → features → UI

**Benefits of Modular Structure:**
- **Maintainability** - Each module has a single, clear responsibility
- **Testability** - Modules can be tested independently
- **Extensibility** - Easy to add new features without affecting existing code
- **Readability** - No single file exceeds 500 lines
- **Future-Ready** - Prepared for cloud sync, real-time collaboration, and AI narration features

</details>

#### License
This project is licensed under the MIT License — see the LICENSE file for details.