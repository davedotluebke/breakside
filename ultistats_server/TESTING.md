# Testing the Ultistats REST API

## Prerequisites

1. Server running: `DEBUG=True uvicorn ultistats_server.main:app --reload`
2. Authentication token (register/login first)

## Quick Test Guide

### 1. Register a User

```bash
curl -X POST "http://localhost:8000/auth/register" \
  -H "Content-Type: application/json" \
  -d '{
    "username": "testuser",
    "password": "testpass123",
    "email": "test@example.com",
    "full_name": "Test User"
  }'
```

### 2. Login and Get Token

```bash
curl -X POST "http://localhost:8000/auth/login" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "username=testuser&password=testpass123"
```

Save the `access_token` from the response.

### 3. Set Token Variable

```bash
export TOKEN="your_access_token_here"
```

### 4. Test Teams Endpoints

```bash
# List all teams
curl -X GET "http://localhost:8000/teams" \
  -H "Authorization: Bearer $TOKEN"

# Create a team
curl -X POST "http://localhost:8000/teams" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "team_name": "Test Team"
  }'
```

Save the `team_id` from the response.

### 5. Test Players Endpoints

```bash
# Add a player (replace {team_id})
curl -X POST "http://localhost:8000/teams/{team_id}/players" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Alice",
    "nickname": "Ali",
    "gender": "FMP",
    "number": "1"
  }'

# Get team roster
curl -X GET "http://localhost:8000/teams/{team_id}/players" \
  -H "Authorization: Bearer $TOKEN"
```

### 6. Test Games Endpoints

```bash
# Create a game (replace {team_id})
curl -X POST "http://localhost:8000/games" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "team_id": "{team_id}",
    "team_name": "Test Team",
    "opponent_name": "Opponent Team",
    "starting_position": "offense"
  }'
```

Save the `game_id` and `sheet_name` from the response.

### 7. Test Event Endpoints

```bash
# Append a single event (replace {game_id})
# Event row format: 26 columns matching the schema
curl -X POST "http://localhost:8000/games/{game_id}/events" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "row": ["1", "2024-01-15T10:00:00", "Offense", "Alice,Bob,Charlie", "", "", "", "", "", "Alice", "Bob", "huck", "", "", "", "", "", "", "", "", "", "", "", "", "1", "offensive"]
  }'

# Batch append multiple events
curl -X POST "http://localhost:8000/games/{game_id}/events/batch" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "rows": [
      ["1", "", "", "", "", "", "", "", "", "Alice", "Bob", "huck", "", "", "", "", "", "", "", "", "", "", "", "", "1", "offensive"],
      ["1", "", "", "", "", "", "", "", "", "Bob", "Charlie", "break", "", "", "", "", "", "", "", "", "", "", "", "", "1", "offensive"]
    ]
  }'
```

### 8. Test Full Game Sync

```bash
# Get current game data
curl -X GET "http://localhost:8000/games/{game_id}/data" \
  -H "Authorization: Bearer $TOKEN"

# Full game sync (upload complete game state)
curl -X POST "http://localhost:8000/games/{game_id}/sync" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "rows": [
      ["Game: Test Team vs Opponent Team", "Date: 2024-01-15", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", ""],
      ["Point #", "Point Start Time", "Starting Position", "Active Players", "Point End Time", "Point Duration", "Point Winner", "Score After Point", "Pull", "Thrower", "Receiver", "Throw Modifiers", "Defender", "Defense Modifiers", "Turnover Type", "Turnover Player", "Turnover Modifiers", "Violation Type", "Violation Player", "Timeout", "Injury Sub", "Time Cap", "Side Switch", "Halftime", "Possession #", "Possession Type"],
      ["1", "2024-01-15T10:00:00", "Offense", "Alice,Bob,Charlie", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", ""]
    ]
  }'
```

### 9. Test Game Endpoints

```bash
# Get game metadata
curl -X GET "http://localhost:8000/games/{game_id}" \
  -H "Authorization: Bearer $TOKEN"

# End a game
curl -X POST "http://localhost:8000/games/{game_id}/end" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "game_end_timestamp": "2024-01-15T12:00:00",
    "final_score_team": 15,
    "final_score_opponent": 10
  }'
```

## Testing with Real Game Data

You can use the serialization module to generate proper row data:

```python
from ultistats_server.sheets.serialization import serialize_game_to_sheet_rows
from test_real_game import load_team_data, convert_game_for_serialization

# Load real game
teams_data = load_team_data('~/Downloads/teamData.TeamDvTeamE.json')
game = teams_data[0]['games'][0]
converted_game = convert_game_for_serialization(game)
rows = serialize_game_to_sheet_rows(converted_game)

# Use rows in sync endpoint
```

## Expected Response Formats

### Success Responses
- `200 OK` - Successful GET/PUT requests
- `201 Created` - Successful POST requests (some endpoints)
- Response body contains the created/updated resource

### Error Responses
- `400 Bad Request` - Invalid input data
- `401 Unauthorized` - Missing or invalid authentication token
- `404 Not Found` - Resource not found
- `500 Internal Server Error` - Server error

Error responses include a `detail` field with error message:
```json
{
  "detail": "Game not found"
}
```

