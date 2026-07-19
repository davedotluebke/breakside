/*
 * Unit tests pinning the authFetch 401-retry core (store/authFetchLogic.js),
 * extracted from store/sync.js in the G4 consolidation — the restored pre-C8
 * retry variant's semantics (B2 work).
 *
 * Run: node --test tests/unit/*.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { makeAuthFetch } from '../../store/authFetchLogic.js';

// ── helpers ─────────────────────────────────────────────────────────────

function res(status) {
    return { status, ok: status >= 200 && status < 300 };
}

/**
 * Build a makeAuthFetch harness with call recording.
 * statusByToken maps a bearer token (or '' for anonymous) to the HTTP status
 * the fake server answers with.
 */
function harness({ statusByToken = {}, token = 'T1', refreshedToken = 'T2', ...overrides } = {}) {
    const calls = { fetches: [], refreshes: 0, warns: [] };
    const deps = {
        fetchFn: async (url, init) => {
            calls.fetches.push({ url, init });
            const bearer = (init.headers['Authorization'] || '').replace('Bearer ', '');
            const status = statusByToken[bearer];
            return res(status !== undefined ? status : 200);
        },
        getToken: async () => token,
        forceRefreshToken: async () => {
            calls.refreshes++;
            return refreshedToken;
        },
        warn: (...args) => calls.warns.push(args),
        ...overrides,
    };
    return { authFetch: makeAuthFetch(deps), calls };
}

const drain = () => new Promise((resolve) => setImmediate(resolve));

// ── happy path & header building ────────────────────────────────────────

test('200 with token: single fetch, bearer + forced Content-Type', async () => {
    const { authFetch, calls } = harness();
    const response = await authFetch('/api/x', {
        method: 'POST',
        body: '{"a":1}',
        headers: { 'X-Custom': 'yes', 'Content-Type': 'text/plain' },
    });
    assert.equal(response.status, 200);
    assert.equal(calls.fetches.length, 1);
    assert.equal(calls.refreshes, 0);
    const init = calls.fetches[0].init;
    assert.equal(init.method, 'POST');
    assert.equal(init.body, '{"a":1}');
    assert.equal(init.headers['Authorization'], 'Bearer T1');
    assert.equal(init.headers['X-Custom'], 'yes');
    // Content-Type is forced to application/json (surviving sync.js behavior)
    assert.equal(init.headers['Content-Type'], 'application/json');
});

test('no token: no Authorization header, and a 401 is NOT retried', async () => {
    const { authFetch, calls } = harness({
        token: null,
        statusByToken: { '': 401 },
    });
    const response = await authFetch('/api/x');
    assert.equal(response.status, 401);
    assert.equal(calls.fetches.length, 1);
    assert.equal(calls.refreshes, 0);
    assert.ok(!('Authorization' in calls.fetches[0].init.headers));
});

test('getToken rejection is not possible by contract, but a null token falls back to anonymous', async () => {
    const { authFetch, calls } = harness({ token: null });
    const response = await authFetch('/api/x');
    assert.equal(response.status, 200);
    assert.ok(!('Authorization' in calls.fetches[0].init.headers));
});

// ── 401 retry ───────────────────────────────────────────────────────────

test('401 with stale token: one refresh, one retry with fresh bearer, retry response returned', async () => {
    const { authFetch, calls } = harness({
        statusByToken: { T1: 401, T2: 200 },
    });
    const response = await authFetch('/api/x', { method: 'PUT', body: '{"b":2}' });
    assert.equal(response.status, 200);
    assert.equal(calls.refreshes, 1);
    assert.equal(calls.fetches.length, 2);
    assert.equal(calls.fetches[0].init.headers['Authorization'], 'Bearer T1');
    assert.equal(calls.fetches[1].init.headers['Authorization'], 'Bearer T2');
    // method/body replayed identically
    assert.equal(calls.fetches[1].init.method, 'PUT');
    assert.equal(calls.fetches[1].init.body, '{"b":2}');
});

test('retry also 401s: returns the second 401, exactly one refresh + two fetches (no loop)', async () => {
    const { authFetch, calls } = harness({
        statusByToken: { T1: 401, T2: 401 },
    });
    const response = await authFetch('/api/x');
    assert.equal(response.status, 401);
    assert.equal(calls.refreshes, 1);
    assert.equal(calls.fetches.length, 2);
});

