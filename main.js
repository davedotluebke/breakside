if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker
            .register('./service-worker.js')
            .then(reg => console.log('Service Worker: Registered'))
            .catch(err => console.log(`Service Worker Error: ${err}`));
    });
}

// A list of all our main screens
const screens = [
    document.getElementById('teamRosterScreen'),
    document.getElementById('beforePointScreen'),
    document.getElementById('playByPlayScreen'),
    document.getElementById('gameSummaryScreen')
];

// Function to handle screen transitions
function showScreen(screenId) {
    // Hide all screens first
    screens.forEach(screen => screen.style.display = 'none');

    // Display the desired screen
    const targetScreen = document.getElementById(screenId);
    targetScreen.style.display = 'block';
}

// Set up the basic data structures:
const Role = {
    TEAM: "team",
    OPPONENT: "opponent",
};

// Player data structure
function Player(name, nickname = "") {
    this.name = name;
    this.nickname = nickname;
    this.totalPointsPlayed = 0;
    this.consecutivePointsPlayed = 0;
    this.completedPasses = 0;
    this.turnovers = 0;
    this.pointsWon = 0;
    this.pointsLost = 0;
}

// Add Point data structure to track each individual point
function Point(playingPlayers) {
    this.players = playingPlayers;  // An array of player names who played the point
    this.winner = "";  // Either 'team' or 'opponent' 
}

// Modify the Game structure to include a 'points' property
function Game(teamName, opponentName) {
    this.team = teamName;
    this.opponent = opponentName;
    this.scores = {
        [Role.TEAM]: 0,
        [Role.OPPONENT]: 0,
    };
    this.points = [];  // An array of Point objects
    this.startTimestamp = new Date();
    this.endTimestamp = null;
    this.pointsData = [];  // New property: Array of objects. Each object will have player names as keys and true/false as values.
}

// Team data structure
let teamData = {
    name: "My Team",
    teamRoster: [],
    games: []
};

// Sample  names
const sampleNames = [
    "Cyrus L",
    "Leif",
    "Cesc",
    "Cyrus J",
    "Abby",
    "Avery",
    "James",
    "Simeon",
    "Soren",
    "Walden"
  ];

sampleNames.forEach(name => {
    let newPlayer = new Player(name);
    teamData.teamRoster.push(newPlayer);
});

// Set up initial screen
showScreen('teamRosterScreen');

// Updates the displayed roster on the "Team Roster Screen"
function updateTeamRosterDisplay() {
    const rosterElement = document.getElementById('rosterList');
    rosterElement.innerHTML = '';  // Clear existing rows

    teamData.teamRoster.forEach(player => {
        let playerRow = document.createElement('tr');

        // Player name column
        let nameCell = document.createElement('td');
        nameCell.textContent = player.name;

        // Total points played column
        let totalPointsCell = document.createElement('td');
        totalPointsCell.textContent = player.totalPointsPlayed;

        // Append cells to the row
        playerRow.appendChild(nameCell);
        playerRow.appendChild(totalPointsCell);

        // Append row to the table body
        rosterElement.appendChild(playerRow);
    });
}
updateTeamRosterDisplay();

