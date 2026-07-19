/*
 * Utility Functions
 * Pure utility functions and data accessors
 */
import { Gender, UNKNOWN_PLAYER } from '../store/models.js';
import { UNKNOWN_PLAYER_OBJ, currentTeam } from '../store/storage.js';
import { log } from './logger.js';

/**
 * Given a player name, return the corresponding Player object from the team roster
 */
function getPlayerFromName(playerName) {
    if (playerName === UNKNOWN_PLAYER) {
        return UNKNOWN_PLAYER_OBJ;  // Return the singleton instance
    }
    return currentTeam ? currentTeam.teamRoster.find(player => player.name === playerName) : null;
}

/**
 * Get the current game (most recent game in the current team's games array)
 */
function currentGame() {
    if (!currentTeam || currentTeam.games.length === 0) {
        log("Warning: No current game");
        return null;
    }
    return currentTeam.games[currentTeam.games.length - 1];
}

/**
 * Return the most recent point, or null if no points yet
 */
function getLatestPoint() {
    const game = currentGame();
    if (!game || game.points.length === 0) { return null; }
    return game.points[game.points.length - 1];
}

/**
 * Get the most recent possession (in most recent point); null if none
 */
function getLatestPossession() {
    const latestPoint = getLatestPoint();
    if (!latestPoint) { return null; }
    if (latestPoint.possessions.length === 0) { return null; }
    return latestPoint.possessions[latestPoint.possessions.length - 1];
}

/**
 * Get the most recent event (in most recent possession with any events); null if no possessions this point
 */
function getLatestEvent() {
    const latestPossession = getLatestPossession();
    if (!latestPossession) { return null; }
    if (latestPossession.events.length > 0) {
        return latestPossession.events[latestPossession.events.length - 1];
    }
    // no events in the current possession; return the last event of the previous possession
    const latestPoint = getLatestPoint();
    if (!latestPoint) { return null; }
    if (latestPoint.possessions.length < 2) { 
        // no previous possession; return null
        return null; 
    }
    const prevPossession = latestPoint.possessions[latestPoint.possessions.length - 2];
    return prevPossession.events[prevPossession.events.length - 1];        
}

/**
 * Find the possession containing the provided event, searching latest first
 */
function getPossessionOf(targetEvent) {
    if (!targetEvent) { return null; }

    const latestPossession = getLatestPossession();
    if (latestPossession && latestPossession.events.includes(targetEvent)) {
        return latestPossession;
    }

    const game = currentGame();
    if (!game) { return null; }

    for (let pointIndex = game.points.length - 1; pointIndex >= 0; pointIndex--) {
        const point = game.points[pointIndex];
        for (let possessionIndex = point.possessions.length - 1; possessionIndex >= 0; possessionIndex--) {
            const possession = point.possessions[possessionIndex];
            if (possession.events.includes(targetEvent)) {
                return possession;
            }
        }
    }

    return null;
}

/**
 * Find the point containing the provided event, searching latest first
 */
function getPointOf(targetEvent) {
    if (!targetEvent) { return null; }

    const latestPoint = getLatestPoint();
    if (latestPoint) {
        for (const possession of latestPoint.possessions) {
            if (possession.events.includes(targetEvent)) {
                return latestPoint;
            }
        }
    }

    const game = currentGame();
    if (!game) { return null; }

    for (let pointIndex = game.points.length - 1; pointIndex >= 0; pointIndex--) {
        const point = game.points[pointIndex];
        for (const possession of point.possessions) {
            if (possession.events.includes(targetEvent)) {
                return point;
            }
        }
    }

    return null;
}

/**
 * Check if a point is currently in progress
 * A point is in progress if it has been started (has startTimestamp or possessions)
 * and hasn't ended (winner is empty)
 */
