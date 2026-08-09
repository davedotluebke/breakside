/*
 * Event-Level Statistics
 * Computes aggregate player stats across all games in a TournamentEvent.
 * Loads games from cloud via loadGameFromCloud since games aren't bulk-loaded
 * onto the team object until individually opened.
 *
 * The arithmetic itself lives in utils/statAccumulator.js — a pure leaf module
 * with no store/sync.js dependency. This module is the cloud-loading half, and
 * re-exports the pure half so every existing `from '../utils/eventStats.js'`
 * import keeps working unchanged.
 */

import { loadGameFromCloud, listServerGames } from '../store/sync.js';
import {
    accumulateGameStats, sumPlayerStats, classifyPoint, getGameTeamStats,
    filterGames, getGamesPlayerStats, getGamesTeamStats, getGamesRecord,
    formatGameLabel, formatTeamStatsLine, formatSetStatsLines, getGamePlayerStats,
} from './statAccumulator.js';

/**
 * Load all games for an event from cloud storage.
 * @param {object} event - TournamentEvent with gameIds array
 * @returns {Promise<Array>} Array of deserialized Game objects
 */
async function loadEventGames(event) {
    const gameIds = event?.gameIds || [];
    if (gameIds.length === 0) return [];

    if (typeof loadGameFromCloud !== 'function') {
        console.warn('loadGameFromCloud not available');
        return [];
    }

    const games = [];
    for (const gameId of gameIds) {
        try {
            const game = await loadGameFromCloud(gameId);
            if (game) games.push(game);
        } catch (e) {
            console.debug('Skipping unavailable game', gameId);
        }
    }
    return games;
}

// buildPlayerNameResolver moved to utils/helpers.js so point-membership
// checks (Lines tab, playing time) can share it without an import cycle.

/**
 * Aggregate team-level point classifications across an event.
 * @param {object} event - TournamentEvent
 * @param {object} [options] - { phase: string | null } to filter by phase
 * @returns {Promise<object>} Same shape as getGameTeamStats
 */
async function getEventTeamStats(event, options = {}) {
    if (!event) return getGamesTeamStats([]);
    const games = await loadEventGames(event);
    return getGamesTeamStats(filterGames(games, options));
}

/**
 * Get lifetime (all-time) aggregate player stats for a team, across every game
 * the team has played. Mirrors getEventPlayerStats but spans the whole team
 * rather than one event.
 *
 * Stats are derived from game events — the legacy per-player counters
 * (totalPointsPlayed, totalTimePlayed, …) are NOT maintained in the current
 * model, so we must aggregate the actual games. In-memory games (the live
 * session, including the current game) are used directly; the rest are loaded
 * from cloud by id and deduped.
 *
 * @param {object} team - Team object (needs id; games[] used when present)
 * @returns {Promise<Object>} Map of playerId → stats
 */
async function getTeamPlayerStats(team) {
    if (!team) return {};
    const stats = {};
    const seen = new Set();

    // 1. In-memory games (current session — full data, incl. the live game).
    (team.games || []).forEach(g => {
        if (g && Array.isArray(g.points) && g.points.length > 0) {
            accumulateGameStats(g, stats);
            if (g.id) seen.add(g.id);
        }
    });

    // 2. Every other game the cloud lists for this team.
    let summaries = [];
    if (typeof listServerGames === 'function') {
        try { summaries = await listServerGames(); } catch (e) { summaries = []; }
    }
    const ids = summaries
        .filter(g => g && g.teamId === team.id && g.game_id && !seen.has(g.game_id))
        .map(g => g.game_id);

    for (const gid of ids) {
        if (seen.has(gid)) continue;
        try {
            const game = (typeof loadGameFromCloud === 'function') ? await loadGameFromCloud(gid) : null;
            if (game) { accumulateGameStats(game, stats); seen.add(gid); }
        } catch (e) {
            console.debug('Skipping unavailable game', gid);
        }
    }
    return stats;
}

/**
 * Get aggregate player stats for an event across all its games.
 * @param {object} event - TournamentEvent object (must have gameIds)
 * @param {object} [options] - { phase: string } to restrict to one phase label
 * @returns {Promise<Object>} Map of playerId → stats
 */
async function getEventPlayerStats(event, options = {}) {
    if (!event) return {};

    const games = await loadEventGames(event);
    return getGamesPlayerStats(filterGames(games, options));
}

/**
 * Get event W/L record
 * @param {object} event - TournamentEvent object (must have gameIds)
 * @param {object} [options] - { phase: string } to restrict to one phase label
 * @returns {Promise<{ wins: number, losses: number, ties: number }>}
 */
async function getEventRecord(event, options = {}) {
    if (!event) return { wins: 0, losses: 0, ties: 0 };

    const games = await loadEventGames(event);
    return getGamesRecord(filterGames(games, options));
}

// --- ES-module exports ---
export {
    loadEventGames,
    accumulateGameStats,
    classifyPoint,
    getGameTeamStats,
    getEventTeamStats,
    formatTeamStatsLine,
    formatSetStatsLines,
    getGamePlayerStats,
    getTeamPlayerStats,
    getEventPlayerStats,
    getEventRecord,
    sumPlayerStats,
    filterGames,
    getGamesPlayerStats,
    getGamesTeamStats,
    getGamesRecord,
    formatGameLabel
};
