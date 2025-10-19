# Breakside

A real-time Progressive Web App for tracking per-player, per-play statistics in ultimate frisbee games.

## Overview

Breakside is a comprehensive ultimate frisbee statistics tracker designed to help coaches and teams track detailed game metrics, manage team rosters, and analyze player performance. The app provides real-time tracking of gameplay events, comprehensive player statistics, and team management features across multiple games and teams.

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

</details>