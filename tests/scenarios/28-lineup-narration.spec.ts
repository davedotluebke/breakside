/**
 * Lineup narration on the Lines tab (narration/lineupNarration.js over
 * narration/rosterNarration.js).
 *
 * The microphone, the recognizer and the model are not in an e2e's reach, so
 * the server's answer is stood in for through the layer's apply seam
 * (lineupNarration._applyResult), the way the scrimmage spec does for squad
 * narration. What is under test is everything after the answer: the returned
 * line reaches the checkboxes through the Auto button's own path, a narrated
 * count ("two more women") is filled here by Auto's rules from the right
 * gender group, a count that runs short says so, a voiced Auto ("auto the
 * rest", "auto-pick the FMPs") is the Auto button run over what was named,
 * and an answer in which nothing was heard leaves the coach's selection
 * alone.
 */
import { test, expect, Page } from '@playwright/test';
import { goToApp, setupTeamWithPlayers, startGame, DEFAULT_PLAYERS } from '../helpers/app';

const FMP = DEFAULT_PLAYERS.filter(p => p.gender === 'FMP').map(p => p.name);
const MMP = DEFAULT_PLAYERS.filter(p => p.gender === 'MMP').map(p => p.name);

/** The names ticked on the Line tab, sorted. */
async function selected(page: Page): Promise<string[]> {
  const boxes = page.locator('#panelActivePlayersTable tbody input.active-checkbox');
  await expect(boxes.first()).toBeAttached({ timeout: 8_000 });
  const names = await boxes.evaluateAll(els =>
    els.filter(e => (e as HTMLInputElement).checked).map(e => (e as HTMLElement).dataset.playerName || ''));
  return names.sort();
}

const apply = (page: Page, data: Record<string, unknown>) =>
  page.evaluate(d => (window as any).lineupNarration._applyResult(d), data);

const toast = (page: Page, text: string | RegExp) => page.locator('.toast', { hasText: text });

