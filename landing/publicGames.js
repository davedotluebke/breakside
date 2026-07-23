/**
 * Landing page: "Public games" section.
 *
 * Fetches /api/public/games (games whose coaches created a share link with
 * "List publicly" checked) and renders cards linking to the standalone
 * viewer. The section stays hidden unless at least one game comes back —
 * an empty or failed fetch leaves the landing page exactly as it was.
 *
 * Classic script by design: landing/ is the documented exception to the ES
 * module graph (see ARCHITECTURE.md § Module Loading).
 */
(function () {
    'use strict';

    // Same hostname → API mapping as landing/join.js (the static origins
    // have no /api/*; the API lives at api.breakside.pro).
    var API_BASE = (function () {
        var apiParam = new URLSearchParams(window.location.search).get('api');
        if (apiParam && apiParam !== 'reset') return apiParam;

        var host = window.location.hostname;
        if (host === 'localhost' || host === '127.0.0.1') return 'http://localhost:8000';
        if (host === 'breakside.pro' || host.endsWith('.breakside.pro') ||
            host === 'breakside.us' || host.endsWith('.breakside.us') ||
            host === 'luebke.us') {
            return 'https://api.breakside.pro';
        }
        return window.location.origin;
    })();

    // A game with no end timestamp only counts as LIVE if it changed
    // recently (mirrors the viewer's rule — abandoned games aren't live).
    var LIVE_RECENCY_MS = 30 * 60 * 1000;

    function esc(s) {
        var div = document.createElement('div');
        div.textContent = s == null ? '' : String(s);
        return div.innerHTML;
    }

    function gameDateLabel(iso) {
        if (!iso) return '';
        var d = new Date(iso);
        if (isNaN(d)) return '';
        return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    }

    function renderCard(game) {
        var isLive = game.inProgress &&
            (Date.now() - new Date(game.updatedAt).getTime()) < LIVE_RECENCY_MS;
        var badge = isLive
            ? '<span class="pg-live-badge">LIVE</span>'
            : '<span class="pg-date">' + esc(gameDateLabel(game.gameStartTimestamp)) + '</span>';
        var scores = game.scores || {};
        var viewerUrl = API_BASE + '/view/' + encodeURIComponent(game.hash);
        return '<a class="pg-card" href="' + viewerUrl + '">' +
            '<div class="pg-card-top">' + badge + '</div>' +
            '<div class="pg-teams">' +
                '<span class="pg-team">' + esc(game.team) + '</span>' +
                '<span class="pg-score">' + esc(scores.team) + ' – ' + esc(scores.opponent) + '</span>' +
                '<span class="pg-team">' + esc(game.opponent) + '</span>' +
            '</div>' +
            '<div class="pg-cta">Watch ' + (isLive ? 'live' : 'the play-by-play') + ' →</div>' +
        '</a>';
    }

    function init() {
        var section = document.getElementById('publicGamesSection');
        var list = document.getElementById('publicGamesList');
        if (!section || !list) return;

        fetch(API_BASE + '/api/public/games')
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (data) {
                var games = (data && data.games) || [];
                if (!games.length) return; // section stays hidden
                list.innerHTML = games.map(renderCard).join('');
                section.style.display = '';

                // The hero's "Watch Live Games" button predates this section
                // and points at the browse viewer, which is empty for
                // anonymous visitors (auth-required listings). While public
                // games exist, send the button here instead.
                var watchBtn = document.getElementById('watchLiveGamesBtn');
                if (watchBtn) watchBtn.href = '#publicGamesSection';
            })
            .catch(function () { /* leave hidden — landing must never break */ });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
