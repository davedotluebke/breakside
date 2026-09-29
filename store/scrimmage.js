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
import { Gender, PlayerPosition, DefaultLine, Player, generateShortId } from './models.js';
import { shuffled } from '../utils/shuffle.js';

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

// ── editing squads after creation ───────────────────────────────────────
//
// A half's squad definition is four fields — rosterSnapshot (who is on the
// squad), team / opponent (this squad's name and the other's), scrimmageName
// (the label) — versioned together by the snapshot's capturedAt: every edit
// rewrites the whole snapshot with a fresh stamp, and the newer definition
// wins wherever two copies meet (the server's sync merge, and the in-game
// refresh below). Edits reach the server by PATCH (store/sync.js
// patchScrimmageGame), because the editing coach usually is not in the game
// they are editing and a full sync would carry their stale copy of its play
// data. See ARCHITECTURE.md § Intrasquad Scrimmages.

const SQUAD_DEFINITION_KEYS = ['rosterSnapshot', 'team', 'opponent', 'scrimmageName'];

/** Epoch ms of a squad-game's squad version (its snapshot's capturedAt); 0 when unstamped. */
function squadStamp(game) {
    const raw = game?.rosterSnapshot?.capturedAt;
    if (!raw) return 0;
    const ms = new Date(raw).getTime();
    return isNaN(ms) ? 0 : ms;
}

/** The four squad-definition fields of a game (or server document), copied. */
function squadDefinition(game) {
    return {
        rosterSnapshot: game?.rosterSnapshot ? JSON.parse(JSON.stringify(game.rosterSnapshot)) : null,
        team: game?.team ?? null,
        opponent: game?.opponent ?? null,
        scrimmageName: game?.scrimmageName || null,
    };
}

/**
 * The squad definition to adopt from a server copy of a squad-game — when the
 * server's is strictly newer than the local one; null otherwise (equal stamps
 * are this device's own copy coming back; an unstamped side has no version).
 * The in-game refresh calls this on every pull, for the Active Coach too.
 * @param {object} local - the Game this device holds
 * @param {object} server - the server's document for the same game
 * @returns {{rosterSnapshot: object, team: string, opponent: string, scrimmageName: string|null}|null}
 */
function newerSquadDefinition(local, server) {
    if (!isScrimmageGame(local) && !isScrimmageGame(server)) return null;
    const theirs = squadStamp(server);
    const ours = squadStamp(local);
    if (!theirs || !ours || theirs <= ours) return null;
    return squadDefinition(server);
}

/** Write a squad definition onto a Game (only the fields the definition carries). */
function applySquadDefinition(game, definition) {
    if (!game || !definition) return game;
    SQUAD_DEFINITION_KEYS.forEach(key => {
        if (key in definition && definition[key] !== undefined) game[key] = definition[key];
    });
    return game;
}

/** id → name for everyone on a game's (or definition's) roster snapshot. */
function snapshotNames(game) {
    const out = new Map();
    (game?.rosterSnapshot?.players || []).forEach(p => {
        if (p && p.id) out.set(p.id, p.nickname || p.name || p.id);
    });
    return out;
}

/**
 * Who is on which squad, read from the two halves' snapshots — the edit
 * dialog's starting point. A player somehow on both (never written by this
 * client) counts for X.
 * @param {{X?: object, Y?: object}} games - the two squad-games
 * @returns {Map<string, 'X'|'Y'>} playerId → squad
 */
function squadAssignments(games) {
    const assignment = new Map();
    SQUADS.forEach(squad => {
        (games?.[squad]?.rosterSnapshot?.players || []).forEach(p => {
            if (p && p.id && !assignment.has(p.id)) assignment.set(p.id, squad);
        });
    });
    return assignment;
}

/**
 * The PATCH body that turns one half's squad definition into the proposed
 * one, or null when nothing about it changes. Always the whole definition,
 * freshly stamped: the names are versioned by the snapshot's stamp, so a
 * rename re-stamps the snapshot too. Player order is not a change (both
 * sides are in roster order; a rename can reorder).
 * @param {object} game - the half as it stands
 * @param {{players: Array<object>, squadNames: {X: string, Y: string},
 *          label: string|null, now?: Date}} proposal - players: this squad's
 *          Player objects, in the order to store
 * @returns {{rosterSnapshot: object, team: string, opponent: string, scrimmageName: string|null}|null}
 */
function squadPatch(game, { players, squadNames, label, now = new Date() }) {
    const squad = SQUADS.includes(game?.scrimmageSquad) ? game.scrimmageSquad : 'X';
    const fields = squadGameFields({
        scrimmageId: game?.scrimmageId, squad, squadNames, name: label,
    });
    const before = new Set((game?.rosterSnapshot?.players || []).map(p => p && p.id).filter(Boolean));
    const after = new Set((players || []).map(p => p && p.id).filter(Boolean));
    const samePlayers = before.size === after.size && [...after].every(id => before.has(id));
    const sameNames = fields.team === (game?.team ?? null)
        && fields.opponent === (game?.opponent ?? null)
        && fields.scrimmageName === (game?.scrimmageName || null);
    if (samePlayers && sameNames) return null;
    const rosterSnapshot = buildSquadSnapshot(players, [...after], now);
    if (!rosterSnapshot) return null;   // an empty squad is not a valid edit; callers refuse it first
    return {
        rosterSnapshot,
        team: fields.team,
        opponent: fields.opponent,
        scrimmageName: fields.scrimmageName,
    };
}