test.describe('lineup narration', () => {
  test('names, a narrated count, a short count, a group coming off, and nothing heard', async ({ page }) => {
    await goToApp(page);
    await setupTeamWithPlayers(page, 'Line Callers');
    await startGame(page, 'offense');
    await expect(page.locator('#panelActivePlayersTable')).toBeVisible({ timeout: 8_000 });
    expect(await selected(page)).toEqual([]);

    // The mic is the lineup layer's between points, and both layers answer
    // to the same surface (they are one factory's products).
    expect(await page.evaluate(() => (window as any).narrationMicButton._currentTargetName())).toBe('lineup');
    expect(await page.evaluate(() => {
      const w = window as any;
      return ['start', 'stop', 'toggle', 'getPhase', '_applyResult', '_narrate']
        .every(k => typeof w.lineupNarration[k] === 'function' && typeof w.squadNarration[k] === 'function');
    })).toBe(true);

    // "Alice and Bob, and two more women": the server returns the named
    // players and a fill; the Lines tab picks the two women.
    expect(await apply(page, {
      players: ['Alice', 'Bob'], unmatched: [], note: '',
      voiced_in: ['Alice', 'Bob'], voiced_out: [], voiced_clear: false, voiced_group_out: [],
      fills: [{ group: 'FMP', count: 2 }],
    })).toBe(true);
    let line = await selected(page);
    expect(line).toHaveLength(4);
    expect(line).toEqual(expect.arrayContaining(['Alice', 'Bob']));
    expect(line.filter(n => FMP.includes(n))).toHaveLength(3);
    expect(line.filter(n => MMP.includes(n))).toEqual(['Bob']);
    await expect(toast(page, '4/7 selected')).toBeVisible();

    // "Five more guys" with two on the bench: both go in, and the toast
    // says the count ran short.
    expect(await apply(page, {
      players: line, unmatched: [], note: '',
      voiced_in: [], voiced_out: [], voiced_clear: false, voiced_group_out: [],
      fills: [{ group: 'MMP', count: 5 }],
    })).toBe(true);
    line = await selected(page);
    expect(line.filter(n => MMP.includes(n)).sort()).toEqual([...MMP].sort());
    expect(line).toHaveLength(6);
    await expect(toast(page, 'Only 2 of 5 MMPs available')).toBeVisible();

    // "The guys come off": the server has already taken them off the line.
    const women = line.filter(n => FMP.includes(n));
    expect(await apply(page, {
      players: women, unmatched: [], note: '',
      voiced_in: [], voiced_out: [], voiced_clear: false, voiced_group_out: ['MMP'], fills: [],
    })).toBe(true);
    expect(await selected(page)).toEqual([...women].sort());
    await expect(toast(page, /3\/7 selected\. Off: /)).toBeVisible();

    // Nothing lineup-related heard: the selection is left exactly as it was.
    expect(await apply(page, {
      players: [], unmatched: [], note: '',
      voiced_in: [], voiced_out: [], voiced_clear: false, voiced_group_out: [], fills: [],
    })).toBe(false);
    expect(await selected(page)).toEqual([...women].sort());
    await expect(toast(page, 'No lineup heard')).toBeVisible();

    // A group voiced off that empties the line is honoured, not mistaken
    // for "nothing heard".
    expect(await apply(page, {
      players: [], unmatched: [], note: '',
      voiced_in: [], voiced_out: [], voiced_clear: false, voiced_group_out: ['FMP'], fills: [],
    })).toBe(true);
    expect(await selected(page)).toEqual([]);

    // An ungendered count on an empty line: Auto picks three of anyone.
    expect(await apply(page, {
      players: [], unmatched: [], note: '',
      voiced_in: [], voiced_out: [], voiced_clear: false, voiced_group_out: [],
      fills: [{ group: 'ANY', count: 3 }],
    })).toBe(true);
    expect(await selected(page)).toHaveLength(3);
  });

  test('a voiced Auto fills the line, one gender group, or nothing when the line is full', async ({ page }) => {
    await goToApp(page);
    await setupTeamWithPlayers(page, 'Auto Callers');
    await startGame(page, 'offense');
    await expect(page.locator('#panelActivePlayersTable')).toBeVisible({ timeout: 8_000 });
    const auto = (players: string[], groups: string[], extra: Record<string, unknown> = {}) => apply(page, {
      players, unmatched: [], note: '',
      voiced_in: players, voiced_out: [], voiced_clear: false, voiced_group_out: [], fills: [],
      voiced_auto: groups, ...extra,
    });

    // "Bob, and auto-pick the FMPs": Bob, plus only the women Auto chose for
    // the open slots. Six slots among six benched players, so Auto would
    // take everyone: all four women come in and no other man does.
    expect(await auto(['Bob'], ['FMP'])).toBe(true);
    let line = await selected(page);
    expect(line).toEqual(['Bob', ...FMP].sort());
    await expect(toast(page, '5/7 selected')).toBeVisible();

    // "Auto the rest" over that: the two open slots go to the benched men.
    expect(await auto(line, ['ANY'])).toBe(true);
    line = await selected(page);
    expect(line).toEqual(DEFAULT_PLAYERS.map(p => p.name).sort());
    await expect(toast(page, '7/7 selected')).toBeVisible();

    // Auto on a full line adds nobody and says so; the line is untouched.
    expect(await auto(line, ['ANY'])).toBe(true);
    expect(await selected(page)).toEqual(line);
    await expect(toast(page, 'Auto found no open slot')).toBeVisible();

    // "Wholesale. Auto the line": a clear and an Auto in one breath is a
    // line call — not "nothing heard" — and fills from empty.
    expect(await auto([], ['ANY'], { voiced_clear: true })).toBe(true);
    expect(await selected(page)).toHaveLength(7);

    // An Auto alone on an empty selection is a line call too.
    expect(await auto([], [], { voiced_clear: true })).toBe(true);
    expect(await selected(page)).toEqual([]);
    expect(await auto([], ['MMP'])).toBe(true);
    expect(await selected(page)).toEqual([...MMP].sort());
  });
});
