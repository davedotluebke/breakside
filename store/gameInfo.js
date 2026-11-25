/*
 * Game info and game status — pure leaf module (no imports; pattern:
 * store/pointClock.js) shared by the coach's Game Settings screen, the game
 * timer, the Review screen and the share viewer, and pinned by
 * tests/unit/gameInfo.test.mjs. See ARCHITECTURE.md § Game info and status.
 *
 * Game info is five optional facts about a game, all null until a coach
 * fills them in, and nothing is shown for a blank one:
 *   gameTo          target score (e.g. 13)
 *   softCapMinutes  soft cap, minutes after the start
 *   hardCapMinutes  hard cap, minutes after the start (a game may have a hard
 *                   cap and no soft cap)
 *   scheduledStart  ISO timestamp of the round's scheduled start
 *   fieldName       free text ("4", "Stadium")
 * Cap minutes count from scheduledStart when it is set, otherwise from
 * gameStartTimestamp (when the coach tapped Start Game).
 *
 * Game status is what the share viewer's badge says about a game in
 * progress. It is derived, never stored: from the game's events, the point
 * clock's stop reason, and the clock on the wall for the caps.
 */

export const GAME_INFO_FIELDS = Object.freeze([
    'gameTo', 'softCapMinutes', 'hardCapMinutes', 'scheduledStart', 'fieldName',
]);

const MAX_SCORE = 99;
const MAX_CAP_MINUTES = 600;
const MAX_FIELD_NAME = 40;

function positiveInt(value, max) {
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    const i = Math.round(n);
    return i >= 1 && i <= max ? i : null;
}

function toMs(value) {
    if (value === null || value === undefined || value === '') return NaN;
    if (value instanceof Date) return value.getTime();
    if (typeof value === 'number') return value;
    return Date.parse(value);
}

/** The five fields off any game-shaped object, each valid or null. */
export function normalizeGameInfo(raw) {
    const src = raw || {};
    const startMs = toMs(src.scheduledStart);
    const field = typeof src.fieldName === 'string' ? src.fieldName.trim().slice(0, MAX_FIELD_NAME) : '';
    return {
        gameTo: positiveInt(src.gameTo, MAX_SCORE),
        softCapMinutes: positiveInt(src.softCapMinutes, MAX_CAP_MINUTES),
        hardCapMinutes: positiveInt(src.hardCapMinutes, MAX_CAP_MINUTES),
        scheduledStart: Number.isFinite(startMs) ? new Date(startMs).toISOString() : null,
        fieldName: field || null,
    };
}

/** Copy normalized game info onto a game (missing fields become null). */
export function applyGameInfo(game, raw) {
    if (!game) return game;
    return Object.assign(game, normalizeGameInfo(raw));
}

/**
 * When the caps fall, in epoch ms (null for a cap that is not set).
 * `scheduled` says the times hang off the scheduled start, i.e. they are
 * the published clock times and not just "N minutes after we began".
 */
export function capTimes(game) {
    const info = normalizeGameInfo(game);
    const scheduledMs = toMs(info.scheduledStart);
    const scheduled = Number.isFinite(scheduledMs);
    const baseMs = scheduled ? scheduledMs : toMs(game && game.gameStartTimestamp);
    const at = minutes => (minutes && Number.isFinite(baseMs)) ? baseMs + minutes * 60000 : null;
    return {
        baseMs: Number.isFinite(baseMs) ? baseMs : null,
        scheduled,
        softAt: at(info.softCapMinutes),
        hardAt: at(info.hardCapMinutes),
    };
}

