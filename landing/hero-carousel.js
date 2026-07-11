/**
 * Breakside Landing — Hero Carousel
 *
 * Data-driven feature carousel for the hero. Slides are screenshots or muted
 * video clips (set media.type:'video'); a video slide plays from the start
 * when it becomes active and holds the carousel until the clip ends.
 *
 * Behaviour: image slides auto-advance every SLIDE_MS, video slides advance
 * on 'ended'; pauses on hover/focus (a video that ends while hovered replays
 * instead of advancing), supports click-a-pill and swipe (touch + mouse
 * drag). Respects prefers-reduced-motion (no auto-advance; a video still
 * plays when the user explicitly selects its slide, and stops on its last
 * frame). See landing/screens/README.md for how to swap in real assets.
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
        {
            id: 'field-demo',
            media: {
                type: 'video',
                src: 'screens/field-mode-demo.mp4',
                poster: 'screens/field-mode-demo-poster.png',
            },
            orientation: 'portrait',
            title: 'Field mode in action',
            tag: 'A full point: swings, a reset, a huck, the goal',
        },
    ];

    const SLIDE_MS = 4500;
    // Video slides advance when the clip ends; this is the safety net in case
    // playback never starts (autoplay blocked, slow network) so the carousel
    // can't stall on a frozen slide.
    const VIDEO_MAX_MS = 45000;

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
            media.setAttribute('muted', '');
            media.playsInline = true;
            media.setAttribute('playsinline', '');
            media.preload = i === 0 ? 'auto' : 'none';
            // A finished clip advances the carousel — unless the user is
            // watching (hover/focus pause), then it replays, or motion is
            // reduced, then it rests on its last frame.
            media.addEventListener('ended', () => {
                if (i !== current) return;
                if (paused) {
                    media.currentTime = 0;
                    media.play().catch(() => {});
                } else if (!reduceMotion) {
                    next();
                }
            });
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
        pill.addEventListener('click', () => goTo(i));
        pillsEl.appendChild(pill);
        pillEls.push(pill);
    });

    // --- Navigation ----------------------------------------------------------
    let paused = false;

    function goTo(index) {
        current = (index + HERO_SLIDES.length) % HERO_SLIDES.length;
        slideEls.forEach((el, i) => {
            const active = i === current;
            el.classList.toggle('active', active);
            const vid = el.querySelector('video');
            if (vid) {
                if (active) { vid.currentTime = 0; vid.play().catch(() => {}); }
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
        schedule();
    }

    function next() { goTo(current + 1); }

    // Image slides hold for SLIDE_MS; video slides advance on 'ended', with
    // VIDEO_MAX_MS as the stall-proof upper bound.
    function schedule() {
        stop();
        if (reduceMotion || paused) return;
        const isVideo = !!slideEls[current].querySelector('video');
        timer = window.setTimeout(next, isVideo ? VIDEO_MAX_MS : SLIDE_MS);
    }

    function start() { paused = false; schedule(); }
    function stop() {
        if (timer) { window.clearTimeout(timer); timer = null; }
    }
    function pause() { paused = true; stop(); }

    // Pause auto-advance while the user is looking/interacting.
    const root = document.getElementById('heroCarousel');
    if (root) {
        root.addEventListener('mouseenter', pause);
        root.addEventListener('mouseleave', start);
        root.addEventListener('focusin', pause);
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
    }
    stage.addEventListener('touchstart', (e) => onDown(e.touches[0].clientX), { passive: true });
    stage.addEventListener('touchend', (e) => onUp(e.changedTouches[0].clientX), { passive: true });
    stage.addEventListener('mousedown', (e) => onDown(e.clientX));
    window.addEventListener('mouseup', (e) => { if (startX !== null) onUp(e.clientX); });

    // Pause when the tab is hidden; resume when visible.
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) pause(); else start();
    });

    // --- Go --------------------------------------------------------------
    goTo(0);
})();