function isPointInProgress() {
    const latestPoint = getLatestPoint();
    if (!latestPoint) { return false; }
    // Point hasn't ended yet
    if (latestPoint.winner !== "") { return false; }
    // Point has been started (either has timestamp or has possessions)
    const hasStarted = latestPoint.startTimestamp !== null || latestPoint.possessions.length > 0;
    return hasStarted;
}

/**
 * Get the current possession (the last one in the current point); null if none
 */
function getActivePossession(activePoint) {
    if (!activePoint) {
        log("getActivePossession() called, but no active point");
        return null;
    }
    if (activePoint.possessions.length === 0) {
        log("getActivePossession() called, but no possessions in active point");
        return null;
    }
    return activePoint.possessions[activePoint.possessions.length - 1];
}

/**
 * Build a name/id → id resolver scoped to one game.
 *
 * `point.players` stores bare strings with no {name, id} structure — and
 * across data eras those strings are sometimes player NAMES (older games,
 * pre-line-sync flows) and sometimes player IDS (games whose lines came
 * through pendingNextLine, e.g. the Nov-2025 CUDO Mixed tournament). Events
 * carry resolved {name, id} refs, but point.players needs this resolver.
 * Sources for the mapping, most historically-accurate first:
 *   1. `game.rosterSnapshot` — the roster as it stood when the game was
 *      played; the correct source for a renamed/since-removed player.
 *   2. ids already embedded on this game's own events (thrower/receiver/
 *      puller/defender/assist carry both name and id once resolved — see
 *      store/storage.js resolvePlayerReference).
 *   3. the current team roster, as a last resort (logged — a player renamed
 *      since this game was played could resolve to the wrong id here).
 * A string that is already a known player id resolves to itself. A name that
 * maps to more than one distinct id across these sources is ambiguous and is
 * NOT guessed at; it gets its own per-name bucket so stats don't silently
 * merge into the wrong player.
 * @param {object} game - Deserialized Game object
 * @param {object} [opts] - { quiet: true } suppresses per-name warnings for
 *   callers that resolve in a tight loop (e.g. the 1 Hz Lines-tab updater)
 * @returns {function(string): string} resolve(nameOrId) → a stable stats key;
 *   also exposes resolve.nameOf(id) → display name when one is known
 */
function buildPlayerNameResolver(game, { quiet = false } = {}) {
    const byName = {};
    const nameById = {};
    function add(name, id) {
        if (!name || !id) return;
        if (!nameById[id]) nameById[id] = name;
        if (byName[name] && byName[name] !== id) {
            byName[name] = 'AMBIGUOUS';
        } else if (!byName[name]) {
            byName[name] = id;
        }
    }

    (game?.rosterSnapshot?.players || []).forEach(p => add(p.name, p.id));

    (game?.points || []).forEach(point => {
        (point.possessions || []).forEach(poss => {
            (poss.events || []).forEach(event => {
                ['thrower', 'receiver', 'puller', 'defender', 'assist'].forEach(role => {
                    const ref = event[role];
                    if (ref && typeof ref === 'object') add(ref.name, ref.id);
                });
            });
        });
    });

    if (typeof currentTeam !== 'undefined' && currentTeam?.teamRoster) {
        currentTeam.teamRoster.forEach(p => add(p.name, p.id));
    }

    function resolve(name) {
        // Already a known id (id-era point.players): key by it directly.
        if (nameById[name]) return name;
        const id = byName[name];
        if (!id) {
            if (!quiet) console.warn('[eventStats] Could not resolve player name to id — stats will be keyed by name as a fallback:', name);
            return `unresolved:${name}`;
        }
        if (id === 'AMBIGUOUS') {
            if (!quiet) console.warn('[eventStats] Ambiguous player name (matches multiple ids) — keeping separate to avoid merging stats:', name);
            return `ambiguous:${name}`;
        }
        return id;
    }
    resolve.nameOf = id => nameById[id] || null;
    return resolve;
}

