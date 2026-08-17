import fs from 'fs';
import path from 'path';
import { FRONTEND_PORT, BACKEND_PORT, REPO_ROOT } from './helpers/constants';

/**
 * Reset the demo backend's data dir before each recording run.
 *
 * Same reasoning as the e2e global setup: the demo backend uses file-based JSON
 * storage and `reuseExistingServer`, so without this every run piles more
 * "Breakside Demo" teams into the cloud list the app pulls on the select-team
 * screen. That both slows the off-camera setup and risks a stray extra team
 * appearing on camera in the clip that starts from the Teams screen.
 * (tests/demo-data-dir is gitignored.)
 */
async function demoGlobalSetup() {
  console.log(`[demo] repo root: ${REPO_ROOT}`);
  console.log(`[demo] derived ports — frontend: ${FRONTEND_PORT}, backend: ${BACKEND_PORT}`);

  const dir = path.join(__dirname, 'demo-data-dir');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
}

export default demoGlobalSetup;
