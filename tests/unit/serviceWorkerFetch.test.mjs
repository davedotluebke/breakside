/*
 * Pins the service worker's fetch strategy, in particular the NAVIGATION
 * fallback: any in-scope navigation whose network attempt fails must be
 * answered by the precached app shell (/index.html, then /), never by "no
 * cached response found". That is the error an installed PWA showed when a
 * share link (/view/<hash> — a path that exists only as an S3 404 fallback)
 * was opened from Messages on a slow cold start (2026-09-02).
 *
 * The worker is evaluated from its real source (no copy) inside a vm context
 * with stubbed `self` / `caches` / `fetch`, so this exercises the shipped
 * handler. The stamp step only rewrites two declarations
 * (cacheName / PRECACHE_URLS), which this leaves at their committed values.
 *
 * Run: node --test 'tests/unit/*.test.mjs'
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SW_SOURCE = readFileSync(join(repoRoot, 'service-worker.js'), 'utf8');
const ORIGIN = 'https://www.breakside.pro';

/** A minimal Request: the handler reads method, url and mode. */
class FakeRequest {
    constructor(url, init = {}) {
        if (url instanceof FakeRequest) { init = { ...url, ...init }; url = url.url; }
        this.url = url;
        this.method = init.method || 'GET';
        this.mode = init.mode || 'cors';
        this.cache = init.cache || 'default';
    }
}

/** A minimal Response: ok + a clone() the caching path calls. */
class FakeResponse {
    constructor(body, { status = 200 } = {}) { this.body = body; this.status = status; this.ok = status >= 200 && status < 300; }
    clone() { return new FakeResponse(this.body, { status: this.status }); }
}

/**
 * Load the worker with a stubbed environment.
 * @param {object} opts
 * @param {(req: FakeRequest) => Promise<FakeResponse>} opts.fetch - the network
 * @param {Object<string, FakeResponse>} [opts.cached] - cache contents keyed by URL
 * @returns {{dispatch: (req: FakeRequest) => Promise<FakeResponse|undefined>, puts: string[]}}
 */
function loadWorker({ fetch, cached = {}, RequestCtor = FakeRequest }) {
    const handlers = {};
    const puts = [];
    const cacheApi = {
        match: async key => {
            const url = typeof key === 'string' ? new URL(key, ORIGIN + '/').href : key.url;
            return cached[url];
        },
        put: async (req, res) => { puts.push(req.url); },
        add: async () => {},
    };
    const context = {
        self: {
            location: { origin: ORIGIN },
            addEventListener: (type, fn) => { handlers[type] = fn; },
            skipWaiting: () => {},
        },
        caches: {
            open: async () => cacheApi,
            match: cacheApi.match,
            keys: async () => [],
            delete: async () => true,
        },
        clients: { claim: async () => {} },
        fetch,
        Request: RequestCtor,
        URL,
        console: { log: () => {}, warn: () => {}, error: () => {} },
        setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 30)),   // shrink the 5 s race
        Promise,
        Error,
    };
    vm.createContext(context);
    vm.runInContext(SW_SOURCE, context, { filename: 'service-worker.js' });

    async function dispatch(request) {
        let responded = null;
        handlers.fetch({ request, respondWith: p => { responded = p; } });
        return responded === null ? undefined : responded;
    }
    return { dispatch, puts };
}

const shell = new FakeResponse('<!doctype html>app shell');
const nav = url => new FakeRequest(url, { mode: 'navigate' });

test('a navigation whose network attempt fails gets the precached app shell', async () => {
    const { dispatch } = loadWorker({
        fetch: async () => { throw new TypeError('Load failed'); },
        cached: { [ORIGIN + '/index.html']: shell },
    });
    const res = await dispatch(nav(ORIGIN + '/view/a8f3e2b1c9d4'));
    assert.equal(res, shell);
});