/**
 * Rename-proof point-membership tests for one game.
 *
 * point.players / substitutedOutPlayers / substitutedInPlayers hold bare
 * name-or-id strings frozen when the point was played; comparing them to a
 * player's CURRENT name breaks the moment a player is renamed mid-game (the
 * Lines tab once forgot a whole roster's history this way). These tests
 * match on the stable player id via buildPlayerNameResolver, keeping direct
 * name/id string equality as the fast path.
 */
function buildPointMembership(game) {
    const resolve = buildPlayerNameResolver(game, { quiet: true });
    const has = (list, player) => !!player && (list || []).some(entry =>
        entry === player.name || entry === player.id || resolve(entry) === player.id);
    return {
        onLine: (point, player) => !!point && has(point.players, player),
        subbedOut: (point, player) => !!point && has(point.substitutedOutPlayers, player),
        subbedIn: (point, player) => !!point && has(point.substitutedInPlayers, player),
        // Same matching against an arbitrary name-or-id string list (e.g. a
        // stored next-line selection).
        onList: (list, player) => has(list, player),
        // "played" = counted for points/PT: on the line at any moment,
        // including players substituted out mid-point.
        played: (point, player) => !!point && (has(point.players, player) ||
            has(point.substitutedOutPlayers, player)),
    };
}

/**
 * Minimal player-shaped stand-in for an entry that no longer resolves to a
 * current-roster Player (removed player, unmigrated legacy data, cross-device
 * roster gap). Shape matches store/storage.js resolvePlayerReference's
 * fallback, so events recorded against it still serialize the name.
 */
function playerStub(name) {
    return { name, id: null, gender: Gender.UNKNOWN };
}

/**
 * Game-scoped lookup for `point.players` entries → current Player objects.
 *
 * The entries are bare strings that may be a current roster name, a player id
 * (id-era games), or a stale name (player renamed/removed since the point was
 * played) — see buildPlayerNameResolver. UI that builds player buttons/chips
 * from point.players must resolve through this rather than getPlayerFromName,
 * otherwise id-era and renamed entries come back undefined (which has
 * variously meant dead Proceed buttons and silently missing player rows).
 *
 * Returns lookup(entry) → { player, name, obj }:
 *   player — the current-roster Player, or null when nobody matches
 *   name   — best display name: the player's current name, else the
 *            historical name recorded for a known id, else the raw entry
 *   obj    — `player` when resolved, else playerStub(name): always safe to
 *            render or record an event against
 */
function buildPointPlayerLookup(game) {
    const resolve = buildPlayerNameResolver(game, { quiet: true });
    return function lookup(entry) {
        if (entry === UNKNOWN_PLAYER) {
            return { player: UNKNOWN_PLAYER_OBJ, name: UNKNOWN_PLAYER, obj: UNKNOWN_PLAYER_OBJ };
        }
        const roster = currentTeam?.teamRoster || [];
        let player = roster.find(p => p.name === entry) || roster.find(p => p.id === entry);
        if (!player) {
            const id = resolve(entry);  // stable id, or an unresolved:/ambiguous: bucket
            player = roster.find(p => p.id === id) || null;
        }
        const name = player ? player.name : (resolve.nameOf(entry) || entry);
        return { player, name, obj: player || playerStub(name) };
    };
}

/**
 * Helper function to calculate player's time in current game
 * Accepts a Player object (preferred — survives mid-game renames) or a
 * player name string.
 * Note: This function references isPaused which is defined in main.js
 */