// Updates the displayed roster on the "Before Point Screen"
function updateActivePlayersList() {
    let table = document.getElementById('activePlayersTable');
    let tableBody = table.querySelector('tbody');
    let tableHead = table.querySelector('thead');

    let currentGame = teamData.games[teamData.games.length - 1];

    // Clear existing rows in the table body and head
    tableBody.innerHTML = '';
    tableHead.innerHTML = '';

    // Create header rows for scores
    let teamScoreRow = document.createElement('tr');
    let opponentScoreRow = document.createElement('tr');

    // Function to add cells to the score rows
    const addScoreCells = (row, teamName, scores) => {
        row.appendChild(document.createElement('th')); // empty cell for alignment
        let nameCell = document.createElement('th');
        nameCell.textContent = teamName;
        row.appendChild(nameCell);
        scores.forEach(score => {
            let scoreCell = document.createElement('th');
            scoreCell.textContent = score;
            row.appendChild(scoreCell);
        });
    };

    // Calculate and add score cells
    let runningScores = { team: [0], opponent: [0] };
    currentGame.points.forEach(point => {
        runningScores.team.push(point.winner === 'team' ? runningScores.team.slice(-1)[0] + 1 : runningScores.team.slice(-1)[0]);
        runningScores.opponent.push(point.winner === 'opponent' ? runningScores.opponent.slice(-1)[0] + 1 : runningScores.opponent.slice(-1)[0]);
    });

    addScoreCells(teamScoreRow, currentGame.team, runningScores.team);
    addScoreCells(opponentScoreRow, currentGame.opponent, runningScores.opponent);

    // Add score rows to the head
    tableHead.appendChild(teamScoreRow);
    tableHead.appendChild(opponentScoreRow);

    // Determine players from the last point
    const lastPointPlayers = currentGame.points.length > 0
        ? currentGame.points[currentGame.points.length - 1].players
        : [];

    // Check if a player has played any points
    function hasPlayedAnyPoints(playerName) {
        return currentGame.points.some(point => point.players.includes(playerName));
    }

    // Sort roster into 3 alphabetical lists: played the last point, played any points, played no points 
    teamData.teamRoster.sort((a, b) => {
        const aLastPoint = lastPointPlayers.includes(a.name);
        const bLastPoint = lastPointPlayers.includes(b.name);
        const aPlayedAny = hasPlayedAnyPoints(a.name);
        const bPlayedAny = hasPlayedAnyPoints(b.name);

        if (aLastPoint && !bLastPoint) return -1;
        if (!aLastPoint && bLastPoint) return 1;
        if (aPlayedAny && !bPlayedAny) return -1;
        if (!aPlayedAny && bPlayedAny) return 1;

        return a.name.localeCompare(b.name);
    });


    // Add player rows
    teamData.teamRoster.forEach(player => {
        const row = document.createElement('tr');

        // Checkbox cell
        let checkboxCell = document.createElement('td');
        let checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        if (lastPointPlayers.includes(player.name)) {
            checkbox.checked = true;
        }
        checkboxCell.appendChild(checkbox);
        row.appendChild(checkboxCell);

        // Player name cell
        let nameCell = document.createElement('td');
        nameCell.textContent = player.name;
        row.appendChild(nameCell);

        // Points data cells
        let runningPointTotal = 0;
        currentGame.points.forEach(point => {
            let pointCell = document.createElement('td');

            if (point.players.includes(player.name)) {
                runningPointTotal++;
                pointCell.textContent = runningPointTotal.toString();
            } else {
                pointCell.textContent = '-';
            }

            row.appendChild(pointCell);
        });

        tableBody.appendChild(row);
    });
}

function checkPlayerCount() {
    const checkboxes = document.querySelectorAll('#activePlayersTable input[type="checkbox"]');
    const selectedCount = Array.from(checkboxes).filter(cb => cb.checked).length;
    const expectedCount = parseInt(document.getElementById('playersOnFieldInput').value, 10);

    const startPointBtn = document.getElementById('startPointBtn');
    if (selectedCount !== expectedCount) {
        startPointBtn.classList.add('warning');
    } else {
        startPointBtn.classList.remove('warning');
    }
}

// Handling player addition to teamRoster
document.getElementById('addPlayerBtn').addEventListener('click', function() {
    const playerNameInput = document.getElementById('newPlayerInput');
    const playerName = playerNameInput.value.trim();

    if (playerName && !teamData.teamRoster.some(player => player.name === playerName)) {
        let newPlayer = new Player(playerName);
        teamData.teamRoster.push(newPlayer);
        updateTeamRosterDisplay();
    }
    playerNameInput.value = '';
});
// Also accept an Enter keypress to add a player
const playerNameInput = document.getElementById('newPlayerInput');
playerNameInput.addEventListener('keydown', function(event) {
    if (event.key === "Enter") {
        document.getElementById('addPlayerBtn').click();
    }
});

