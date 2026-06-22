/**
 * Breakside Landing — Hero Carousel
 *
 * Data-driven feature carousel for the hero. Each slide is a screenshot today,
 * but the machinery also renders short looping videos (set media.type:'video')
 * so individual features can graduate to motion clips without code changes.
 *
 * Behaviour: auto-advances every SLIDE_MS, pauses on hover/focus, supports
 * click-a-pill and swipe (touch + mouse drag). Respects prefers-reduced-motion
 * (no autoplay). See landing/screens/README.md for how to swap in real assets.
 */

(function () {
    'use strict';

    // Each slide: { id, media:{type:'image'|'video', src, poster?}, orientation, title, tag }
    const HERO_SLIDES = [
        {
            id: 'simple',
            media: { type: 'image', src: 'screens/simple.png' },
            orientation: 'portrait',
            title: 'Simple mode',
            tag: 'Just the basics',
        },
        {
            id: 'simple-score',
            media: { type: 'image', src: 'screens/simple-score.png' },
            orientation: 'portrait',
            title: 'Simple mode',
            tag: 'Credit the goal & assist in a tap',
        },
        {
            id: 'full',
            media: { type: 'image', src: 'screens/full.png' },
            orientation: 'portrait',
            title: 'Full mode',
            tag: 'Track every completion',
        },
        {
            id: 'field',
            media: { type: 'image', src: 'screens/field.png' },
            orientation: 'portrait',
            title: 'Field mode',
            tag: 'Place every throw, catch, drop, and D',
        },
        {
            id: 'field-landscape',
            media: { type: 'image', src: 'screens/field-landscape.png' },
            orientation: 'landscape',
            title: 'Field mode',
            tag: 'Rotate for a full-screen field',
        },
        {
            id: 'line',
            media: { type: 'image', src: 'screens/line.png' },
            orientation: 'portrait',
            title: 'Line Selection',
            tag: 'Track and balance points and playing time',
        },
        {
            id: 'all',
            media: { type: 'image', src: 'screens/all.png' },
            orientation: 'portrait',
            title: 'All in one',
            tag: 'Stats, lines, and log on a single screen',
        },
    ];

    const SLIDE_MS = 4500;

    const stage = document.getElementById('carouselStage');
    const pillsEl = document.getElementById('carouselPills');
    const titleEl = document.querySelector('.carousel-title');
    const tagEl = document.querySelector('.carousel-tag');
    if (!stage || !pillsEl) return;

    const reduceMotion = window.matchMedia &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    let current = 0;
    let timer = null;
    const slideEls = [];
    const pillEls = [];

    // --- Build slides + pills ------------------------------------------------
    HERO_SLIDES.forEach((slide, i) => {
        const el = document.createElement('div');
        el.className = `carousel-slide ${slide.orientation}`;
        el.setAttribute('role', 'group');
        el.setAttribute('aria-roledescription', 'slide');
        el.setAttribute('aria-label', `${slide.title} — ${slide.tag}`);

        const frame = document.createElement('div');
        frame.className = `device-frame ${slide.orientation}`;

        const screen = document.createElement('div');
        screen.className = 'device-screen';

        let media;
        if (slide.media.type === 'video') {
            media = document.createElement('video');
            media.src = slide.media.src;
            if (slide.media.poster) media.poster = slide.media.poster;
            media.muted = true;
            media.loop = true;
            media.playsInline = true;
            media.setAttribute('playsinline', '');
            media.preload = i === 0 ? 'auto' : 'none';
        } else {
            media = document.createElement('img');
            media.src = slide.media.src;
            media.loading = i === 0 ? 'eager' : 'lazy';
            media.alt = `${slide.title} — ${slide.tag}`;
        }
        media.className = 'device-media';

        screen.appendChild(media);
        frame.appendChild(screen);
        el.appendChild(frame);
        stage.appendChild(el);
        slideEls.push(el);

        const pill = document.createElement('button');
        pill.className = 'carousel-pill';
        pill.type = 'button';
        pill.setAttribute('role', 'tab');
        pill.setAttribute('aria-label', slide.title);
        pill.addEventListener('click', () => { goTo(i); restart(); });
        pillsEl.appendChild(pill);
        pillEls.push(pill);
    });

    // --- Navigation ----------------------------------------------------------
    function goTo(index) {
        current = (index + HERO_SLIDES.length) % HERO_SLIDES.length;
        slideEls.forEach((el, i) => {
            const active = i === current;
            el.classList.toggle('active', active);
            const vid = el.querySelector('video');
            if (vid) {
                if (active) { vid.play().catch(() => {}); }
                else { vid.pause(); }
            }
        });
        pillEls.forEach((p, i) => {
            const active = i === current;
            p.classList.toggle('active', active);
            p.setAttribute('aria-selected', active ? 'true' : 'false');
        });
        const slide = HERO_SLIDES[current];
        if (titleEl) titleEl.textContent = slide.title;
        if (tagEl) tagEl.textContent = slide.tag;
    }

    function next() { goTo(current + 1); }

    function start() {
        if (reduceMotion || timer) return;
        timer = window.setInterval(next, SLIDE_MS);
    }
    function stop() {
        if (timer) { window.clearInterval(timer); timer = null; }
    }
    function restart() { stop(); start(); }

    // Pause auto-advance while the user is looking/interacting.
    const root = document.getElementById('heroCarousel');
    if (root) {
        root.addEventListener('mouseenter', stop);
        root.addEventListener('mouseleave', start);
        root.addEventListener('focusin', stop);
        root.addEventListener('focusout', start);
    }

    // --- Swipe / drag --------------------------------------------------------
    let startX = null;
    function onDown(x) { startX = x; }
    function onUp(x) {
        if (startX === null) return;
        const dx = x - startX;
        startX = null;
        if (Math.abs(dx) < 40) return;
        goTo(current + (dx < 0 ? 1 : -1));
        restart();
    }
    stage.addEventListener('touchstart', (e) => onDown(e.touches[0].clientX), { passive: true });
    stage.addEventListener('touchend', (e) => onUp(e.changedTouches[0].clientX), { passive: true });
    stage.addEventListener('mousedown', (e) => onDown(e.clientX));
    window.addEventListener('mouseup', (e) => { if (startX !== null) onUp(e.clientX); });

    // Pause when the tab is hidden; resume when visible.
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) stop(); else start();
    });

    // --- Go --------------------------------------------------------------
    goTo(0);
    start();
})();
