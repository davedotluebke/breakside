# ultistats
A real-time app for entering and tracking per-player, per-play stats in ultimate frisbee. 

## Overview
Ultimate Stats Tracker is a Progressive Web App (PWA) designed to help ultimate frisbee coaches track game statistics, manage team rosters, and make informed decisions about player rotations. The app provides real-time tracking of gameplay events, player performance metrics, and team statistics across multiple games and teams.

## Core Features
- Multi-team support with team roster management
- Real-time game event tracking
- Player statistics and performance metrics
- Line management and playing time tracking
- Game summary and statistics generation
- Data persistence and export capabilities

## Data Structure
The app uses a hierarchical data model:

### Teams
- Team name and roster
- Collection of games played
- Player statistics across all games

### Games
- Team vs Opponent matchup
- Starting position (offense/defense)
- Score tracking
- Collection of points played

### Points
- Active players for the point
- Starting position
- Winner (team/opponent)
- Collection of possessions
- Timestamps for duration tracking

### Possessions
- Offensive/defensive status
- Collection of events
- Timestamps for duration tracking

### Events
- Type (Throw, Turnover, Defense, Violation, Other)
- Player references (thrower, receiver, defender)
- Event-specific flags (huck, layout, hammer, etc.)
- Timestamps

## User Interface
The app features several distinct screens:

### Team Selection Screen
- List of saved teams
- Create new team
- Load team from file
- Team switching functionality

### Team Roster Screen
- Player list with statistics
- Add/remove players
- Configure game settings
- Download team data
- Start new game options

### Before Point Screen
- Active player selection
- Player statistics display
- Point timer
- Game event controls (timeout, halftime, etc.)

### Play-by-Play Screens
#### Offense
- Player selection buttons
- Throw, turnover, and violation actions
- Event-specific sub-buttons
- Real-time event logging

#### Defense
- Player selection buttons
- Turnover and score tracking
- Event-specific sub-buttons
- Real-time event logging

### Game Summary Screen
- Final score display
- Player statistics table
- Game data export
- New game initiation

## Key Features
- Real-time event logging with undo capability
- Player statistics tracking (goals, assists, turnovers, etc.)
- Playing time tracking
- Point timer with visual indicators
- Data export in JSON format
- Responsive design for mobile use
- Persistent storage of team and game data

## Technical Implementation
- Progressive Web App (PWA) architecture
- Vanilla JavaScript implementation
- Local storage for data persistence
- Responsive CSS design
- Touch-optimized UI elements
- Service worker for offline functionality
