import { defineConfig } from '@playwright/test';
import path from 'path';

const FRONTEND_PORT = 3099;
const BACKEND_PORT = 8100;
const ROOT = path.resolve(__dirname, '..');

export const FRONTEND_URL = `http://localhost:${FRONTEND_PORT}`;
export const BACKEND_URL = `http://localhost:${BACKEND_PORT}`;

// URL params appended to every test navigation
export const TEST_PARAMS = `testMode=true&api=${BACKEND_URL}`;

export default defineConfig({
  testDir: './scenarios',
  timeout: 30_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,   // keep sequential — multi-coach tests share server state
  retries: 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  outputDir: 'test-results',
  use: {
    baseURL: FRONTEND_URL,
    screenshot: 'only-on-failure',
    trace: 'on-first-retry',
    // Don't persist any browser state between tests
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
      // Frontend: static file server from repo root
      command: `python3 -m http.server ${FRONTEND_PORT}`,
      cwd: ROOT,
      url: `http://localhost:${FRONTEND_PORT}`,
      reuseExistingServer: !process.env.CI,
      timeout: 10_000,
    },
    {
      // Backend: FastAPI dev server with auth disabled and short test timeouts
      command: `uvicorn main:app --port ${BACKEND_PORT}`,
      cwd: path.join(ROOT, 'ultistats_server'),
      url: `http://localhost:${BACKEND_PORT}/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 15_000,
      env: {
        ULTISTATS_AUTH_REQUIRED: 'false',
        ULTISTATS_DATA_DIR: path.join(ROOT, 'tests', 'test-data-dir'),
        BREAKSIDE_STALE_TIMEOUT: '5',
        BREAKSIDE_HANDOFF_EXPIRY: '3',
      },
    },
  ],
});