/** "1:00 PM" in the reader's own time zone. */
export function formatClockTime(ms) {
    if (!Number.isFinite(ms)) return '';
    return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/**
 * The filled-in facts as display parts, in reading order. Each part is
 * { key, text, small } where `small` is the clock time that goes in smaller
 * type after the text (only when a scheduled start gives the caps one).
 */
export function gameInfoParts(game, formatTime = formatClockTime) {
    const info = normalizeGameInfo(game);
    const caps = capTimes(game);
    const parts = [];
    if (info.gameTo) parts.push({ key: 'gameTo', text: `Game to ${info.gameTo}`, small: null });
    if (caps.scheduled) {
        const start = formatTime(caps.baseMs);
        const end = caps.hardAt ? formatTime(caps.hardAt) : null;
        parts.push({ key: 'scheduled', text: end ? `${start} – ${end}` : `Starts ${start}`, small: null });
    }
    if (info.softCapMinutes) {
        parts.push({
            key: 'softCap', text: `Soft cap ${info.softCapMinutes} min`,
            small: caps.scheduled ? formatTime(caps.softAt) : null,
        });
    }
    if (info.hardCapMinutes) {
        parts.push({
            key: 'hardCap', text: `Hard cap ${info.hardCapMinutes} min`,
            small: caps.scheduled ? formatTime(caps.hardAt) : null,
        });
    }
    if (info.fieldName) {
        // "4" reads better as "Field 4"; "Stadium field" already says it.
        const named = /field/i.test(info.fieldName) ? info.fieldName : `Field ${info.fieldName}`;
        parts.push({ key: 'field', text: named, small: null });
    }
    return parts;
}

// -----------------------------------------------------------------------------
// Game status
// -----------------------------------------------------------------------------

/** tone: 'final' | 'stopped' (play is halted) | 'live'. */
const STATUS = Object.freeze({
    final:    { key: 'final',    label: 'Final',     tone: 'final' },
    timeout:  { key: 'timeout',  label: 'Timeout',   tone: 'stopped' },
    injury:   { key: 'injury',   label: 'Injury',    tone: 'stopped' },
    paused:   { key: 'paused',   label: 'Paused',    tone: 'stopped' },
    halftime: { key: 'halftime', label: 'Halftime',  tone: 'stopped' },
    universe: { key: 'universe', label: 'Universe',  tone: 'live' },
    hardCap:  { key: 'hardCap',  label: 'Hard cap',  tone: 'live' },
    softCap:  { key: 'softCap',  label: 'Soft cap',  tone: 'live' },
    half2:    { key: 'half2',    label: '2nd half',  tone: 'live' },
    live:     { key: 'live',     label: 'Live',      tone: 'live' },
});

const STOP_REASON_STATUS = { timeout: STATUS.timeout, injury: STATUS.injury, manual: STATUS.paused };

function pointEvents(point) {
    const out = [];
    ((point && point.possessions) || []).forEach(poss => {
        ((poss && poss.events) || []).forEach(e => { if (e) out.push(e); });
    });
    return out;
}

const concluded = point => !!(point && point.winner);

/** A stoppage in the point being played, or null while play is on. */
function stoppageStatus(point) {
    if (!point || concluded(point)) return null;
    // The point clock's own stop reason is the truth where we have it: it
    // clears when the coach restarts the clock, with or without a new play.
    // A share payload from a backend that does not publish it has no such
    // key at all, and then the log decides: stopped while a timeout or an
    // injury sub is the last thing recorded.
    if ('clockStopped' in point) {
        return STOP_REASON_STATUS[point.clockStopped] || null;
    }
    const events = pointEvents(point);
    const last = events[events.length - 1];
    if (last && last.timeout_flag) return STATUS.timeout;
    if (last && last.injury_flag) return STATUS.injury;
    return null;
}

/** Between points: a halftime or a timeout called since the last score. */
function breakStatus(point) {
    if (!concluded(point)) return null;
    const events = pointEvents(point);
    const last = events[events.length - 1];
    if (last && last.timeout_flag) return STATUS.timeout;
    if (events.some(e => e.halftime_flag)) return STATUS.halftime;
    return null;
}

function scoreOf(game, side) {
    const n = Number(game && game.scores && game.scores[side]);
    return Number.isFinite(n) ? n : 0;
}

/**
 * The score a cap applies to: the score once the point in progress when the
 * cap fell is over. `null` while that point is still being played, or when
 * the per-point winners do not add up to the game's score (two-point plays),
 * in which case no capped target is claimed.
 */
function scoreAtCap(game, capAt) {
    const points = (game && game.points) || [];
    let team = 0, opponent = 0;
    for (let i = 0; i < points.length; i++) {
        const point = points[i];
        const endMs = toMs(point.endTimestamp);
        const over = concluded(point) && Number.isFinite(endMs);
        if (over && endMs < capAt) {
            if (point.winner === 'team') team++;
            else if (point.winner === 'opponent') opponent++;
            continue;
        }
        // The first point not finished before the cap.
        const startMs = toMs(point.startTimestamp);
        const startedAfterCap = Number.isFinite(startMs) && startMs > capAt
            && !pointEvents(point).some(e => Number.isFinite(toMs(e.at)) && toMs(e.at) <= capAt);
        if (startedAfterCap && i > 0) break;            // the cap fell between points
        if (!concluded(point)) return null;             // still playing it out
        if (point.winner === 'team') team++;
        else if (point.winner === 'opponent') opponent++;
        break;
    }
    // Sanity: counted winners can never exceed the real score.
    if (team > scoreOf(game, 'team') || opponent > scoreOf(game, 'opponent')) return null;
    return { team, opponent };
}

/**
 * What the game is doing right now.
 * @param {object} game  hydrated or model game
 * @param {number} now   epoch ms
 * @returns {{key: string, label: string, tone: 'final'|'stopped'|'live'}}
 */
export function gameStatus(game, now = Date.now()) {
    if (!game) return STATUS.live;
    if (game.gameEndTimestamp) return STATUS.final;

    const points = game.points || [];
    const latest = points[points.length - 1] || null;

    const stopped = stoppageStatus(latest) || breakStatus(latest);
    if (stopped) return stopped;

    const info = normalizeGameInfo(game);
    const caps = capTimes(game);
    const team = scoreOf(game, 'team');
    const opponent = scoreOf(game, 'opponent');
    const softOn = caps.softAt !== null && now >= caps.softAt;
    const hardOn = caps.hardAt !== null && now >= caps.hardAt;

    // Soft cap: finish the point, then play to the higher score plus one,
    // never past the game-to score.
    let target = info.gameTo;
    if (softOn) {
        const atCap = scoreAtCap(game, caps.softAt);
        if (atCap) {
            const capped = Math.max(atCap.team, atCap.opponent) + 1;
            target = target ? Math.min(target, capped) : capped;
        }
    }
    let universe = !!target && team === target - 1 && opponent === target - 1;
    // Hard cap: finish the point; a tie plays one more.
    if (hardOn && !universe) {
        const atCap = scoreAtCap(game, caps.hardAt);
        universe = !!atCap && atCap.team === atCap.opponent && team === opponent;
    }

    if (universe) return STATUS.universe;
    if (hardOn) return STATUS.hardCap;
    if (softOn) return STATUS.softCap;

    const halftimeCalled = points.some(p => pointEvents(p).some(e => e.halftime_flag));
    return halftimeCalled ? STATUS.half2 : STATUS.live;
}
