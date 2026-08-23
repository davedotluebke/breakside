/**
 * Classic-script twin of utils/apiOrigin.js, for the landing pages.
 *
 * `landing/` is one of the two documented exceptions to the ES-module rule
 * (CLAUDE.md § Module Loading) — its pages load plain `<script src>` tags and
 * share state through globals, the same way supabaseInit.js does — so it cannot
 * `import` the app's copy. The logic is duplicated deliberately and must be
 * kept in step with utils/apiOrigin.js; see that file for the full rationale.
 *
 * Short version: `?api=` decides where `Authorization: Bearer <token>` is sent,
 * so it is restricted to the production API or a loopback/LAN address. That
 * preserves dev-backend and multi-device testing while making it impossible to
 * point a victim's session at an attacker's server.
 *
 * Exposes: window.BREAKSIDE_IS_ALLOWED_API_BASE(value) -> boolean
 */
(function () {
    'use strict';

    var PRODUCTION_API_ORIGINS = ['https://api.breakside.pro'];

    var PRIVATE_IPV4 = /^(?:127|10)\.\d{1,3}\.\d{1,3}\.\d{1,3}$|^192\.168\.\d{1,3}\.\d{1,3}$|^172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/;

    function isPrivateHost(hostname) {
        var h = String(hostname).toLowerCase();
        if (h === 'localhost' || h.slice(-10) === '.localhost') return true;
        if (h === '::1' || h === '[::1]') return true;
        if (h.slice(-6) === '.local') return true;
        return PRIVATE_IPV4.test(h);
    }

    window.BREAKSIDE_IS_ALLOWED_API_BASE = function (value) {
        if (typeof value !== 'string' || value === '') return false;

        var url;
        try {
            url = new URL(value);
        } catch (e) {
            return false;
        }

        if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
        if (PRODUCTION_API_ORIGINS.indexOf(url.origin) !== -1) return true;

        return isPrivateHost(url.hostname);
    };
})();
