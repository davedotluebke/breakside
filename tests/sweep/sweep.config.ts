/**
 * Playwright config for the theme sweep (tests/sweep/theme-sweep.spec.ts).
 *
 * A copy of tests/playwright.config.ts with a different testDir, a mobile
 * portrait viewport (the app's primary form factor), retries off and a longer
 * timeout — the sweep is one long scripted walk, not a set of independent
 * assertions, so a retry would just redo the whole thing.
 *
 * Ports come from the same per-worktree derivation as the main suite, so the
 * sweep reuses that suite's servers rather than fighting them for a port.
 */
import { defineConfig } from '@playwright/test';
import path from 'path';
import {
  FRONTEND_PORT, BACKEND_PORT, PING_INTERVAL_SOLO_MS, PING_INTERVAL_MULTI_MS, STALE_TIMEOUT_S,
} from '../helpers/constants';

const ROOT = path.resolve(__dirname, '..', '..');

// Same escape hatch as playwright.config.ts: a Chromium to launch instead of
// Playwright's own download (Claude Code cloud sessions).
const CHROMIUM = process.env.BREAKSIDE_E2E_CHROMIUM;
const launchOptions = CHROMIUM ? { launchOptions: { executablePath: CHROMIUM } } : {};

export default defineConfig({
  testDir: '.',
  timeout: 480_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  retries: 0,
  // Wipe tests/test-data-dir first: the shots are a visual baseline, so a run
  // must not inherit teams from the previous one (see tests/global-setup.ts).
  globalSetup: '../global-setup.ts',
  reporter: [['list']],
  outputDir: path.join(__dirname, 'test-results'),
  use: {
    baseURL: `http://localhost:${FRONTEND_PORT}`,
    viewport: { width: 430, height: 932 },   // iPhone 15 Pro Max portrait
    deviceScaleFactor: 2,
    screenshot: 'off',
    trace: 'off',
    ...launchOptions,
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
      cwd: path.join(ROOT, 'breakside_server'),
      url: `http://localhost:${BACKEND_PORT}/health`,
      reuseExistingServer: true,
      timeout: 15_000,
      env: {
        BREAKSIDE_AUTH_REQUIRED: 'false',
        BREAKSIDE_DATA_DIR: path.join(ROOT, 'tests', 'test-data-dir'),
        BREAKSIDE_STALE_TIMEOUT: String(STALE_TIMEOUT_S),
        BREAKSIDE_HANDOFF_EXPIRY: '10',
        // As in playwright.config.ts: production's 10s solo ping would outlast
        // the shrunken stale timeout and drop Active Coach mid-walk.
        BREAKSIDE_PING_INTERVAL_SOLO: String(PING_INTERVAL_SOLO_MS),
        BREAKSIDE_PING_INTERVAL_MULTI: String(PING_INTERVAL_MULTI_MS),
      },
    },
  ],
});
