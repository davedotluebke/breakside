/*
 * Squad narration — pure resolution helpers.
 *
 * Turns the backend's answer (/api/narration/squads) into the scrimmage
 * picker's next state: the assignment (player id → squad), who is not here,
 * and who the coach placed. Also picks the players for a narrated count
 * ("two more FMPs on Dark"), deals for a voiced Auto ("auto the rest"), works
 * out what changed for the toast, and builds the toast. Free of browser and app-module dependencies so
 * tests/unit/squadResolve.test.mjs can import it under plain node.
 */
import { matchRosterPlayer, displayFirstName, shortfallText } from './lineupResolve.js';
import { pickForSquad, autoFillSquads } from '../store/scrimmage.js';

const SQUADS = ['X', 'Y'];
const AUTO_GROUPS = ['ANY', 'FMP', 'MMP'];

/** Does a player belong to a narrated group ('FMP' | 'MMP' | 'ANY')? */
function inGroup(player, group) {
    return group === 'ANY' || player.gender === group;
}

/**
 * Resolve the backend's answer against the picker as it stands.
 *
 * The server returns the FULL resulting squads (its current squads ± what
 * the coach said), so the assignment is a plain replacement: a player on
 * neither list is off both squads. On top of that:
 *
 *   - a narrated sit-out (`out`) unticks the player's "here" box, so Auto,
 *     a later "everyone else" and a narrated count all leave them alone;
 *     a player the coach puts on a squad is here, whatever the box said;
 *   - players the coach named (`voiced_assign`) are pinned — placed by the
 *     coach, not dealt by Auto — and a voiced clear un-pins everyone first;
 *   - each `fill` ("N more <group> on <squad>") is picked here, by the same
 *     balance rules as the Auto button (store/scrimmage.js pickForSquad),
 *     from players who are here, in the group and not pinned. The picks are
 *     pinned too: the coach asked for them;
 *   - each `voiced_auto` group ("auto the rest" → 'ANY', "auto-pick the
 *     FMPs" → 'FMP') is the Auto button by voice, last of all: everyone who
 *     is here and on neither squad is dealt by the button's own code
 *     (store/scrimmage.js autoFillSquads), around whoever is already
 *     placed. A gender group deals only that group, evenly between the
 *     squads (balanced against the group's own members, so "auto the FMPs"
 *     gives each squad the same number of FMPs whatever else is on them).
 *     Like the button's, these picks are NOT pinned.
 *
 * The roster matcher is lineupResolve's (exact → case → nickname → unique
 * normalized), so a name the model cleaned of its jersey number still lands.
 *
 * @param {{squads?: {X?: string[], Y?: string[]}, out?: string[], unmatched?: string[],
 *          fills?: Array<{squad: 'X'|'Y', group: string, count: number}>,
 *          voiced_auto?: string[],
 *          voiced_assign?: Array<{name: string, squad: string}>, voiced_clear?: boolean}} data
 * @param {{roster: Array<{id: string, name: string, nickname?: string, gender?: string}>,
 *          assignment: Map<string, 'X'|'Y'>, absent?: Set<string>, pinned?: Set<string>}} ctx
 * @param {{priorityOrder?: string[], random?: () => number}} [opts] - for the fills
 * @returns {{assignment: Map<string, 'X'|'Y'>, absent: Set<string>, pinned: Set<string>,
 *            moved: {X: string[], Y: string[]}, removed: string[], unmatched: string[],
 *            counts: {X: number, Y: number},
 *            shortfalls: Array<{squad: 'X'|'Y', group: string, wanted: number, got: number}>,
 *            autoEmpty: string[]}}
 *   moved / removed are display-ready first names, in roster order;
 *   autoEmpty lists the voiced Auto groups that found nobody left to deal.
 */
