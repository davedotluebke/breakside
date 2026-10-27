/*
 * Squad narration — pure resolution helpers.
 *
 * Maps the backend's derived squads (/api/narration/squads: player-name
 * strings per squad) onto the scrimmage picker's assignment (player id →
 * squad), works out what changed for the toast, and builds the toast.
 * Free of browser and app-module dependencies so
 * tests/unit/squadResolve.test.mjs can import it under plain node.
 */
import { matchRosterPlayer, displayFirstName } from './lineupResolve.js';

const SQUADS = ['X', 'Y'];

/**
 * Resolve the backend's squads to a picker assignment and the delta against
 * the assignment it replaces.
 *
 * The server returns the FULL resulting squads (its current squads ± the
 * voiced changes), so the result is a plain replacement: a player on neither
 * list is sitting out, whether they were voiced off or never on a squad. The
 * roster matcher is lineupResolve's (exact → case → nickname → unique
 * normalized), so a name the model cleaned of its jersey number still lands.
 *
 * @param {{squads?: {X?: string[], Y?: string[]}, out?: string[], unmatched?: string[]}} data
 * @param {{roster: Array<{id: string, name: string, nickname?: string}>,
 *          assignment: Map<string, 'X'|'Y'>}} ctx - the picker as it stands
 * @returns {{assignment: Map<string, 'X'|'Y'>, moved: {X: string[], Y: string[]},
 *            removed: string[], unmatched: string[], counts: {X: number, Y: number}}}
 *   moved / removed are display-ready first names, in roster order.
 */
function resolveSquadResult(data, { roster, assignment }) {
    const next = new Map();
    const unmatched = [];
    SQUADS.forEach(squad => {
        ((data && data.squads && data.squads[squad]) || []).forEach(name => {
            const player = matchRosterPlayer(name, roster);
            if (!player) {
                unmatched.push(String(name));
                return;
            }
            if (next.has(player.id)) return;   // listed twice: first squad wins
            next.set(player.id, squad);
        });
    });

    const moved = { X: [], Y: [] };
    const removed = [];
    (roster || []).forEach(p => {
        const before = (assignment && assignment.get(p.id)) || null;
        const after = next.get(p.id) || null;
        if (before === after) return;
        if (after) moved[after].push(displayFirstName(p.name));
        else removed.push(displayFirstName(p.name));
    });

    const counts = { X: 0, Y: 0 };
    next.forEach(squad => { counts[squad] += 1; });

    const modelUnmatched = Array.isArray(data && data.unmatched) ? data.unmatched.map(String) : [];
    return { assignment: next, moved, removed, unmatched: modelUnmatched.concat(unmatched), counts };
}

/**
 * The toast shown after a voice action changes the squads. Sideline-short:
 *   "Orange 5 · Black 4. To Orange: Alice, Bob. To Black: Dana"
 *   "Orange 4 · Black 4. Out: Eve"
 *   "Orange 5 · Black 3. To Orange: Alice. No match: \"Zeb\""
 * Success when everything matched; a warning otherwise, so the coach looks
 * at the list.
 * @param {{names: {X: string, Y: string}, counts: {X: number, Y: number},
 *          moved?: {X?: string[], Y?: string[]}, removed?: string[], unmatched?: string[]}} args
 * @returns {{message: string, type: 'success'|'warning'}}
 */
function buildSquadToast({ names, counts, moved = {}, removed = [], unmatched = [] }) {
    const fmtList = (list) => list.length > 4 ? `${list.length} players` : list.join(', ');
    const parts = [`${names.X} ${counts.X} · ${names.Y} ${counts.Y}`];
    SQUADS.forEach(squad => {
        const list = moved[squad] || [];
        if (list.length) parts.push(`To ${names[squad]}: ${fmtList(list)}`);
    });
    if (removed.length) parts.push(`Out: ${fmtList(removed)}`);
    if (unmatched.length) {
        const shown = unmatched.slice(0, 3).map(u => `"${u}"`).join(', ');
        parts.push(`No match: ${shown}${unmatched.length > 3 ? ', …' : ''}`);
    }
    return { message: parts.join('. '), type: unmatched.length ? 'warning' : 'success' };
}

export { resolveSquadResult, buildSquadToast };
