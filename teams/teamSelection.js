/*
 * Team selection screen logic
 * Handles team switching, loading, and creation
 */

function showSelectTeamScreen(firsttime = false) {
    const teamListElement = document.getElementById('teamList');
    const teamListWarning = document.getElementById('teamListWarning');
    if (!teamListElement || !teamListWarning) {
        console.warn('Team selection elements not found in DOM.');
        return;
    }

    teamListElement.innerHTML = '';

    if (teams.length === 0 || (teams.length === 1 && teams[0].name === 'Sample Team')) {
        teamListWarning.style.display = 'block';
    } else {
        teamListWarning.style.display = 'none';
    }

    const table = document.createElement('table');
    table.classList.add('team-selection-table');

    teams.forEach((team, teamIndex) => {
        const teamRow = document.createElement('tr');
        teamRow.classList.add('team-row');

        const teamNameCell = document.createElement('td');
        teamNameCell.textContent = team.name;
        teamNameCell.classList.add('team-name');
        teamNameCell.onclick = () => selectTeam(teamIndex);
        teamRow.appendChild(teamNameCell);

        const gamesCell = document.createElement('td');
        const gamesList = document.createElement('ul');
        gamesList.classList.add('games-list');

        team.games.forEach((game, gameIndex) => {
            const gameItem = document.createElement('li');
            const gameText = document.createElement('span');
            gameText.textContent = `vs ${game.opponent} (${game.scores[Role.TEAM]}-${game.scores[Role.OPPONENT]})`;
            if (!game.gameEndTimestamp) {
                gameText.textContent += ' [In Progress]';
            }
            gameItem.appendChild(gameText);

            if (!game.gameEndTimestamp) {
                const resumeBtn = document.createElement('button');
                resumeBtn.textContent = '↪️';
                resumeBtn.classList.add('icon-button');
                resumeBtn.title = 'Resume Game';
                resumeBtn.onclick = (e) => {
                    e.stopPropagation();
                    if (confirm('Resume this game?')) {
                        currentTeam = team;
                        if (isPointInProgress()) {
                            const latestPossession = getLatestPossession();
                            if (latestPossession && latestPossession.offensive) {
                                updateOffensivePossessionScreen();
                                showScreen('offensePlayByPlayScreen');
                            } else {
                                updateDefensivePossessionScreen();
                                showScreen('defensePlayByPlayScreen');
                            }
                        } else {
                            if (typeof updateActivePlayersList === 'function') {
                                updateActivePlayersList();
                            }
                            showScreen('beforePointScreen');
                        }
                    }
                };
                gameItem.appendChild(resumeBtn);
            }

            const deleteBtn = document.createElement('button');
            deleteBtn.textContent = '🗑️';
            deleteBtn.classList.add('icon-button');
            deleteBtn.title = 'Delete Game';
            deleteBtn.onclick = (e) => {
                e.stopPropagation();
                if (confirm('Delete this game? This cannot be undone.')) {
                    removeGameStatsFromRoster(team, game);
                    team.games.splice(gameIndex, 1);
                    showSelectTeamScreen();
                    if (typeof saveAllTeamsData === 'function') {
                        saveAllTeamsData();
                    }
                }
            };
            gameItem.appendChild(deleteBtn);

            gamesList.appendChild(gameItem);
        });

        gamesCell.appendChild(gamesList);
        teamRow.appendChild(gamesCell);
        table.appendChild(teamRow);
    });

    teamListElement.appendChild(table);
    showScreen('selectTeamScreen');
}

function removeGameStatsFromRoster(team, game) {
    const points = game.points || [];

    points.forEach(point => {
        const pointDuration = point.totalPointTime;
        point.players.forEach(playerName => {
            const player = getPlayerFromName(playerName);
            if (player) {
                player.totalPointsPlayed = Math.max(0, (player.totalPointsPlayed || 0) - 1);
                player.totalTimePlayed = Math.max(0, (player.totalTimePlayed || 0) - pointDuration);
                if (game === team.games[team.games.length - 1]) {
                    player.consecutivePointsPlayed = 0;
                }
            }
        });
    });
}

function selectTeam(index) {
    currentTeam = teams[index];
    if (typeof updateTeamRosterDisplay === 'function') {
        updateTeamRosterDisplay();
    }
    showScreen('teamRosterScreen');
}

function initializeTeamSelection() {
    const loadTeamBtn = document.getElementById('loadTeamBtn');
    const fileInput = document.getElementById('fileInput');
    if (loadTeamBtn && fileInput) {
        loadTeamBtn.onclick = () => fileInput.click();
        fileInput.addEventListener('change', (event) => {
            const file = event.target.files ? event.target.files[0] : null;
            if (!file) return;

            const reader = new FileReader();
            reader.onload = function(e) {
                try {
                    const jsonData = JSON.parse(e.target.result);
                    const newTeams = deserializeTeams(JSON.stringify([jsonData]));
                    if (newTeams && newTeams[0]) {
                        teams.push(newTeams[0]);
                        currentTeam = newTeams[0];
                        if (typeof updateTeamRosterDisplay === 'function') {
                            updateTeamRosterDisplay();
                        }
                        showSelectTeamScreen();
                    }
                } catch (error) {
                    console.error('Error parsing JSON:', error);
                }
            };
            reader.readAsText(file);
        });
    }

    const switchTeamsBtn = document.getElementById('switchTeamsBtn');
    if (switchTeamsBtn) {
        switchTeamsBtn.addEventListener('click', () => showSelectTeamScreen());
    }

    const createNewTeamBtn = document.getElementById('createNewTeamBtn');
    if (createNewTeamBtn) {
        createNewTeamBtn.addEventListener('click', () => {
            const modal = document.getElementById('createTeamModal');
            if (modal) {
                modal.style.display = 'block';
            }
        });
    }

    const closeButton = document.querySelector('.close');
    if (closeButton) {
        closeButton.addEventListener('click', () => {
            const modal = document.getElementById('createTeamModal');
            if (modal) {
                modal.style.display = 'none';
            }
        });
    }

    const saveNewTeamBtn = document.getElementById('saveNewTeamBtn');
    if (saveNewTeamBtn) {
        saveNewTeamBtn.addEventListener('click', () => {
            const input = document.getElementById('newTeamNameInput');
            const newTeamName = input ? input.value.trim() : '';
            if (newTeamName) {
                const newTeam = new Team(newTeamName);
                teams.push(newTeam);
                currentTeam = newTeam;
                if (typeof updateTeamRosterDisplay === 'function') {
                    updateTeamRosterDisplay();
                }
                showScreen('teamRosterScreen');
                const modal = document.getElementById('createTeamModal');
                if (modal) {
                    modal.style.display = 'none';
                }
                if (input) {
                    input.value = '';
                }
            } else {
                alert('Please enter a team name.');
            }
        });
    }

    window.addEventListener('click', (event) => {
        const modal = document.getElementById('createTeamModal');
        if (modal && event.target === modal) {
            modal.style.display = 'none';
        }
    });

    const backToRosterBtn = document.getElementById('backToRosterScreenBtn');
    if (backToRosterBtn) {
        backToRosterBtn.addEventListener('click', () => {
            if (typeof updateTeamRosterDisplay === 'function') {
                updateTeamRosterDisplay();
            }
            showScreen('teamRosterScreen');
        });
    }
}

initializeTeamSelection();