function resolveSquadResult(data, ctx, opts = {}) {
    const roster = ctx.roster || [];
    const before = ctx.assignment || new Map();
    let next = new Map();
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

    // Who is not here: as the picker had it, plus anyone voiced off, minus
    // anyone now on a squad.
    const absent = new Set(ctx.absent || []);
    ((data && data.out) || []).forEach(name => {
        const player = matchRosterPlayer(name, roster);
        if (player && !next.has(player.id)) absent.add(player.id);
    });
    next.forEach((_, id) => absent.delete(id));

    // Who the coach placed.
    const pinned = (data && data.voiced_clear === true) ? new Set() : new Set(ctx.pinned || []);
    ((data && data.voiced_assign) || []).forEach(entry => {
        const player = matchRosterPlayer(entry && entry.name, roster);
        if (player) pinned.add(player.id);
    });

    // Narrated counts, in spoken order.
    const shortfalls = [];
    ((data && data.fills) || []).forEach(fill => {
        if (!fill || !SQUADS.includes(fill.squad) || !(fill.count > 0)) return;
        const here = roster.filter(p => !absent.has(p.id));
        const { picked, assignment } = pickForSquad(here, next, {
            squad: fill.squad,
            count: fill.count,
            eligible: p => !pinned.has(p.id) && inGroup(p, fill.group),
            priorityOrder: opts.priorityOrder,
            random: opts.random,
        });
        next = assignment;
        picked.forEach(id => pinned.add(id));
        if (picked.length < fill.count) {
            shortfalls.push({ squad: fill.squad, group: fill.group, wanted: fill.count, got: picked.length });
        }
    });
    [...pinned].forEach(id => { if (!next.has(id)) pinned.delete(id); });

    // A voiced Auto, after everything the coach placed by name or number.
    const autoEmpty = [];
    const autoGroups = ((data && data.voiced_auto) || []).filter(g => AUTO_GROUPS.includes(g));
    [...new Set(autoGroups)].forEach(group => {
        const dealt = roster.filter(p => !absent.has(p.id) && inGroup(p, group));
        if (!dealt.some(p => !next.has(p.id))) {
            autoEmpty.push(group);
            return;
        }
        const squads = autoFillSquads(dealt, next, { priorityOrder: opts.priorityOrder, random: opts.random });
        SQUADS.forEach(squad => squads[squad].forEach(id => next.set(id, squad)));
    });

    const moved = { X: [], Y: [] };
    const removed = [];
    roster.forEach(p => {
        const was = before.get(p.id) || null;
        const now = next.get(p.id) || null;
        // Voiced off while on neither squad: nothing moved, but the "here"
        // box changed, and the coach should see their words were taken.
        const newlyOut = absent.has(p.id) && !(ctx.absent && ctx.absent.has(p.id));
        if (was === now) {
            if (newlyOut) removed.push(displayFirstName(p.name));
            return;
        }
        if (now) moved[now].push(displayFirstName(p.name));
        else removed.push(displayFirstName(p.name));
    });

    const counts = { X: 0, Y: 0 };
    next.forEach(squad => { counts[squad] += 1; });

    const modelUnmatched = Array.isArray(data && data.unmatched) ? data.unmatched.map(String) : [];
    return {
        assignment: next, absent, pinned, moved, removed,
        unmatched: modelUnmatched.concat(unmatched), counts, shortfalls, autoEmpty,
    };
}

/**
 * The toast shown after a voice action changes the squads. Sideline-short:
 *   "Orange 5 · Black 4. To Orange: Alice, Bob. To Black: Dana"
 *   "Orange 4 · Black 4. Out: Eve"
 *   "Orange 5 · Black 3. To Orange: Alice. No match: \"Zeb\""
 *   "Orange 5 · Black 3. To Orange: Mia. Only 1 of 2 FMPs free for Orange"
 *   "Orange 8 · Black 8. Auto found nobody left to place"
 * Success when everything matched, every count was filled and a voiced Auto
 * had somebody to deal; a warning otherwise, so the coach looks at the list.
 * @param {{names: {X: string, Y: string}, counts: {X: number, Y: number},
 *          moved?: {X?: string[], Y?: string[]}, removed?: string[], unmatched?: string[],
 *          shortfalls?: Array<{squad: string, group: string, wanted: number, got: number}>,
 *          autoEmpty?: string[]}} args
 * @returns {{message: string, type: 'success'|'warning'}}
 */
function buildSquadToast({ names, counts, moved = {}, removed = [], unmatched = [], shortfalls = [], autoEmpty = [] }) {
    const fmtList = (list) => list.length > 4 ? `${list.length} players` : list.join(', ');
    const parts = [`${names.X} ${counts.X} · ${names.Y} ${counts.Y}`];
    SQUADS.forEach(squad => {
        const list = moved[squad] || [];
        if (list.length) parts.push(`To ${names[squad]}: ${fmtList(list)}`);
    });
    if (removed.length) parts.push(`Out: ${fmtList(removed)}`);
    shortfalls.forEach(s => parts.push(shortfallText(s, `free for ${names[s.squad]}`)));
    autoEmpty.forEach(group => parts.push(autoEmptySquadText(group)));
    if (unmatched.length) {
        const shown = unmatched.slice(0, 3).map(u => `"${u}"`).join(', ');
        parts.push(`No match: ${shown}${unmatched.length > 3 ? ', …' : ''}`);
    }
    const warn = unmatched.length || shortfalls.length || autoEmpty.length;
    return { message: parts.join('. '), type: warn ? 'warning' : 'success' };
}

/** What the toast says when a voiced Auto had nobody to deal. */
function autoEmptySquadText(group) {
    if (group === 'FMP' || group === 'MMP') return `Auto found no ${group}s left to place`;
    return 'Auto found nobody left to place';
}

export { resolveSquadResult, buildSquadToast, autoEmptySquadText };