function getPlayerGameTime(playerOrName) {
    let totalTime = 0;
    const game = currentGame();
    if (game) {
        const player = (playerOrName && typeof playerOrName === 'object')
            ? playerOrName
            : getPlayerFromName(playerOrName);
        const membership = buildPointMembership(game);
        game.points.forEach(point => {
            // Include players who were substituted out mid-point. Id-based
            // matching where possible; raw-string fallback when the name no
            // longer maps to a roster player.
            const playedPoint = player
                ? membership.played(point, player)
                : (point.players.includes(playerOrName) ||
                    (point.substitutedOutPlayers && point.substitutedOutPlayers.includes(playerOrName)));
            if (playedPoint) {
                if (point.endTimestamp) {
                    // For completed points, just use the totalPointTime
                    totalTime += point.totalPointTime;
                } else if (!point.winner) {
                    // For the current point (in progress), handle paused state.
                    // late-bound state read (isPaused lives in
                    // game/pointManagement.js, "above" this layer — its window
                    // accessor is kept deliberately; see ARCHITECTURE.md § ES modules).
                    if (typeof window.isPaused !== 'undefined' && window.isPaused) {
                        // If paused, just use the accumulated time
                        totalTime += point.totalPointTime;
                    } else if (point.startTimestamp) {
                        // If running, calculate current running time and update totalPointTime
                        const currentRunningTime = new Date() - point.startTimestamp;
                        totalTime += currentRunningTime;
                    } else {
                        // Point not started yet
                        totalTime += 0;
                    }
                } else {
                    // This shouldn't happen, but if it does, just use totalPointTime
                    totalTime += point.totalPointTime;
                }
            }
        });
    }
    return totalTime;
}

/**
 * Format play time from milliseconds to MM:SS format
 */
function formatPlayTime(totalTimePlayed) {
    const timeDifferenceInMilliseconds = totalTimePlayed;
    const timeDifferenceInSeconds = Math.floor(timeDifferenceInMilliseconds / 1000);
    const minutes = Math.floor(timeDifferenceInSeconds / 60);
    const seconds = timeDifferenceInSeconds % 60;
    // Function to format a number as two digits with leading zeros
    const formatTwoDigits = (num) => (num < 10 ? `0${num}` : num);
    return `${formatTwoDigits(minutes)}:${formatTwoDigits(seconds)}`;
}

/**
 * Determine whether the next point starts on offense or defense.
 * Pure game logic: inspects completed points, switchsides events, and point winners.
 *
 * Normal rule: the scoring team pulls the next point (we scored → we start
 * on defense). A "switch sides" (halftime) on a point overrides that for
 * the FOLLOWING point: each period opens with roles swapped from how the
 * previous period opened — the team that pulled to start the game receives
 * to start the second half, from the other end — regardless of who won the
 * point before the break. (Two switchsides on the same point cancel: an
 * accidental tap plus its correction.)
 */
function determineStartingPosition() {
    if (!currentGame()) { log("Warning: No current game"); return 'offense'; }
    const flip = pos => (pos === 'offense') ? 'defense' : 'offense';
    let startPointOn = currentGame().startingPosition;
    // How the current period opened; the first period opens on the game's
    // startingPosition, and each halftime flips it.
    let periodOpening = currentGame().startingPosition;
    currentGame().points.forEach(point => {
        let switchsides = false;
        let forceswap = false;
        point.possessions.forEach(possession => {
            possession.events.forEach(event => {
                if (event.type !== 'Other') return;
                // Halftime IS a period break (it implies the side switch);
                // a bare switchsides event counts the same.
                if (event.switchsides_flag || event.halftime_flag) {
                    switchsides = !switchsides;
                }
                // Manual "Swap O & D" correction — applied on top of
                // whatever the rules below compute.
                if (event.forceswap_flag) {
                    forceswap = !forceswap;
                }
            });
        });
        if (switchsides) {
            // Halftime after this point: next point restarts play with the
            // period-opening roles swapped, ignoring this point's winner.
            periodOpening = flip(periodOpening);
            startPointOn = periodOpening;
        } else if (point.winner === 'team') {
            startPointOn = 'defense';   // we scored → we pull
        } else {
            startPointOn = 'offense';   // they scored → they pull to us
        }
        if (forceswap) {
            // Coach says the computed orientation is backwards from here on:
            // invert the next start AND the period bookkeeping, so a later
            // halftime flips from the corrected orientation.
            startPointOn = flip(startPointOn);
            periodOpening = flip(periodOpening);
        }
    });
    return startPointOn;
}

