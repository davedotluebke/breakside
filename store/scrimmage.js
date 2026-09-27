/*
 * Intrasquad scrimmages — the pure half (no DOM, no network, no app state).
 *
 * A scrimmage is a practice game between two squads drawn from one team's
 * roster. It is stored as TWO ordinary Game objects, one per squad, linked by
 * a shared `scrimmageId`. Each squad-game is a normal game seen from its own
 * squad's side — `game.team` is this squad's name, `game.opponent` the other
 * squad's, `rosterSnapshot` this squad's players — so one coach tracks each
 * squad with the in-game machinery untouched: line selection, every
 * play-by-play mode, the stats accumulators, sync, the controller roles.
 * Nothing new is stored server-side; the team list folds the two halves back
 * into one card, and the scrimmage stats screen aggregates squad-games across
 * many practices, outside the team's games and events. See ARCHITECTURE.md
 * § Intrasquad scrimmages.
 *
 * Everything here works on plain objects — full Game objects and the server's
 * game summaries (`list_all_games`) alike, since both carry the three fields
 * (`scrimmageId`, `scrimmageSquad`, `scrimmageName`) plus team/opponent and
 * scores — so the team list and the stats screen share one vocabulary.
 * teams/scrimmageDialogs.js owns the dialog and the Game construction; this
 * module is what tests/unit/scrimmage.test.mjs pins.
 */
import { Gender, PlayerPosition, Player, generateShortId } from './models.js';

/** The two squads. Stable keys; the coach names them (see DEFAULT_SQUAD_NAMES). */
const SQUADS = ['X', 'Y'];

/** Jersey colours: short enough for the game header's large identity text. */
const DEFAULT_SQUAD_NAMES = { X: 'Dark', Y: 'Light' };

/** True for a Game or game summary that is one half of a scrimmage. */
function isScrimmageGame(game) {
    return !!(game && game.scrimmageId);
}

/** The games that are not scrimmage halves — the team's real games. */
function withoutScrimmages(games) {
    return (games || []).filter(g => !isScrimmageGame(g));
}

function otherSquad(squad) {
    return squad === 'X' ? 'Y' : 'X';
}

/**
 * Squad names as they will be stored. Trims, falls back to the defaults, and
 * guarantees the two differ: a shared name would give both squad-games the
 * same team and opponent, and their ids the same stem.
 * @param {{X?: string, Y?: string}} [names]
 * @returns {{X: string, Y: string}}
 */
function normalizeSquadNames(names = {}) {
    let x = String(names.X ?? '').trim() || DEFAULT_SQUAD_NAMES.X;
    let y = String(names.Y ?? '').trim() || DEFAULT_SQUAD_NAMES.Y;
    if (x.toLowerCase() === y.toLowerCase()) {
        x = `${x} X`;
        y = `${y} Y`;
    }
    return { X: x, Y: y };
}

/** "Scrimmage-2026-09-27-ab12" — dated, so a data directory listing reads. */
function generateScrimmageId(date = new Date()) {
    return generateShortId(`Scrimmage ${isoDay(date)}`);
}

