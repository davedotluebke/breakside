/**
 * Shared test constants — importable from specs without triggering config side effects.
 *
 * Per-worktree port derivation
 * ----------------------------
 * The suite used to hardcode ports 3099/8100. Combined with Playwright's
 * `reuseExistingServer`, two worktrees running the suite concurrently would
 * reuse each other's leftover dev servers — tests silently exercised another
 * branch's code (this masked, then unmasked, the `cachedEventStats` fix).
 *
 * Default ports are now derived from a stable hash of the repo root's absolute
 * path, so every worktree gets its own deterministic pair:
 *
 *   slot     = fnv1a(repoRoot) % 800
 *   frontend = 3100 + slot   → 3100–3899 (clear of dev-server.sh's default
 *              3000 and the 3001+ ports humans pick for worktree dev servers)
 *   backend  = 8200 + slot   → 8200–8999 (clear of the backend default 8000,
 *              dev-backend.sh's auto-pick range [8000,8100), and the old
 *              hardcoded 8100, so stale pre-derivation servers can't be reused)
 *
 * Overrides: set BREAKSIDE_E2E_FRONTEND_PORT / BREAKSIDE_E2E_BACKEND_PORT.
 *
 * This module MUST stay pure and deterministic: it is evaluated independently
 * by the Playwright config process and by every test worker, and all of them
 * have to agree on the same ports.
 */
import path from 'path';

/** Repo root (tests/helpers → two levels up). Same value in config + workers. */
export const REPO_ROOT = path.resolve(__dirname, '..', '..');

/** FNV-1a 32-bit hash — tiny, dependency-free, stable across processes. */
function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function envPort(name: string): number | null {
  const raw = process.env[name];
  if (!raw) return null;
  const n = parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 1024 || n > 65535) {
    throw new Error(`${name}="${raw}" is not a valid port (expected 1024–65535)`);
  }
  return n;
}

const SLOT = fnv1a(REPO_ROOT) % 800;

export const FRONTEND_PORT = envPort('BREAKSIDE_E2E_FRONTEND_PORT') ?? 3100 + SLOT;
export const BACKEND_PORT = envPort('BREAKSIDE_E2E_BACKEND_PORT') ?? 8200 + SLOT;
export const FRONTEND_URL = `http://localhost:${FRONTEND_PORT}`;
export const BACKEND_URL = `http://localhost:${BACKEND_PORT}`;
export const TEST_PARAMS = `testMode=true&api=${BACKEND_URL}`;
