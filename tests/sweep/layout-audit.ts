/**
 * In-page layout audit for small screens.
 *
 * A screenshot shows that something looks wrong. It does not show that a
 * button is 40px below the bottom of a panel that cannot scroll, or that a
 * label is spilling out of its box by 3px. This walks the live DOM of the
 * current screen and reports:
 *
 *   HIGH  unreachable  a control clipped out of view by an ancestor that
 *                      cannot scroll (or by the viewport of a fixed screen):
 *                      the user cannot tap it at all
 *   HIGH  cut-off      the same, but partly visible
 *   HIGH  zoomed-out   the page is wider than the phone, so the browser
 *                      shrinks all of it to fit (or lets it pan sideways);
 *                      reported with the elements that stick out
 *   HIGH  offscreen-x  a control, or the element responsible for
 *                      zoomed-out, past the left or right edge of the phone
 *   HIGH  covered      another element sits on top of the control's centre
 *   MED   text-spill   text running outside its own box
 *   MED   text-clipped text cut off by overflow: hidden, no ellipsis
 *   MED   wrapped      a button label wrapped onto 3 or more lines
 *   MED   overlap      two controls overlapping each other
 *   MED   needs-scroll a control reachable only by scrolling (MED on the
 *                      in-game screen, where scrolling mid-point costs a
 *                      play; LOW elsewhere)
 *   LOW   truncated    text cut with an ellipsis (usually deliberate)
 *   LOW   small-target a control under 32px in either dimension
 *
 * Only the top layer is audited: a dialog or full-screen shell covering the
 * viewport, or the element named by `layer` (an open dropdown, say). The
 * screen behind it is ignored.
 *
 * Clipping follows the containing-block chain the way the browser does: an
 * overflow: hidden ancestor does not clip an absolutely positioned descendant
 * whose containing block lies outside it, and nothing but the viewport clips
 * a position: fixed one. (Getting this wrong reports every dropdown as
 * hidden.)
 *
 * The logic is installed into the page once (installLayoutAudit) so the
 * sweep's click helper can ask the same reachability question the audit does.
 */
import { Locator, Page } from '@playwright/test';

export type Severity = 'high' | 'med' | 'low';

export type LayoutIssue = {
  kind: string;
  severity: Severity;
  selector: string;
  label: string;
  detail: string;
};

/** How a finger could get at an element: tap it now, scroll to it, or not at all. */
export type Reach = 'tap' | 'scroll' | 'none';

declare global {
  interface Window {
    __layoutAudit?: {
      audit(opts: { inGame: boolean; layer: string | null; width: number }): LayoutIssue[];
      reach(el: Element): Reach;
    };
  }
}

export async function installLayoutAudit(page: Page) {
  await page.addInitScript(installer);
}

export async function auditLayout(page: Page, opts: { inGame?: boolean; layer?: string } = {}): Promise<LayoutIssue[]> {
  // The phone's width, not window.innerWidth: once anything overflows, a
  // mobile browser widens the layout viewport to fit it and zooms the whole
  // page out, so innerWidth reports the overflow as the new normal.
  const width = page.viewportSize()?.width ?? 0;
  return page.evaluate(o => window.__layoutAudit!.audit(o),
    { inGame: !!opts.inGame, layer: opts.layer ?? null, width });
}

export async function reachOf(el: Locator): Promise<Reach> {
  return el.evaluate(n => window.__layoutAudit!.reach(n));
}