function isoDay(date) {
    const d = date instanceof Date ? date : new Date(date);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function pad2(n) {
    return String(n).padStart(2, '0');
}

/** "09/27/26" — the team list's date format. */
function formatShortDate(date) {
    const d = date instanceof Date ? date : new Date(date);
    if (isNaN(d.getTime())) return '??/??/??';
    return `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}/${String(d.getFullYear()).slice(-2)}`;
}

/**
 * The fields that make a Game one squad's half of a scrimmage, applied to a
 * freshly constructed Game by teams/scrimmageDialogs.js. Kept here so the
 * team/opponent convention has one home: `team` is this squad, `opponent`
 * the other, exactly as every display surface already reads them.
 * @param {{scrimmageId: string, squad: 'X'|'Y', squadNames: {X: string, Y: string}, name?: string|null}} spec
 */
function squadGameFields({ scrimmageId, squad, squadNames, name = null }) {
    return {
        scrimmageId,
        scrimmageSquad: squad,
        scrimmageName: (name && String(name).trim()) || null,
        team: squadNames[squad],
        opponent: squadNames[otherSquad(squad)],
    };
}

/**
 * The roster snapshot for one squad-game: the squad's players as they stand
 * now, in roster order — the same shape createRosterSnapshot (store/models.js)
 * writes, since everything downstream (buildPlayerNameResolver, the Review
 * screen) reads that shape. null when the squad is empty, like the original.
 * @param {Array<object>} teamRoster - the team's Player objects
 * @param {Array<string>} playerIds - this squad's player ids
 * @param {Date} [now]
 */
function buildSquadSnapshot(teamRoster, playerIds, now = new Date()) {
    const wanted = new Set(playerIds || []);
    const players = (teamRoster || [])
        .filter(p => p && wanted.has(p.id))
        .map(p => ({
            id: p.id,
            name: p.name,
            nickname: p.nickname || '',
            number: p.number || null,
            gender: p.gender || Gender.UNKNOWN,
            position: p.position || null,
            defaultLine: p.defaultLine || null,
        }));
    if (players.length === 0) return null;
    return { players, capturedAt: now.toISOString() };
}

/**
 * The players a squad-game can field: its roster snapshot (the squad picked
 * when the scrimmage was created, plus anyone added mid-game) resolved to the
 * live team Players, so renames and edits since then show. A snapshot entry
 * no longer on the team roster is rebuilt from the snapshot itself, so the
 * points it played still resolve.
 * @param {object} game - a squad-game
 * @param {Array<object>} teamRoster - the team's Player objects
 * @returns {Array<object>} Player objects, in snapshot order
 */
function squadRoster(game, teamRoster) {
    const snapshot = game?.rosterSnapshot?.players || [];
    const roster = teamRoster || [];
    return snapshot.map(entry => {
        const live = roster.find(p => p && p.id === entry.id);
        if (live) return live;
        const player = new Player(entry.name, entry.nickname || '',
            entry.gender || Gender.UNKNOWN, entry.number ?? null, entry.id);
        player.position = entry.position || null;
        player.defaultLine = entry.defaultLine || null;
        return player;
    });
}

// ── dealing players onto squads ─────────────────────────────────────────

function positionRank(player) {
    if (player.position === PlayerPosition.HANDLER) return 0;
    if (player.position === PlayerPosition.CUTTER) return 1;
    return 2;   // hybrid / unset: fills either slot
}

function genderGroup(player) {
    if (player.gender === Gender.FMP) return Gender.FMP;
    if (player.gender === Gender.MMP) return Gender.MMP;
    return Gender.UNKNOWN;
}

function shuffled(list, random) {
    const out = list.slice();
    for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
}

/**
 * Deal players onto two squads, balanced by gender and position.
 *
 * Players are grouped by gender, so a mixed team's ratio comes out the same
 * on both sides; each group is ordered handlers → cutters → hybrid/unset, so
 * the positions alternate too; then it is dealt X, Y, X, Y… Each group starts
 * with whichever squad is currently smaller, so the totals differ by at most
 * one however the groups divide. `shuffle` randomizes the order within each
 * position bucket (a different split next practice) and keeps the balance;
 * `random` is injectable for tests.
 *
 * @param {Array<object>} players - roster Players (id, gender, position, name)
 * @param {{shuffle?: boolean, random?: () => number}} [opts]
 * @returns {{X: string[], Y: string[]}} player ids per squad
 */
function splitSquads(players, { shuffle = false, random = Math.random } = {}) {
    const squads = { X: [], Y: [] };
    const valid = (players || []).filter(p => p && p.id);
    [Gender.FMP, Gender.MMP, Gender.UNKNOWN].forEach(g => {
        const group = valid.filter(p => genderGroup(p) === g);
        if (group.length === 0) return;
        const base = shuffle
            ? shuffled(group, random)
            : group.slice().sort((a, b) => String(a.name).localeCompare(String(b.name)));
        // Array.prototype.sort is stable, so within a position bucket the
        // shuffled (or alphabetical) order survives.
        base.sort((a, b) => positionRank(a) - positionRank(b));
        let side = squads.X.length <= squads.Y.length ? 'X' : 'Y';
        base.forEach(p => {
            squads[side].push(p.id);
            side = otherSquad(side);
        });
    });
    return squads;
}

// ── grouping the halves back together ───────────────────────────────────

/** Epoch ms of a Game's or a game summary's start, 0 when unknown. */
function gameStartMs(game) {
    const raw = game?.gameStartTimestamp ?? game?.game_start_timestamp;
    if (!raw) return 0;
    const ms = raw instanceof Date ? raw.getTime() : new Date(raw).getTime();
    return isNaN(ms) ? 0 : ms;
}

/** The score a squad-game holds for one side; `scores.team` / `scores.opponent`. */
function scoreOf(game, side) {
    const n = game?.scores?.[side];
    return typeof n === 'number' && !isNaN(n) ? n : 0;
}

/**
 * Group squad-games (Games or server summaries) into scrimmages, newest
 * first. Tolerates a missing half — a deleted squad-game leaves a one-squad
 * card rather than hiding the survivor — and a half without a squad letter
 * (never written by this client, but the JSON is schema-loose) takes the
 * first free slot.
 *
 * @param {Array<object>} games
 * @returns {Array<{id: string, name: string|null, startTs: number,
 *                  games: Array<object>, squads: {X?: object, Y?: object}}>}
 */
function groupScrimmages(games) {
    const byId = new Map();
    (games || []).forEach(g => {
        if (!isScrimmageGame(g)) return;
        let s = byId.get(g.scrimmageId);
        if (!s) {
            s = { id: g.scrimmageId, name: null, startTs: 0, games: [], squads: {} };
            byId.set(g.scrimmageId, s);
        }
        s.games.push(g);
        if (!s.name && g.scrimmageName) s.name = g.scrimmageName;
        const preferred = SQUADS.includes(g.scrimmageSquad) ? g.scrimmageSquad : 'X';
        const slot = !s.squads[preferred] ? preferred
            : (!s.squads[otherSquad(preferred)] ? otherSquad(preferred) : null);
        if (slot) s.squads[slot] = g;
        s.startTs = Math.max(s.startTs, gameStartMs(g));
    });
    return [...byId.values()].sort((a, b) => b.startTs - a.startTs);
}

/**
 * Squad names for a grouped scrimmage — read from whichever half exists.
 * @param {{squads: {X?: object, Y?: object}}} scrimmage
 * @returns {{X: string, Y: string}}
 */
function scrimmageSquadNames(scrimmage) {
    const { X, Y } = scrimmage.squads || {};
    return {
        X: (X && X.team) || (Y && Y.opponent) || DEFAULT_SQUAD_NAMES.X,
        Y: (Y && Y.team) || (X && X.opponent) || DEFAULT_SQUAD_NAMES.Y,
    };
}

/** How many points a squad-game has started: `points_count` on a summary, `points` on a Game. */
function pointsStarted(game) {
    if (!game) return 0;
    if (typeof game.points_count === 'number') return game.points_count;
    return Array.isArray(game.points) ? game.points.length : 0;
}

/**
 * The score of a scrimmage as its two halves report it. Each squad-game
 * carries the full score from its own side, so once both coaches are
 * recording the two should mirror each other; `agree` is false when they
 * don't (one coach missed a point), and the card says so rather than picking
 * a winner. A half with no points yet is simply not being tracked (the other
 * coach hasn't started, or only one coach is keeping stats), so it never
 * counts as a disagreement; `score` is the scrimmage score from squad X's
 * side as best known — the tracked half's, or 0–0.
 * @param {{squads: {X?: object, Y?: object}}} scrimmage
 * @returns {{X: {us: number, them: number}|null, Y: {us: number, them: number}|null,
 *            tracked: {X: boolean, Y: boolean}, agree: boolean, score: {us: number, them: number}}}
 */
function scrimmageScores(scrimmage) {
    const read = g => (g ? { us: scoreOf(g, 'team'), them: scoreOf(g, 'opponent') } : null);
    const squads = scrimmage.squads || {};
    const X = read(squads.X);
    const Y = read(squads.Y);
    const tracked = { X: pointsStarted(squads.X) > 0, Y: pointsStarted(squads.Y) > 0 };
    const agree = !X || !Y || !tracked.X || !tracked.Y || (X.us === Y.them && X.them === Y.us);
    const score = (tracked.X || !tracked.Y || !Y)
        ? (X || (Y ? { us: Y.them, them: Y.us } : { us: 0, them: 0 }))
        : { us: Y.them, them: Y.us };
    return { X, Y, tracked, agree, score };
}

/** "Scrimmage 09/27/26", or the coach's own label when one was given. */
function scrimmageLabel(scrimmage) {
    if (scrimmage.name) return scrimmage.name;
    return scrimmage.startTs ? `Scrimmage ${formatShortDate(scrimmage.startTs)}` : 'Scrimmage';
}

/** True once every present half has ended. */
function isScrimmageOver(scrimmage) {
    return (scrimmage.games || []).every(g => !!(g.gameEndTimestamp || g.game_end_timestamp));
}

export {
    SQUADS, DEFAULT_SQUAD_NAMES,
    isScrimmageGame, withoutScrimmages, otherSquad,
    normalizeSquadNames, generateScrimmageId, formatShortDate,
    squadGameFields, buildSquadSnapshot, squadRoster, splitSquads,
    gameStartMs, groupScrimmages, scrimmageSquadNames, scrimmageScores,
    scrimmageLabel, isScrimmageOver,
};
