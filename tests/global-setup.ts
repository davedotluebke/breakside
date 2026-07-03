import fs from 'fs';
import path from 'path';

/**
 * Reset the file-based backend data dir before each test run.
 *
 * The test backend (uvicorn on BACKEND_PORT) points ULTISTATS_DATA_DIR at
 * tests/test-data-dir and uses file-based JSON storage, reading fresh from disk
 * on every request. Because playwright.config uses `reuseExistingServer` when
 * not on CI, nothing ever cleared this directory between runs — so months of
 * local runs accumulated hundreds of games and thousands of player files. That
 * bloated the cloud team list the app pulls on the select-team screen and added
 * sync-queue noise to offline tests. Wiping the dir here keeps each run
 * isolated and the directory small. (test-data-dir is gitignored.)
 */
async function globalSetup() {
  const dir = path.join(__dirname, 'test-data-dir');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
}

export default globalSetup;