/** Runs in the page. Must be self-contained: no references to module scope. */
function installer() {
  type Issue = { kind: string; severity: 'high' | 'med' | 'low'; selector: string; label: string; detail: string };

  const createsContainingBlock = (cs: CSSStyleDeclaration) =>
    cs.transform !== 'none' || cs.perspective !== 'none' || cs.filter !== 'none' ||
    (cs.backdropFilter && cs.backdropFilter !== 'none') ||
    /paint|layout|strict|content/.test(cs.contain) ||
    /transform|perspective|filter/.test(cs.willChange) ||
    (cs.containerType && cs.containerType !== 'normal');

  /** The next box up that can clip `el`, or null when only the viewport can. */
  function clipParent(el: Element): Element | null {
    const pos = getComputedStyle(el).position;
    let a = el.parentElement;
    if (pos === 'fixed') {
      for (; a; a = a.parentElement) if (createsContainingBlock(getComputedStyle(a))) return a;
      return null;
    }
    if (pos === 'absolute') {
      for (; a; a = a.parentElement) {
        const cs = getComputedStyle(a);
        if (cs.position !== 'static' || createsContainingBlock(cs)) return a;
      }
      return null;
    }
    return a;
  }

  const scrolls = (el: Element, axis: 'x' | 'y') => {
    const cs = getComputedStyle(el);
    const ov = axis === 'y' ? cs.overflowY : cs.overflowX;
    if (ov !== 'auto' && ov !== 'scroll' && ov !== 'overlay') return false;
    return axis === 'y' ? el.scrollHeight > el.clientHeight + 1 : el.scrollWidth > el.clientWidth + 1;
  };

  const docScrollsY = () =>
    document.documentElement.scrollHeight > innerHeight + 1 &&
    getComputedStyle(document.body).overflowY !== 'hidden' &&
    getComputedStyle(document.documentElement).overflowY !== 'hidden';

  function describe(el: Element): string {
    const own = (e: Element) => {
      if (e.id) return `#${e.id}`;
      const cls = [...e.classList].slice(0, 2).map(c => `.${c}`).join('');
      return e.tagName.toLowerCase() + cls;
    };
    if (el.id) return own(el);
    let anchor: Element | null = el.parentElement;
    while (anchor && !anchor.id) anchor = anchor.parentElement;
    return anchor ? `${own(anchor)} ${own(el)}` : own(el);
  }

  function labelOf(el: Element): string {
    const h = el as HTMLElement;
    const text = h.getAttribute('aria-label') || h.title ||
      (h instanceof HTMLInputElement ? (h.placeholder || h.value || h.type) : h.innerText) || '';
    return text.replace(/\s+/g, ' ').trim().slice(0, 48);
  }

  const shown = (el: Element) =>
    (el as HTMLElement).checkVisibility?.({ opacityProperty: true, visibilityProperty: true }) ?? true;

  type Geometry = {
    clippedBy: Element | null; clipPx: number; fully: boolean;
    needsScroll: boolean; inFixed: boolean;
    top: number; bottom: number; left: number; right: number;
  };

  /** Where `el` ends up once every real scroll container has been scrolled to it. */
  function geometry(el: Element): Geometry {
    const r0 = el.getBoundingClientRect();
    const g: Geometry = {
      clippedBy: null, clipPx: 0, fully: false, needsScroll: false, inFixed: false,
      top: r0.top, bottom: r0.bottom, left: r0.left, right: r0.right,
    };
    for (let c: Element | null = el; c; c = clipParent(c)) {
      if (getComputedStyle(c).position === 'fixed' && clipParent(c) === null) g.inFixed = true;
      if (c === el) continue;
      if (c === document.body || c === document.documentElement) break;
      const cs = getComputedStyle(c);
      const clipsX = cs.overflowX !== 'visible', clipsY = cs.overflowY !== 'visible';
      if (!clipsX && !clipsY) continue;
      const cr = c.getBoundingClientRect();
      const cTop = cr.top + c.clientTop, cBottom = cTop + c.clientHeight;
      const cLeft = cr.left + c.clientLeft, cRight = cLeft + c.clientWidth;
      for (const axis of ['y', 'x'] as const) {
        if (axis === 'y' ? !clipsY : !clipsX) continue;
        const lo = axis === 'y' ? g.top : g.left, hi = axis === 'y' ? g.bottom : g.right;
        const cLo = axis === 'y' ? cTop : cLeft, cHi = axis === 'y' ? cBottom : cRight;
        if (lo >= cLo - 1 && hi <= cHi + 1) continue;
        if (scrolls(c, axis)) {
          g.needsScroll = true;
          const size = hi - lo;
          const nlo = size <= cHi - cLo ? Math.min(Math.max(lo, cLo), cHi - size) : cLo;
          const nhi = Math.min(nlo + size, cHi);
          if (axis === 'y') { g.top = nlo; g.bottom = nhi; } else { g.left = nlo; g.right = nhi; }
        } else {
          g.clippedBy = c;
          const visible = Math.max(0, Math.min(hi, cHi) - Math.max(lo, cLo));
          g.fully = visible <= 1;
          g.clipPx = Math.round((hi - lo) - visible);
          return g;
        }
      }
    }
    return g;
  }

  function reach(el: Element): 'tap' | 'scroll' | 'none' {
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    if (cx >= 0 && cy >= 0 && cx <= innerWidth && cy <= innerHeight) {
      const hit = document.elementFromPoint(cx, cy);
      if (hit && (hit === el || el.contains(hit))) return 'tap';
    }
    const g = geometry(el);
    if (g.clippedBy) return 'none';
    const offY = g.bottom > innerHeight + 1 || g.top < -1;
    if (offY && (g.inFixed || !docScrollsY())) return 'none';
    if (g.needsScroll || offY) return 'scroll';
    return 'none';   // on screen but covered
  }

  function audit({ inGame, layer, width }: { inGame: boolean; layer: string | null; width: number }): Issue[] {
    const vw = width || innerWidth;
    // A zoomed-out page reports a taller innerHeight too; scale it back.
    const vh = Math.round(innerHeight * (vw / innerWidth));
    const issues: Issue[] = [];
    const seen = new Set<string>();
    const add = (kind: string, severity: Issue['severity'], el: Element | null, detail: string) => {
      const selector = el ? describe(el) : 'document';
      const label = el ? labelOf(el) : '';
      const key = `${kind}|${selector}|${label}`;
      if (seen.has(key)) return;
      seen.add(key);
      issues.push({ kind, severity, selector, label, detail });
    };

    // ── Which layer is on top? ─────────────────────────────────────────────
    let root: Element = document.body;
    const named = layer ? document.querySelector(layer) : null;
    if (named) {
      root = named;
    } else {
      for (const el of document.elementsFromPoint(vw / 2, vh / 2)) {
        const cs = getComputedStyle(el);
        if (cs.position !== 'fixed' && cs.position !== 'absolute') continue;
        const r = el.getBoundingClientRect();
        if (r.width >= vw * 0.9 && r.height >= vh * 0.9) { root = el; break; }
      }
    }

    const docW = Math.max(document.documentElement.scrollWidth, innerWidth);
    if (docW > vw + 1) {
      add('zoomed-out', 'high', null, `page is ${docW}px wide on a ${vw}px phone: the browser shows it ` +
        `at ${Math.round(vw / docW * 100)}% or lets it pan sideways`);
      // Name the culprits: elements past the edge whose parent is not.
      let named = 0;
      for (const el of document.body.querySelectorAll('*')) {
        if (named >= 6 || !shown(el)) continue;
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.right <= vw + 1) continue;
        const pr = el.parentElement?.getBoundingClientRect();
        if (pr && pr.right > vw + 1) continue;
        const g = geometry(el);
        if (g.clippedBy || g.right <= vw + 1) continue;
        add('offscreen-x', 'high', el, `right edge at ${Math.round(r.right)}px on a ${vw}px phone ` +
          `(${Math.round(r.width)}px wide)`);
        named++;
      }
    }

    const CONTROL = 'button, a[href], input:not([type="hidden"]), select, textarea, [role="button"], ' +
      '[onclick], .player-button';
    const controls = [...root.querySelectorAll(CONTROL)].filter(el => {
      if (!shown(el)) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
    // A control nested in another control is audited through its parent.
    const topControls = controls.filter(el => !controls.some(o => o !== el && o.contains(el)));
    const pageScrolls = docScrollsY();

    for (const el of topControls) {
      const g = geometry(el);
      if (g.clippedBy) {
        add(g.fully ? 'unreachable' : 'cut-off', 'high', el,
          `${g.fully ? 'hidden' : `${g.clipPx}px cut off`} by ${describe(g.clippedBy)} ` +
          `(overflow ${getComputedStyle(g.clippedBy).overflowY}, nothing to scroll)`);
        continue;
      }
      let needsScroll = g.needsScroll;
      if (g.bottom > vh + 1 || g.top < -1) {
        if (g.inFixed || !pageScrolls) {
          const visible = Math.max(0, Math.min(g.bottom, vh) - Math.max(g.top, 0));
          add(visible <= 1 ? 'unreachable' : 'cut-off', 'high', el, visible <= 1
            ? 'below the bottom of a screen that cannot scroll'
            : `${Math.round(g.bottom - vh)}px below the bottom of a screen that cannot scroll`);
          continue;
        }
        needsScroll = true;
      }
      if (g.right > vw + 1 || g.left < -1) {
        add('offscreen-x', 'high', el, `spans x ${Math.round(g.left)}–${Math.round(g.right)} of ${vw}`);
        continue;
      }
      if (needsScroll) {
        add('needs-scroll', inGame ? 'med' : 'low', el, 'reachable only by scrolling');
        continue;
      }
      const cx = (g.left + g.right) / 2, cy = (g.top + g.bottom) / 2;
      const hit = document.elementFromPoint(cx, cy);
      if (hit && hit !== el && !el.contains(hit) && !hit.contains(el)) {
        add('covered', 'high', el, `covered by ${describe(hit)}`);
      }
      const r = el.getBoundingClientRect();
      if (Math.min(r.width, r.height) < 32 && !(el as HTMLButtonElement).disabled) {
        add('small-target', 'low', el, `${Math.round(r.width)}x${Math.round(r.height)}px`);
      }
    }

    // ── Overlapping controls (fully visible ones only) ────────────────────
    // A control scrolled out of its list is clipped by the list, so its box
    // "overlapping" whatever sits below the list is not something anyone sees.
    const onScreen = topControls.filter(el => {
      const r = el.getBoundingClientRect();
      if (r.top < 0 || r.bottom > vh || r.left < 0 || r.right > vw) return false;
      const g = geometry(el);
      return !g.clippedBy && !g.needsScroll;
    });
    for (let i = 0; i < onScreen.length; i++) {
      const a = onScreen[i].getBoundingClientRect();
      for (let j = i + 1; j < onScreen.length; j++) {
        const b = onScreen[j].getBoundingClientRect();
        const ix = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const iy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (ix <= 2 || iy <= 2) continue;
        const smaller = Math.min(a.width * a.height, b.width * b.height);
        if (ix * iy > smaller * 0.15) {
          add('overlap', 'med', onScreen[i], `overlaps ${describe(onScreen[j])} (${labelOf(onScreen[j])})`);
        }
      }
    }

    // ── Text that does not fit its box ─────────────────────────────────────
    const hasOwnText = (el: Element) =>
      [...el.childNodes].some(n => n.nodeType === Node.TEXT_NODE && n.textContent!.trim().length > 0);
    for (const el of root.querySelectorAll('*')) {
      if (!(el instanceof HTMLElement) || !hasOwnText(el) || !shown(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0 || r.bottom < 0 || r.top > vh) continue;
      const cs = getComputedStyle(el);
      if (cs.display === 'inline') continue;   // inline boxes have no clientWidth
      const overX = el.scrollWidth - el.clientWidth;
      const overY = el.scrollHeight - el.clientHeight;
      if (overX > 1 && cs.overflowX === 'visible') {
        add('text-spill', 'med', el, `text runs ${overX}px past its right edge`);
      } else if (overX > 1 && cs.textOverflow === 'ellipsis') {
        add('truncated', 'low', el, `ellipsis hides ${overX}px`);
      } else if (overX > 1 && (cs.overflowX === 'hidden' || cs.overflowX === 'clip')) {
        add('text-clipped', 'med', el, `${overX}px of text clipped on the right`);
      } else if (overY > 2 && (cs.overflowY === 'hidden' || cs.overflowY === 'clip') &&
                 !scrolls(el, 'y') && el.clientHeight > 0) {
        add('text-clipped', 'med', el, `${overY}px of text clipped at the bottom`);
      }
    }

    // ── Button labels wrapped onto 3+ lines ───────────────────────────────
    for (const el of topControls) {
      if (!(el instanceof HTMLElement) || el.tagName === 'INPUT' || el.tagName === 'SELECT') continue;
      const r = el.getBoundingClientRect();
      if (r.bottom < 0 || r.top > vh) continue;
      const range = document.createRange();
      range.selectNodeContents(el);
      const rects = [...range.getClientRects()].filter(x => x.width > 1 && x.height > 1);
      if (!rects.length) continue;
      const cs = getComputedStyle(el);
      const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.2;
      const centres = rects.map(x => (x.top + x.bottom) / 2).sort((p, q) => p - q);
      let lines = 1;
      for (let i = 1; i < centres.length; i++) if (centres[i] - centres[i - 1] > lh * 0.6) lines++;
      if (lines >= 3) add('wrapped', 'med', el, `label wraps onto ${lines} lines in a ${Math.round(r.width)}px-wide box`);
    }

    return issues;
  }

  window.__layoutAudit = { audit, reach };
}