// Starting a new game
function startNewGame(event) {
    const opponentNameInput = document.getElementById('opponentNameInput');
    const opponentName = opponentNameInput.value.trim() || "them";

    let newGame = new Game(teamData.name, opponentName);
    teamData.games.push(newGame);
    console.log("Starting new game: ");
    console.log(newGame);
    moveToNextPoint();
}
document.getElementById('beginGameBtn').addEventListener('click', startNewGame);
//Also accept an Enter keypress to start a game
document.getElementById('opponentNameInput').addEventListener('keyup', function(event) {
    if (event.key === "Enter") {
        document.getElementById('beginGameBtn').click();
    }
});

// Transition from Select Roster to Before Point Screen
document.getElementById('beginGameBtn').addEventListener('click', function() {
    showScreen('beforePointScreen');
    updateActivePlayersList();
});

// Transition from Before Point to Play-by-Play
let currentPoint = null;  // This will hold the current point being played

document.getElementById('startPointBtn').addEventListener('click', function() {
    // Get the checkboxes and player names
    let checkboxes = [...document.querySelectorAll('#activePlayersTable input[type="checkbox"]')];
    let playerNames = [...document.querySelectorAll('#activePlayersTable td:nth-child(2)')].map(td => td.textContent);

    let activePlayersForThisPoint = [];
    checkboxes.forEach((checkbox, index) => {
        if (checkbox.checked) {
            let playerName = playerNames[index];
            activePlayersForThisPoint.push(playerName);
        }
    });

    // Create a new Point with the active players (without setting the winning team yet)
    currentPoint = new Point(activePlayersForThisPoint);
    showScreen('playByPlayScreen');
});


// Transition from Play-by-Play to Before Point when either team scores
function moveToNextPoint() {
    updateActivePlayersList();
    showScreen('beforePointScreen');
}

// Handling scores and game end
function updateScore(winner) {
    if (winner !== Role.TEAM && winner !== Role.OPPONENT) {
        throw new Error("Invalid role");
    }
    let currentGame = teamData.games[teamData.games.length - 1];

    if (currentPoint) {
        currentPoint.winner = winner; // Setting the winning team for the current point
        currentGame.points.push(currentPoint);
        currentGame.scores[winner]++;

        // Update player stats for those who played this point
        teamData.teamRoster.forEach(p => {
            if (currentPoint.players.includes(p.name)) { // the player played this point
                p.totalPointsPlayed++;
                p.consecutivePointsPlayed++;
                if (winner === Role.TEAM) {
                    p.pointsWon++;
                } else {
                    p.pointsLost++;
                }
            } else {                                    // the player did not play this point
                p.consecutivePointsPlayed = 0;
            }
        });

        currentPoint = null;  // Reset the temporary point object
    }

    updateActivePlayersList();  // Update the table with the new point data
}

document.getElementById('weScoreBtn').addEventListener('click', function() {
    updateScore(Role.TEAM);
    moveToNextPoint();
});

document.getElementById('theyScoreBtn').addEventListener('click', function() {
    updateScore(Role.OPPONENT);
    moveToNextPoint();
});

document.getElementById('endGameBtn').addEventListener('click', function() {
    let currentGame = teamData.games[teamData.games.length - 1]; // Latest game
    currentGame.endTimestamp = new Date(); // Set end timestamp

    // Populate the gameSummaryScreen with statistics, then show it
    document.getElementById('teamName').textContent = currentGame.team;
    document.getElementById('teamFinalScore').textContent = currentGame.scores[Role.TEAM];
    document.getElementById('opponentName').textContent = currentGame.opponent;
    document.getElementById('opponentFinalScore').textContent = currentGame.scores[Role.OPPONENT];
    showScreen('gameSummaryScreen');
});

// Start a new game from the Game Summary screen
document.getElementById('anotherGameBtn').addEventListener('click', function() {
    // Reset game data if needed here
    showScreen('teamRosterScreen');
});

// After DOM objects sufficiently loaded, bind checkPlayerCount to run
// whenever a player's checkbox is clicked
document.getElementById('activePlayersTable').addEventListener('change', checkPlayerCount);
document.getElementById('playersOnFieldInput').addEventListener('input', checkPlayerCount);