test('a navigation that times out gets the shell too', async () => {
    const { dispatch } = loadWorker({
        fetch: () => new Promise(() => {}),   // never settles
        cached: { [ORIGIN + '/index.html']: shell },
    });
    const res = await dispatch(nav(ORIGIN + '/view/a8f3e2b1c9d4'));
    assert.equal(res, shell);
});

test('the bare origin is the second-choice shell key', async () => {
    const rootShell = new FakeResponse('root');
    const { dispatch } = loadWorker({
        fetch: async () => { throw new Error('offline'); },
        cached: { [ORIGIN + '/']: rootShell },
    });
    assert.equal(await dispatch(nav(ORIGIN + '/view/a8f3e2b1c9d4')), rootShell);
});

test('a cached copy of the exact navigation URL still wins over the shell', async () => {
    const exact = new FakeResponse('exact');
    const { dispatch } = loadWorker({
        fetch: async () => { throw new Error('offline'); },
        cached: { [ORIGIN + '/index.html']: shell, [ORIGIN + '/app/']: exact },
    });
    assert.equal(await dispatch(nav(ORIGIN + '/app/')), exact);
});

test('with nothing precached at all, a failed navigation rejects (nothing to serve)', async () => {
    const { dispatch } = loadWorker({ fetch: async () => { throw new Error('offline'); } });
    await assert.rejects(dispatch(nav(ORIGIN + '/view/a8f3e2b1c9d4')));
});

test('a navigation that reaches the network returns the network response, cached only when ok', async () => {
    const page = new FakeResponse('page');
    const fallback404 = new FakeResponse('shell-as-404', { status: 404 });
    const w = loadWorker({ fetch: async req => req.url.endsWith('/view/x') ? fallback404 : page });
    assert.equal(await w.dispatch(nav(ORIGIN + '/')), page);
    assert.deepEqual(w.puts, [ORIGIN + '/']);
    // The S3 404 fallback body is the app (it boots fine) but must not be
    // cached under the share URL as if it were a real page.
    assert.equal(await w.dispatch(nav(ORIGIN + '/view/x')), fallback404);
    assert.deepEqual(w.puts, [ORIGIN + '/']);
});

test('an engine that refuses to re-init a navigation Request still gets a network attempt', async () => {
    class StrictRequest extends FakeRequest {
        constructor(url, init) {
            if (url instanceof FakeRequest && url.mode === 'navigate' && init && Object.keys(init).length) {
                throw new TypeError("Cannot construct a Request with a Request object that has mode 'navigate' and a non-empty RequestInit.");
            }
            super(url, init);
        }
    }
    const page = new FakeResponse('page');
    const seen = [];
    const { dispatch } = loadWorker({
        fetch: async req => { seen.push(req.cache); return page; },
        RequestCtor: StrictRequest,
    });
    assert.equal(await dispatch(new StrictRequest(ORIGIN + '/', { mode: 'navigate' })), page);
    assert.deepEqual(seen, ['default']);   // fell back to the original request
});

test('a same-origin asset request falls back to its own cached copy, not the shell', async () => {
    const css = new FakeResponse('css');
    const { dispatch } = loadWorker({
        fetch: async () => { throw new Error('offline'); },
        cached: { [ORIGIN + '/index.html']: shell, [ORIGIN + '/css/base.css']: css },
    });
    assert.equal(await dispatch(new FakeRequest(ORIGIN + '/css/base.css')), css);
    await assert.rejects(dispatch(new FakeRequest(ORIGIN + '/css/missing.css')));
});

test('API requests and non-GET requests are left to the browser', async () => {
    const { dispatch } = loadWorker({ fetch: async () => { throw new Error('should not be called'); } });
    assert.equal(await dispatch(new FakeRequest(ORIGIN + '/api/share/abc')), undefined);
    assert.equal(await dispatch(new FakeRequest('https://api.breakside.pro/api/games')), undefined);
    assert.equal(await dispatch(new FakeRequest(ORIGIN + '/', { method: 'POST', mode: 'navigate' })), undefined);
});