/**
 * Capitalize the first letter of a word
 */
function capitalize(word) {
    return word.charAt(0).toUpperCase() + word.slice(1);
}

/**
 * Whether jersey numbers should be shown alongside player names.
 * Per-device display preference; defaults to true. Read late-bound via
 * window.advancedSettings because the settings module sits above this
 * layer (window survivor: settings/advancedSettings.js).
 */
function showPlayerNumbers() {
    const adv = (typeof window !== 'undefined') ? window.advancedSettings : null;
    if (adv && typeof adv.get === 'function') {
        return adv.get('display.showPlayerNumbers') !== false;
    }
    return true;
}

/**
 * Format player name with jersey number for display
 * Returns "Name (#)" if number exists and the "show player numbers"
 * setting is on, otherwise just "Name"
 */
function formatPlayerName(player) {
    if (!player) return '';
    if (player.number !== null && player.number !== undefined && showPlayerNumbers()) {
        return `${player.name} (${player.number})`;
    }
    return player.name;
}

/**
 * Extract player name from displayed text that may include number
 * Strips "(#)" suffix if present
 */
function extractPlayerName(displayText) {
    if (!displayText) return '';
    // Match pattern: "Name (#)" and extract just "Name"
    const match = displayText.match(/^(.+?)\s*\(\d+\)$/);
    return match ? match[1].trim() : displayText.trim();
}

/**
 * Get the gender ratio (FMP or MMP) for a specific point index in an alternating game
 * Returns 'FMP', 'MMP', or null if not applicable. 
 * 
 * The pattern is: ABBAABB... (or {0,1,1,0,0,1,1}...) 
 * which is (i+1) // 2 % 2   [where // is integer division and % is modulo]
 * or ((i+1) >> 1) & 1   using bitwise operations
 */
function getGenderRatioForPoint(game, pointIndex) {
    if (!game || game.alternateGenderRatio !== 'Alternating' || !game.startingGenderRatio) {
        return null;
    }

    const useFirstRatio = (((pointIndex + 1) >> 1) & 1) === 0;

    return useFirstRatio ? game.startingGenderRatio : (game.startingGenderRatio === 'FMP' ? 'MMP' : 'FMP');
}

/**
 * Get the expected gender ratio for the next point to be played.
 * Uses game.points.length as the next point index.
 * @returns {'FMP'|'MMP'|null}
 */
function getExpectedGenderRatio(game) {
    return getGenderRatioForPoint(game, game ? game.points.length : 0);
}

/**
 * Get expected FMP/MMP player counts for a given player count and ratio.
 * The "majority" gender gets ceil(count/2), the other gets floor(count/2).
 * E.g., 7 players + 'FMP' → {fmp: 4, mmp: 3}
 * @returns {{fmp: number, mmp: number}}
 */
function getExpectedGenderCounts(expectedCount, expectedRatio) {
    const majority = Math.ceil(expectedCount / 2);
    const minority = Math.floor(expectedCount / 2);
    if (expectedRatio === 'FMP') {
        return { fmp: majority, mmp: minority };
    } else {
        return { fmp: minority, mmp: majority };
    }
}

// --- ES-module exports ---
export {
    getPlayerFromName, currentGame, getLatestPoint, getLatestPossession,
    getLatestEvent, getPossessionOf, getPointOf, isPointInProgress,
    getActivePossession, getPlayerGameTime, formatPlayTime,
    buildPlayerNameResolver, buildPointMembership, buildPointPlayerLookup, playerStub,
    determineStartingPosition, capitalize, formatPlayerName, extractPlayerName,
    showPlayerNumbers,
    getGenderRatioForPoint, getExpectedGenderRatio, getExpectedGenderCounts,
};

// window survivor: e2e test seam — the Playwright suite reads
// window.currentGame via page.evaluate (scenarios 03/04/05). Permanent.
window.currentGame = currentGame;