test('refresh yields null (signed out / test mode / Supabase down): original 401 returned, no retry', async () => {
    const { authFetch, calls } = harness({
        statusByToken: { T1: 401 },
        refreshedToken: null,
    });
    const response = await authFetch('/api/x');
    assert.equal(response.status, 401);
    assert.equal(calls.refreshes, 1);
    assert.equal(calls.fetches.length, 1);
});

test('refresh returning the SAME token: no pointless retry', async () => {
    const { authFetch, calls } = harness({
        statusByToken: { T1: 401 },
        refreshedToken: 'T1',
    });
    const response = await authFetch('/api/x');
    assert.equal(response.status, 401);
    assert.equal(calls.refreshes, 1);
    assert.equal(calls.fetches.length, 1);
});

test('refresh rejection is swallowed: warns, returns original 401', async () => {
    const { authFetch, calls } = harness({
        statusByToken: { T1: 401 },
        forceRefreshToken: async () => { throw new Error('supabase down'); },
    });
    const response = await authFetch('/api/x');
    assert.equal(response.status, 401);
    assert.equal(calls.fetches.length, 1);
    assert.equal(calls.warns.length, 1);
});

test('retry fetch throwing: original 401 returned, not a rejection', async () => {
    let fetchCount = 0;
    const { authFetch, calls } = harness({
        fetchFn: async (url, init) => {
            fetchCount++;
            if (fetchCount === 1) return res(401);
            throw new TypeError('network dropped mid-retry');
        },
    });
    const response = await authFetch('/api/x');
    assert.equal(response.status, 401);
    assert.equal(fetchCount, 2);
    assert.equal(calls.warns.length, 1);
});

test('non-401 error statuses (403/500) are never retried', async () => {
    for (const status of [403, 500]) {
        const { authFetch, calls } = harness({ statusByToken: { T1: status } });
        const response = await authFetch('/api/x');
        assert.equal(response.status, status);
        assert.equal(calls.fetches.length, 1);
        assert.equal(calls.refreshes, 0);
    }
});

// ── body replayability ──────────────────────────────────────────────────

test('ReadableStream body cannot be replayed: 401 returned as-is, no refresh/retry', async () => {
    const { authFetch, calls } = harness({
        statusByToken: { T1: 401, T2: 200 },
    });
    const body = new ReadableStream({ start(c) { c.enqueue('x'); c.close(); } });
    const response = await authFetch('/api/x', { method: 'POST', body });
    assert.equal(response.status, 401);
    assert.equal(calls.fetches.length, 1);
    assert.equal(calls.refreshes, 0);
});

test('plain string body IS replayed on retry', async () => {
    const { authFetch, calls } = harness({
        statusByToken: { T1: 401, T2: 200 },
    });
    const response = await authFetch('/api/x', { method: 'POST', body: JSON.stringify({ url: 'x' }) });
    assert.equal(response.status, 200);
    assert.equal(calls.fetches[1].init.body, '{"url":"x"}');
});

// ── concurrent-401 single-flight refresh ────────────────────────────────

test('concurrent 401s share ONE refresh (no stampede), both retry with the fresh token', async () => {
    let resolveRefresh;
    let refreshes = 0;
    const fetches = [];
    const deps = {
        fetchFn: async (url, init) => {
            fetches.push(init.headers['Authorization']);
            return res(init.headers['Authorization'] === 'Bearer T2' ? 200 : 401);
        },
        getToken: async () => 'T1',
        forceRefreshToken: () => {
            refreshes++;
            return new Promise((r) => { resolveRefresh = r; });
        },
        warn: () => {},
    };
    const authFetch = makeAuthFetch(deps);

    const p1 = authFetch('/api/a');
    const p2 = authFetch('/api/b');
    // Let both calls hit their first 401 and reach the refresh gate
    await drain();
    await drain();
    assert.equal(refreshes, 1, 'both 401s must share a single refresh');
    resolveRefresh('T2');

    const [r1, r2] = await Promise.all([p1, p2]);
    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200);
    assert.equal(refreshes, 1);
    // 2 first attempts with T1 + 2 retries with T2
    assert.deepEqual(fetches.sort(), ['Bearer T1', 'Bearer T1', 'Bearer T2', 'Bearer T2']);
});

test('sequential 401s (after the shared refresh settled) each get their own refresh', async () => {
    const { authFetch, calls } = harness({
        statusByToken: { T1: 401, T2: 200 },
    });
    await authFetch('/api/a');
    await authFetch('/api/a');
    // Both calls used stale T1 first (getToken still returns T1 in this
    // harness), so each triggers a refresh — but never more than one per call.
    assert.equal(calls.refreshes, 2);
    assert.equal(calls.fetches.length, 4);
});
