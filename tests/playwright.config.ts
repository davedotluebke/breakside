import { defineConfig } from '@playwright/test';
import path from 'path';
// Ports are derived per worktree (hash of repo root path) so concurrent
// worktrees can't reuse each other's servers; see helpers/constants.ts.
// Override with BREAKSIDE_E2E_FRONTEND_PORT / BREAKSIDE_E2E_BACKEND_PORT.
import { FRONTEND_PORT, BACKEND_PORT } from './helpers/constants';

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
      cwd: path.join(ROOT, 'ultistats_server'),
      url: `http://localhost:${BACKEND_PORT}/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 15_000,
      env: {
        ULTISTATS_AUTH_REQUIRED: 'false',
        ULTISTATS_DATA_DIR: path.join(ROOT, 'tests', 'test-data-dir'),
        BREAKSIDE_STALE_TIMEOUT: '5',
        BREAKSIDE_HANDOFF_EXPIRY: '10',
      },
    },
  ],
});
