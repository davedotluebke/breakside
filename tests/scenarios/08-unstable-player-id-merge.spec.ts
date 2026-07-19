/**
 * Unstable player-id sync merge
 *
 * Regression test for roster duplication on unmigrated teams: legacy rosters
 * stored without player ids mint fresh RANDOM ids on every deserialize, so a
 * device's local ids can differ from the server's. The player-sync merge in
 * store/sync.js used to match strictly by id and APPENDED such players as
 * duplicates. The fix falls back to unambiguous name matching and adopts the
 * server id as canonical.
 *
 * Simulates the second device by scrambling the local roster's ids in-page,
 * then running syncUserTeams against the server records the first "device"
 * pushed.
 */
import { test, expect } from '@playwright/test';
import { goToApp, setupTeamWithPlayers, DEFAULT_PLAYERS } from '../helpers/app';
import { BACKEND_URL } from '../helpers/constants';

test.describe('unstable player-id sync merge', () => {
  test('scrambled local ids merge by name instead of duplicating', async ({ page }) => {
    await goToApp(page);
    await setupTeamWithPlayers(page, 'Id Merge Team');

    // Wait until the roster has synced to the backend as individual player
    // records (that's the precondition for the merge path under test).
    const teamId = await page.evaluate(() =>
      (window as any).teams.find((t: any) => t.name === 'Id Merge Team').id);
    await expect.poll(async () => {
      const res = await page.evaluate(async (args: { url: string, teamId: string }) => {
        const r = await fetch(`${args.url}/api/teams/${args.teamId}/players`,
          { headers: { 'X-Test-User-Id': 'test-user' } });
        return r.ok ? (await r.json()).players.length : 0;
      }, { url: BACKEND_URL, teamId });
      return res;
    }, { timeout: 15_000 }).toBe(DEFAULT_PLAYERS.length);

    // Simulate a stale second device: same names, different random ids
    // (what a legacy embedded roster mints on every load).
    await page.evaluate((teamId: string) => {
      const team = (window as any).teams.find((t: any) => t.id === teamId);
      team.teamRoster.forEach((p: any, i: number) => { p.id = `${p.name}-zz${i}9`; });
      team.playerIds = team.teamRoster.map((p: any) => p.id);
    }, teamId);

    await page.evaluate(() => (window as any).syncUserTeams());

    const roster = await page.evaluate((teamId: string) => {
      const team = (window as any).teams.find((t: any) => t.id === teamId);
      return team.teamRoster.map((p: any) => ({ name: p.name, id: p.id }));
    }, teamId);

    // No duplicates — the old behavior appended a second copy of every player.
    expect(roster.length).toBe(DEFAULT_PLAYERS.length);
    expect(new Set(roster.map((p: any) => p.name)).size).toBe(DEFAULT_PLAYERS.length);

    // Local players adopted the server's canonical ids.
    const serverIds = await page.evaluate(async (args: { url: string, teamId: string }) => {
      const r = await fetch(`${args.url}/api/teams/${args.teamId}/players`,
        { headers: { 'X-Test-User-Id': 'test-user' } });
      return (await r.json()).players.map((p: any) => p.id).sort();
    }, { url: BACKEND_URL, teamId });
    expect(roster.map((p: any) => p.id).sort()).toEqual(serverIds);
    for (const p of roster) {
      expect(p.id).not.toMatch(/-zz\d9$/);
    }
  });
});
