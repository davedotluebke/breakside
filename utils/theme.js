/*
 * Theme (light / dark / auto)
 *
 * The palette itself lives in css/tokens.css: `:root` is light and
 * `:root[data-theme="dark"]` overrides it. This module owns the one thing CSS
 * can't do — deciding WHICH of those two applies — plus the bits of chrome
 * that live outside the stylesheet (the iOS/Android status bar color and the
 * two-tone wordmark).
 *
 * Why resolve "auto" in JS instead of wrapping the dark block in
 * `@media (prefers-color-scheme: dark)`:
 *   - the user can override the OS per-device, so the media query would have
 *     to be duplicated *and* fought with a data-theme escape hatch;
 *   - <meta name="theme-color"> has to be updated imperatively anyway, and it
 *     must agree with whatever the CSS decided.
 * So `data-theme` on <html> is always a RESOLVED value: "light" or "dark",
 * never "auto". css/tokens.css therefore needs exactly two blocks.
 *
 * First paint: index.html carries a tiny inline copy of the read-and-apply
 * step in <head> (see "theme boot" there) so the attribute is set before the
 * first pixel. Without it the app paints white and then snaps to black — the
 * worst version of dark mode. This module re-applies on load (idempotent) and
 * then owns every later change.
 *
 * Dark mode is a real power feature here, not just taste: --surface-page is
 * #000, and on the OLED phone that's propped on a sideline for two hours an
 * off pixel draws no current.
 */

// Same key/shape advancedSettings.js persists, read directly so the boot path
// and this module can't disagree about where the preference lives.
const STORAGE_KEY = 'breakside_advanced_settings';
const SETTING_KEY = 'display.theme';

const VALID = ['auto', 'light', 'dark'];

// Status-bar color per theme. Light matches the white header; dark matches
// --surface-card so the bar reads as part of the header rather than a seam.
const THEME_COLOR = { light: '#ffffff', dark: '#0d0d0d' };

// iOS standalone status bar. "default" = white bar / dark glyphs; "black" =
// black bar / light glyphs. Deliberately NOT "black-translucent": that one
// extends the web view under the notch, which this app's top-anchored fixed
// elements (countdown timer, toasts) are not safe-area aware about. See the
// viewport note in index.html.
const STATUS_BAR_STYLE = { light: 'default', dark: 'black' };

const darkQuery = typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: dark)')
    : null;

/** The stored preference: 'auto' | 'light' | 'dark'. Defaults to 'auto'. */
function getPreference() {
    try {
        const store = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') || {};
        const v = store[SETTING_KEY];
        return VALID.includes(v) ? v : 'auto';
    } catch (e) {
        return 'auto';
    }
}

/** The preference collapsed against the OS: always 'light' or 'dark'. */
function resolve(pref) {
    const p = VALID.includes(pref) ? pref : getPreference();
    if (p === 'auto') return darkQuery && darkQuery.matches ? 'dark' : 'light';
    return p;
}

function isDark() {
    return document.documentElement.getAttribute('data-theme') === 'dark';
}

function setMeta(name, content) {
    let el = document.querySelector(`meta[name="${name}"]`);
    if (!el) {
        el = document.createElement('meta');
        el.setAttribute('name', name);
        document.head.appendChild(el);
    }
    el.setAttribute('content', content);
}

/**
 * Point every two-tone image at the variant for `resolved`.
 *
 * The wordmark ships as black-and-orange lettering; on a dark surface the
 * black half vanishes, so images/logo.wordmark.dark.png carries light
 * lettering with the same orange accent. Elements opt in by declaring both
 * sources: `src` is the light one, `data-dark-src` the dark one.
 */
function applyImages(resolved) {
    document.querySelectorAll('[data-dark-src]').forEach(img => {
        const light = img.getAttribute('data-light-src') || img.getAttribute('src');
        // Remember the light source the first time, before we overwrite src.
        if (!img.getAttribute('data-light-src')) img.setAttribute('data-light-src', light);
        const want = resolved === 'dark' ? img.getAttribute('data-dark-src') : img.getAttribute('data-light-src');
        // Compare resolved URLs: img.src reports absolute, the attribute is relative.
        if (want && !img.src.endsWith(want)) img.src = want;
    });
}

/**
 * Apply a theme preference: set the resolved value on <html>, sync the
 * browser chrome, and swap themed images. Safe to call repeatedly.
 * @param {'auto'|'light'|'dark'} [pref] defaults to the stored preference
 * @returns {'light'|'dark'} the resolved theme
 */
function applyTheme(pref) {
    const resolved = resolve(pref);
    const root = document.documentElement;
    if (root.getAttribute('data-theme') !== resolved) {
        root.setAttribute('data-theme', resolved);
    }
    setMeta('theme-color', THEME_COLOR[resolved]);
    setMeta('apple-mobile-web-app-status-bar-style', STATUS_BAR_STYLE[resolved]);
    setMeta('msapplication-TileColor', THEME_COLOR[resolved]);
    applyImages(resolved);
    // Canvas/SVG drawing code samples tokens at paint time and has no way to
    // know the palette moved under it (playByPlay/fieldPbp.js draws the field
    // with getComputedStyle values). Give it a hook.
    document.dispatchEvent(new CustomEvent('breakside:theme-changed', {
        detail: { theme: resolved, preference: pref || getPreference() }
    }));
    return resolved;
}

/** Persist a new preference and apply it immediately. */
function setPreference(pref) {
    if (!VALID.includes(pref)) return;
    try {
        const store = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') || {};
        store[SETTING_KEY] = pref;
        localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
    } catch (e) {
        console.warn('[theme] failed to persist preference:', e);
    }
    applyTheme(pref);
}

// Follow the OS while the preference is 'auto'. (addEventListener on a
// MediaQueryList is Safari 14+; the addListener fallback covers older iOS.)
if (darkQuery) {
    const onSystemChange = () => { if (getPreference() === 'auto') applyTheme('auto'); };
    if (typeof darkQuery.addEventListener === 'function') {
        darkQuery.addEventListener('change', onSystemChange);
    } else if (typeof darkQuery.addListener === 'function') {
        darkQuery.addListener(onSystemChange);
    }
}

// Re-apply on module load. The inline boot script already set data-theme, but
// it deliberately does not touch <img> (the splash/header images may not be
// parsed yet) — this call picks those up.
applyTheme();
document.addEventListener('DOMContentLoaded', () => applyTheme());

const theme = { applyTheme, setPreference, getPreference, resolve, isDark };

export { theme, applyTheme, setPreference, getPreference, isDark };
// window survivor: late-bound accessor for the Advanced Settings modal, which
// builds its rows from a data-driven schema and needs to react to this one
// setting immediately rather than on next load.
window.theme = theme;
