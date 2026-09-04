import { defineConfig } from '@playwright/test';
import path from 'path';
// Ports are derived per worktree (hash of repo root path) so concurrent
// worktrees can't reuse each other's servers; see helpers/constants.ts.
// Override with BREAKSIDE_E2E_FRONTEND_PORT / BREAKSIDE_E2E_BACKEND_PORT.
import {
  FRONTEND_PORT,
  BACKEND_PORT,
  PING_INTERVAL_SOLO_MS,
  PING_INTERVAL_MULTI_MS,
  STALE_TIMEOUT_S,
} from './helpers/constants';

const ROOT = path.resolve(__dirname, '..');

export default defineConfig({
  testDir: './scenarios',
  timeout: 30_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,   // keep sequential — multi-coach tests share server state
  retries: 2,   // multi-coach/sleep-wake tests poll timing-sensitive controller state; retry transient flakes
  globalSetup: './global-setup.ts',   // wipe test-data-dir each run so it can't accumulate across runs

  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  outputDir: 'test-results',
  use: {
    baseURL: `http://localhost:${FRONTEND_PORT}`,
    screenshot: 'only-on-failure',
    trace: 'on-first-retry',
    storageState: undefined,
  },

  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium' },
    },
  ],

  webServer: [
    {
      command: `python3 -m http.server ${FRONTEND_PORT}`,
      cwd: ROOT,
      url: `http://localhost:${FRONTEND_PORT}`,
      reuseExistingServer: !process.env.CI,
      timeout: 10_000,
    },
    {
      command: `uvicorn main:app --port ${BACKEND_PORT}`,
      cwd: path.join(ROOT, 'breakside_server'),
      url: `http://localhost:${BACKEND_PORT}/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 15_000,
      env: {
        BREAKSIDE_AUTH_REQUIRED: 'false',
        BREAKSIDE_DATA_DIR: path.join(ROOT, 'tests', 'test-data-dir'),
        BREAKSIDE_STALE_TIMEOUT: String(STALE_TIMEOUT_S),
        BREAKSIDE_HANDOFF_EXPIRY: '10',
        // Cadence is server-directed (POLLING_OPTIMIZATION.md F4). Production's
        // 10s solo interval would exceed the shrunken stale timeout above and
        // expire roles every interval, so the whole scale comes down together.
        BREAKSIDE_PING_INTERVAL_SOLO: String(PING_INTERVAL_SOLO_MS),
        BREAKSIDE_PING_INTERVAL_MULTI: String(PING_INTERVAL_MULTI_MS),
      },
    },
  ],
});
