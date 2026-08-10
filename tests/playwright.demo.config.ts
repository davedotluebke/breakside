/**
 * Playwright config for recording the tutorial/demo video clips.
 *
 *   npx playwright test --config=playwright.demo.config.ts
 *   npx playwright test --config=playwright.demo.config.ts demo/quickstart.spec.ts
 *
 * Kept separate from playwright.config.ts on purpose: the demo specs are slow,
 * choreographed, and produce video — they must never run in the e2e suite or
 * the pre-merge hook. The default config's testDir is ./scenarios, so nothing
 * under ./demo is reachable from it.
 *
 * Ports are the same per-worktree derived pair the e2e suite uses, so a demo
 * run reuses (or starts) the same servers. See helpers/constants.ts.
 */
import { defineConfig } from '@playwright/test';
import path from 'path';
import { FRONTEND_PORT, BACKEND_PORT } from './helpers/constants';

const ROOT = path.resolve(__dirname, '..');

export default defineConfig({
  testDir: './demo',
  testMatch: '**/*.spec.ts',
  // Wipe demo-data-dir each run — see demo-global-setup.ts.
  globalSetup: './demo-global-setup.ts',

  // Human pacing is slow — the Field demo alone ran ~35s of choreography on top
  // of off-camera setup. Generous, but not so generous that a wedged take eats
  // several minutes before it reports.
  timeout: 150_000,
  expect: { timeout: 10_000 },

  fullyParallel: false,
  // MANDATORY: a retry silently re-records and you ship the wrong take.
  retries: 0,
  workers: 1,

  reporter: [['list']],
  outputDir: 'demo-results',

  use: {
    baseURL: `http://localhost:${FRONTEND_PORT}`,
    // Portrait phone, matching the phone-frame presentation on the landing page.
    viewport: { width: 480, height: 960 },
    video: { mode: 'on', size: { width: 480, height: 960 } },
    screenshot: 'off',
    trace: 'off',
    storageState: undefined,
  },

  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],

  webServer: [
    {
      command: `python3 -m http.server ${FRONTEND_PORT}`,
      cwd: ROOT,
      url: `http://localhost:${FRONTEND_PORT}`,
      reuseExistingServer: true,
      timeout: 10_000,
    },
    {
      command: `uvicorn main:app --port ${BACKEND_PORT}`,
      cwd: path.join(ROOT, 'ultistats_server'),
      url: `http://localhost:${BACKEND_PORT}/health`,
      reuseExistingServer: true,
      timeout: 15_000,
      env: {
        ULTISTATS_AUTH_REQUIRED: 'false',
        ULTISTATS_DATA_DIR: path.join(ROOT, 'tests', 'demo-data-dir'),
      },
    },
  ],
});
