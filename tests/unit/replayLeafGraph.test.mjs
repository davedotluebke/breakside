/*
 * The replay stack must stay importable by the public share viewer, which
 * lives on another prefix (/viewer/ on S3, /static/viewer/ on the API host)
 * and can only reach the handful of PWA directories the API mounts. So the
 * import closure of playByPlay/replayView.js is pinned to a LEAF allowlist:
 * anything that reaches store/storage.js, utils/helpers.js or a game/* module
 * would drag the whole PWA (and its localStorage / Supabase bootstrap) into
 * the viewer. See ARCHITECTURE.md § Replay viewer (share-viewer port).
 *
 * Run: node --test 'tests/unit/*.test.mjs'
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';

const ROOT = new URL('../../', import.meta.url).pathname;
const ALLOWED = new Set([
    'playByPlay/replayView.js', 'playByPlay/replayEdit.js', 'playByPlay/replayController.js',
    'playByPlay/replayEngine.js', 'playByPlay/fieldRender.js', 'playByPlay/eventAmend.js',
    'utils/gameLogRenderer.js', 'store/models.js', 'settings/advancedSettings.js',
]);

const VIEWER_ENTRY = 'breakside_server/static/viewer/viewer-replay.js';

function imports(rel) {
    const src = readFileSync(join(ROOT, rel), 'utf8');
    const out = [];
    for (const m of src.matchAll(/^import\s+(?:[^'"]*?\s+from\s+)?['"](\.[^'"]+)['"]/gm)) {
        // The viewer imports by URL: '../x' is the PWA root on S3 (/viewer/ → /)
        // and the API host's /static/ mounts of the same directories.
        const base = rel === VIEWER_ENTRY ? 'viewer' : dirname(rel);
        out.push(normalize(join(base, m[1])));
    }
    return out;
}

test('replayView.js import closure stays inside the leaf allowlist', () => {
    const seen = new Set();
    const queue = ['playByPlay/replayView.js'];
    while (queue.length) {
        const rel = queue.shift();
        if (seen.has(rel)) continue;
        seen.add(rel);
        imports(rel).forEach(d => queue.push(d));
    }
    const offenders = [...seen].filter(f => !ALLOWED.has(f));
    assert.deepEqual(offenders, [], `non-leaf modules reached from replayView.js: ${offenders.join(', ')}`);
    // And the viewer's entry module reaches nothing beyond the same set.
    const viewerSeen = new Set();
    const q2 = [VIEWER_ENTRY];
    while (q2.length) {
        const rel = q2.shift();
        if (viewerSeen.has(rel)) continue;
        viewerSeen.add(rel);
        imports(rel).forEach(d => q2.push(d));
    }
    viewerSeen.delete(VIEWER_ENTRY);
    const bad = [...viewerSeen].filter(f => !ALLOWED.has(f));
    assert.deepEqual(bad, [], `viewer-replay.js reaches: ${bad.join(', ')}`);
});
