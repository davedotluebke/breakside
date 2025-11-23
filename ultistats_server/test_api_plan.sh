#!/bin/bash
# Test plan for Ultistats REST API
# This script provides a step-by-step testing guide

set -e

BASE_URL="http://localhost:8000"
TOKEN=""

echo "=========================================="
echo "Ultistats REST API Testing Plan"
echo "=========================================="
echo ""
echo "Make sure the server is running:"
echo "  DEBUG=True uvicorn ultistats_server.main:app --reload"
echo ""
echo "Press Enter to continue..."
read

# Step 1: Register a user
echo ""
echo "Step 1: Register a user"
echo "----------------------"
curl -X POST "${BASE_URL}/auth/register" \
  -H "Content-Type: application/json" \
  -d '{
    "username": "testuser",
    "password": "testpass123",
    "email": "test@example.com",
    "full_name": "Test User"
  }' | jq '.' || echo "Registration response (may fail if user exists)"

echo ""
echo "Press Enter to continue..."
read

# Step 2: Login
echo ""
echo "Step 2: Login and get token"
echo "--------------------------"
LOGIN_RESPONSE=$(curl -s -X POST "${BASE_URL}/auth/login" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "username=testuser&password=testpass123")

echo "$LOGIN_RESPONSE" | jq '.'

TOKEN=$(echo "$LOGIN_RESPONSE" | jq -r '.access_token // empty')

if [ -z "$TOKEN" ]; then
  echo "❌ Failed to get token. Check login response above."
  exit 1
fi

echo ""
echo "✅ Token received: ${TOKEN:0:20}..."
echo ""
echo "Press Enter to continue..."
read

# Step 3: Test root endpoint
echo ""
echo "Step 3: Test root endpoint"
echo "-------------------------"
curl -X GET "${BASE_URL}/" | jq '.'

echo ""
echo "Press Enter to continue..."
read

# Step 4: Create a team
echo ""
echo "Step 4: Create a team"
echo "--------------------"
TEAM_RESPONSE=$(curl -s -X POST "${BASE_URL}/teams" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "team_name": "Test Team"
  }')

echo "$TEAM_RESPONSE" | jq '.'

TEAM_ID=$(echo "$TEAM_RESPONSE" | jq -r '.team_id // empty')

if [ -z "$TEAM_ID" ]; then
  echo "❌ Failed to create team. Check response above."
  exit 1
fi

echo ""
echo "✅ Team created with ID: ${TEAM_ID}"
echo ""
echo "Press Enter to continue..."
read

# Step 5: List teams
echo ""
echo "Step 5: List all teams"
echo "------------------"
curl -X GET "${BASE_URL}/teams" \
  -H "Authorization: Bearer ${TOKEN}" | jq '.'

echo ""
echo "Press Enter to continue..."
read

# Step 6: Add players
echo ""
echo "Step 6 players"
echo "--------------"
curl -X POST "${BASE_URL}/teams/${TEAM_ID}/players" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Alice",
    "nickname": "Ali",
    "gender": "FMP",
    "number": "1"
  }' | jq '.'

curl -X POST "${BASE_URL}/teams/${TEAM_ID}/players" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Bob",
    "gender": "MMP",
    "number": "2
  }' | jq '.'

echo ""
echo "Press Enter to continue..."
read

# Step 7: Get team roster
echo ""
echo "Step 7: Get team roster"
echo "----------------------"
curl -X GET "${BASE_URL}/teams/${TEAM_ID}/players" \
  -H "Authorization: Bearer ${TOKEN}" | jq '.'

echo ""
echo "Press Enter to continue..."
read

# Step 8: Create a game
echo ""
echo "Step 8: Create a game"
echo "--------------------"
GAME_RESPONSE=$(curl -s -X POST "${BASE_URL}/games" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{
    \"team_id\": \"${TEAM_ID}\",
    \"team_name\": \"Test Team\",
    \"opponent_name\": \"Opponent Team\",
    \"starting_position\": \"offense\"
  }")

echo "$GAME_RESPONSE" | jq '.'

GAME_ID=$(echo "$GAME_RESPONSE" | jq -r '.game_id // empty')

if [ -z "$GAME_ID" ]; then
  echo "❌ Failed to create game. Check response above."
  exit 1
fi

echo ""
echo "✅ Game created with ID: ${GAME_ID}"
echo ""
echo "Press Enter to continue..."
read

# Step 9: Test event endpoints
echo ""
echo "Step 9: Test event endpoints"
echo "---------------------------"
echo "Adding a single event..."

# Create a proper event row (26 columns)
EVENT_ROW='["1", "2024-01-15T10:00:00", "Offense", "Alice,Bob,Charlie", "", "", "", "", "", "Alice", "Bob", "huck", "", "", "", "", "", "", "", "", "", "", "", "", "1", "offensive"]'

curl -X POST "${BASE_URL}/games/${GAME_ID}/events" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"row\": ${EVENT_ROW}}" | jq '.'

echo ""
echo "Testing batch events..."

BATCH_EVENTS='{"rows": [["1", "", "", "", "", "", "", "", "", "Bob", "Charlie", "break", "", "", "", "", "", "", "", "", "", "", "", "", "1", "offensive"], ["1", "", "", "", "", "", "", "", "", "", "", "", "Dave", "interception", "", "", "", "", "", "", "", "", "", "", "1", "defensive"]]}'

curl -X POST "${BASE_URL}/games/${GAME_ID}/events/batch" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d "${BATCH_EVENTS}" | jq '.'

echo ""
echo "Press Enter to continue..."
read

# Step 10: Get game data
echo ""
echo "Step 10: Get game data"
echo "---------------------"
curl -X GET "${BASE_URL}/games/${GAME_ID}/data" \
  -H "Authorization: Bearer ${TOKEN}" | jq '.rows | length'

echo ""
echo "Press Enter to continue..."
read

# Step 11: Test full sync
echo ""
echo "Step 11: Test full game sync"
echo "---------------------------"
echo "Getting current game data for sync..."

CURRENT_DATA=$(curl -s -X GET "${BASE_URL}/games/${GAME_ID}/data" \
  -H "Authorization: Bearer ${TOKEN}")

echo "Syncing game data..."
curl -X POST "${BASE_URL}/games/${GAME_ID}/sync" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"rows\": $(echo "$CURRENT_DATA" | jq '.rows')}" | jq '.'

echo ""
echo "✅ All tests completed!"
echo ""
echo "Summary:"
echo "  Team ID: ${TEAM_ID}"
echo "  Game ID: ${GAME_ID}"
echo "  Check Google Sheets to verify data was written"

