/**
 * Teams screen arrangement: most recently opened first, with a pinned group
 * on top (store/teamListPrefs.js, teams/teamList.js).
 *
 * The pure ordering rules are pinned in tests/unit/teamListPrefs.test.mjs.
 * This drives the real screen, because the order only matters as rendered:
 * opening a team, pinning it and reloading the page must move the cards the
 * way a coach expects, and the group labels must come and go with the pins.
 */
import { test, expect, Page } from '@playwright/test';
import { TEST_PARAMS } from '../helpers/constants';
import { createTeam } from '../helpers/app';

// Own test user, so other specs' teams never show up in this list.
const COACH = 'team-pins-coach';
const ALPHA = 'Pins Alpha';
const BRAVO = 'Pins Bravo';

test.describe.configure({ timeout: 90_000 });

async function goToTeams(page: Page) {
  await page.goto(`/?${TEST_PARAMS}&testUserId=${COACH}`);
  await expect(page.locator('#selectTeamScreen')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('#splashScreen')).toHaveCount(0, { timeout: 10_000 });
}

/** Back from the roster flow to a freshly rendered teams list. */
async function backToTeams(page: Page) {
  await page.click('#backFromStartGameBtn');
  await expect(page.locator('#selectTeamScreen')).toBeVisible({ timeout: 10_000 });
}

/** Team names in the order the list shows them. */
async function listedTeams(page: Page): Promise<string[]> {
  const cards = page.locator('#cloudTeamsList .team-section');
  await expect(cards.first()).toBeVisible({ timeout: 15_000 });
  return cards.locator('.team-header-name').allTextContents();
}

function card(page: Page, name: string) {
  return page.locator('#cloudTeamsList .team-section', {
    has: page.locator('.team-header-name', { hasText: name }),
  });
}

test.describe('teams screen order and pins', () => {
  test('recently opened first, pinned group on top, pins survive a reload', async ({ page }) => {
    await goToTeams(page);

    // Creating a team counts as opening it, so the newer one leads.
    await createTeam(page, ALPHA);
    await backToTeams(page);
    await createTeam(page, BRAVO);
    await backToTeams(page);
    expect(await listedTeams(page)).toEqual([BRAVO, ALPHA]);

    // Nothing pinned yet: no group labels at all.
    await expect(page.locator('.team-group-label')).toHaveCount(0);

    // Opening Alpha (New Game leaves the teams screen for it) moves it up.
    await card(page, ALPHA).locator('.team-header').click();
    await card(page, ALPHA).locator('.new-game-btn', { hasText: 'New Game' }).click();
    await expect(page.locator('#teamRosterScreen')).toBeVisible({ timeout: 8_000 });
    await backToTeams(page);
    expect(await listedTeams(page)).toEqual([ALPHA, BRAVO]);

    // Pin Bravo: it moves into a labelled group above everything else,
    // redrawn in place without leaving the screen.
    await card(page, BRAVO).locator('.team-pin-btn').click();
    await expect(page.locator('.team-group-label')).toHaveText(['Pinned', 'Other teams']);
    expect(await listedTeams(page)).toEqual([BRAVO, ALPHA]);
    await expect(card(page, BRAVO).locator('.team-pin-btn')).toHaveAttribute('aria-pressed', 'true');
    await expect(card(page, ALPHA).locator('.team-pin-btn')).toHaveAttribute('aria-pressed', 'false');

    // The pin is per device: a reload keeps it.
    await goToTeams(page);
    expect(await listedTeams(page)).toEqual([BRAVO, ALPHA]);
    await expect(page.locator('.team-group-label').first()).toHaveText('Pinned');

    // A newly pinned team lands at the top of the pinned group.
    await card(page, ALPHA).locator('.team-pin-btn').click();
    expect(await listedTeams(page)).toEqual([ALPHA, BRAVO]);
    // Everything pinned: only the one label.
    await expect(page.locator('.team-group-label')).toHaveText(['Pinned']);

    // Unpin both: labels gone, back to most recently opened first.
    await card(page, ALPHA).locator('.team-pin-btn').click();
    await card(page, BRAVO).locator('.team-pin-btn').click();
    await expect(page.locator('.team-group-label')).toHaveCount(0);
    expect(await listedTeams(page)).toEqual([ALPHA, BRAVO]);
  });
});
