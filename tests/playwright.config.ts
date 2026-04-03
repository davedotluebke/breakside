import { defineConfig } from '@playwright/test';
import path from 'path';

const FRONTEND_PORT = 3099;
const BACKEND_PORT = 8100;
const ROOT = path.resolve(__dirname, '..');

export default defineConfig({
  testDir: './scenarios',
  timeout: 30_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,   // keep sequential — multi-coach tests share server state
  retries: 0,
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