/** "Bob", "Bob and Eve", "Bob, Eve and Mia". */
function listNames(names) {
    if (names.length <= 1) return names.join('');
    return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * What a coach tracking this half should be told when its squad definition
 * changes under them — the body of the toast. null when nothing they would
 * notice changed (a re-stamp of the same squad: this device's own edit
 * coming back with the server's stamp, say).
 * @param {object} before - the half (or its squad definition) before
 * @param {object} after - and after
 * @param {{pointInProgress?: boolean}} [opts] - a live point keeps its line;
 *        the squad takes effect from the next one, and the toast says so
 * @returns {string|null}
 */
function describeSquadChange(before, after, { pointInProgress = false } = {}) {
    const was = snapshotNames(before);
    const now = snapshotNames(after);
    const squadName = after?.team || before?.team || 'this squad';
    const joined = [...now].filter(([id]) => !was.has(id)).map(([, name]) => name);
    const left = [...was].filter(([id]) => !now.has(id)).map(([, name]) => name);
    const parts = [];
    if (joined.length) parts.push(`${listNames(joined)} joined ${squadName}`);
    if (left.length) parts.push(`${listNames(left)} left`);
    if (before?.team && after?.team && before.team !== after.team) {
        parts.push(`${before.team} is now ${after.team}`);
    }
    if (before?.opponent && after?.opponent && before.opponent !== after.opponent) {
        parts.push(`${before.opponent} is now ${after.opponent}`);
    }
    const oldLabel = before?.scrimmageName || null;
    const newLabel = after?.scrimmageName || null;
    if (oldLabel !== newLabel) {
        parts.push(newLabel ? `labelled “${newLabel}”` : 'label removed');
    }
    if (!parts.length) return null;
    let text = `Squads updated: ${parts.join('; ')}.`;
    if (pointInProgress && (joined.length || left.length)) {
        text += ' The point on the field keeps its line; the new squad plays from the next point.';
    }
    return text;
}

// The planned lines (game/selectLine.js) and their per-line stamps.
const PLANNED_LINE_KEYS = ['oLine', 'dLine', 'odLine', 'odOnDeckLine'];

/**
 * Drop players who are no longer on the squad from the planned lines, so a
 * departed player is not silently fielded on the next point from a line that
 * no longer shows them. Each changed line gets a fresh stamp, so the prune
 * wins the per-line merge against copies that still list them. Line entries
 * are player names (and ids, in some data eras), so both are matched.
 * @param {object} pendingNextLine - mutated in place
 * @param {object} snapshot - the squad's new rosterSnapshot
 * @param {Date} [now]
 * @returns {string[]} the entries removed, in first-seen order; [] when nothing changed
 */
function pruneLinesToSquad(pendingNextLine, snapshot, now = new Date()) {
    if (!pendingNextLine || !snapshot) return [];
    const keep = new Set();
    (snapshot.players || []).forEach(p => {
        if (!p) return;
        if (p.id) keep.add(p.id);
        if (p.name) keep.add(p.name);
        if (p.nickname) keep.add(p.nickname);
    });
    const removed = [];
    PLANNED_LINE_KEYS.forEach(key => {
        const line = pendingNextLine[key];
        if (!Array.isArray(line)) return;
        const kept = line.filter(entry => keep.has(entry));
        if (kept.length === line.length) return;
        line.filter(entry => !keep.has(entry)).forEach(entry => {
            if (!removed.includes(entry)) removed.push(entry);
        });
        pendingNextLine[key] = kept;
        pendingNextLine[`${key}ModifiedAt`] = now.toISOString();
    });
    return removed;
}

// ── dealing players onto squads ─────────────────────────────────────────
//
// The dialog's Auto button, and the deal a new scrimmage opens with. Like the
// Line tab's Auto it fills only the empty spots, one pick at a time, and
// weighs the same two things that mean anything before a game — position
// (handlers / cutters) and O/D line — in the order the coach set in Advanced
// Settings (rest and playing time are meaningless here and are skipped).
// Unlike the Line tab, which builds one line for a known side, a scrimmage
// builds two lines that should mirror each other, so each factor is read as
// balance ACROSS the squads: the squad picking prefers whoever it trails the
// other squad in. Gender comes first, as the ratio does on the Line tab.
// Ties are random, as on the Line tab (utils/shuffle.js): Clear then Auto is
// how a coach gets a fresh deal, so the same roster must not come out the
// same way twice. With no roles set this is exactly a uniform random
// balanced split (checked against one over 20,000 deals); with genders set,
// the two genders are dealt independently, so in an alphabetical list where
// they interleave, neighbours land together about half the time.

function genderGroup(player) {
    if (player.gender === Gender.FMP) return Gender.FMP;
    if (player.gender === Gender.MMP) return Gender.MMP;
    return Gender.UNKNOWN;
}

/** handler | cutter | hybrid — unset reads as hybrid (fills either), as on the Line tab. */
function positionGroup(player) {
    if (player.position === PlayerPosition.HANDLER) return PlayerPosition.HANDLER;
    if (player.position === PlayerPosition.CUTTER) return PlayerPosition.CUTTER;
    return PlayerPosition.HYBRID;
}

/** O | D | Crossover — unset reads as Crossover, as on the Line tab. */
function lineGroup(player) {
    if (player.defaultLine === DefaultLine.O) return DefaultLine.O;
    if (player.defaultLine === DefaultLine.D) return DefaultLine.D;
    return DefaultLine.CROSSOVER;
}

/** The Auto factors (Advanced Settings `autoLine.priorityOrder`) that apply before a game. */
const SQUAD_AUTO_FACTORS = ['position', 'od'];
const DEFAULT_AUTO_PRIORITY = ['position', 'rest', 'od', 'pt'];
const FACTOR_GROUP = { position: positionGroup, od: lineGroup };

/**
 * Fill the two squads with every player not on one yet, one pick at a time.
 *
 * Each pick goes to the smaller squad (X first when they are level, then
 * alternating). Among the candidates, the pick is whoever the picking squad
 * trails the other squad in the most — by gender first, then by the coach's
 * Auto factors in their order (position, O/D line; hybrid and Crossover are
 * groups of their own, so they spread evenly too), then at random. Players
 * already assigned stay where they are; the balance is judged with them
 * counted. So an empty assignment is a full deal, balanced within one in
 * every group, and a partial one is topped up around the coach's choices.
 *
 * @param {Array<object>} players - the players to deal: roster Players who
 *        are here (id, gender, position, defaultLine), in roster order
 * @param {Map<string, 'X'|'Y'>|null} assignment - who is on a squad already
 * @param {{priorityOrder?: string[], random?: () => number}} [opts] -
 *        priorityOrder as Advanced Settings gives it (keys other than
 *        position / od are ignored; a missing key goes last); random is
 *        injectable for tests
 * @returns {{X: string[], Y: string[]}} player ids per squad, in roster order
 */
function autoFillSquads(players, assignment, { priorityOrder = DEFAULT_AUTO_PRIORITY, random = Math.random } = {}) {
    const valid = (players || []).filter(p => p && p.id);
    const assigned = id => {
        const squad = assignment && typeof assignment.get === 'function' ? assignment.get(id) : null;
        return SQUADS.includes(squad) ? squad : null;
    };
    const squads = { X: [], Y: [] };       // ids
    const members = { X: [], Y: [] };      // players, for the tallies
    valid.forEach(p => {
        const squad = assigned(p.id);
        if (squad) { squads[squad].push(p.id); members[squad].push(p); }
    });
    const pool = shuffled(valid.filter(p => !assigned(p.id)), random);

    const factors = (Array.isArray(priorityOrder) ? priorityOrder : DEFAULT_AUTO_PRIORITY)
        .filter(k => SQUAD_AUTO_FACTORS.includes(k));
    SQUAD_AUTO_FACTORS.forEach(k => { if (!factors.includes(k)) factors.push(k); });
    const groups = [genderGroup, ...factors.map(k => FACTOR_GROUP[k])];

    // How far `side` is ahead of the other squad in the candidate's group:
    // negative means the side trails there, so the candidate is wanted.
    const lead = (side, group, p) => {
        const g = group(p);
        return members[side].filter(m => group(m) === g).length
            - members[otherSquad(side)].filter(m => group(m) === g).length;
    };

    let last = 'Y';   // X picks first when the squads are level
    while (pool.length) {
        const side = squads.X.length < squads.Y.length ? 'X'
            : squads.Y.length < squads.X.length ? 'Y'
            : otherSquad(last);
        let best = 0;
        for (let i = 1; i < pool.length; i++) {
            for (const group of groups) {
                const d = lead(side, group, pool[i]) - lead(side, group, pool[best]);
                if (d) { if (d < 0) best = i; break; }
            }
        }
        const [pick] = pool.splice(best, 1);
        squads[side].push(pick.id);
        members[side].push(pick);
        last = side;
    }

    const order = new Map(valid.map((p, i) => [p.id, i]));
    SQUADS.forEach(s => squads[s].sort((a, b) => order.get(a) - order.get(b)));
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
    squadGameFields, buildSquadSnapshot, squadRoster, autoFillSquads,
    gameStartMs, groupScrimmages, scrimmageSquadNames, scrimmageScores,
    scrimmageLabel, isScrimmageOver,
    SQUAD_DEFINITION_KEYS, squadStamp, squadDefinition, newerSquadDefinition,
    applySquadDefinition, squadAssignments, squadPatch, describeSquadChange,
    pruneLinesToSquad,
};
