/**
 * In-page contrast audit.
 *
 * Screenshots catch a black-on-black panel; they don't reliably catch a
 * 2.4:1 label or a hairline that technically renders but reads as nothing.
 * This walks the live DOM of whatever screen is showing and measures, for
 * every visible element:
 *
 *   - TEXT: the computed color against the first opaque background behind it,
 *     as a WCAG 2.1 contrast ratio. Flagged under 4.5:1 (3:1 for large text,
 *     matching AA).
 *   - BORDERS: each visible border side against the backgrounds on both sides
 *     of it. A rule needs to separate SOMETHING; if it contrasts with neither
 *     neighbour it is an invisible line. Flagged under 1.35:1 on both sides.
 *
 * Deliberately conservative — it under-reports rather than crying wolf:
 *   - anything with opacity 0, visibility hidden or zero size is skipped, as
 *     are elements whose text is only whitespace;
 *   - `opacity` on an ancestor is folded into the text color, so a deliberately
 *     dimmed disabled control is measured as the user actually sees it;
 *   - elements over an image/gradient background are skipped, since a single
 *     sampled color would be a guess.
 */
import { Page } from '@playwright/test';

export type Finding = {
  screen: string;
  kind: 'text' | 'border';
  ratio: number;
  sample: string;
  selector: string;
  fg: string;
  bg: string;
};

export async function auditContrast(page: Page, screen: string): Promise<Finding[]> {
  const found = await page.evaluate(() => {
    const parse = (c: string): [number, number, number, number] | null => {
      const m = c.match(/rgba?\(([^)]+)\)/);
      if (!m) return null;
      const p = m[1].split(',').map(s => parseFloat(s.trim()));
      return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
    };
    const lum = ([r, g, b]: number[]) => {
      const f = (v: number) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
      };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const ratio = (a: number[], b: number[]) => {
      const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x);
      return (l1 + 0.05) / (l2 + 0.05);
    };
    /** Composite a possibly-translucent color over an opaque backdrop. */
    const over = (c: [number, number, number, number], bg: number[]) =>
      [0, 1, 2].map(i => c[i] * c[3] + bg[i] * (1 - c[3]));

    /** First opaque background behind el, compositing translucent layers. */
    const backdropOf = (el: Element): number[] | null => {
      const stack: [number, number, number, number][] = [];
      let node: Element | null = el;
      while (node) {
        const cs = getComputedStyle(node);
        if (cs.backgroundImage && cs.backgroundImage !== 'none') return null; // can't sample
        const c = parse(cs.backgroundColor);
        if (c && c[3] > 0) {
          if (c[3] >= 0.999) {
            let base: number[] = [c[0], c[1], c[2]];
            for (let i = stack.length - 1; i >= 0; i--) base = over(stack[i], base);
            return base;
          }
          stack.push(c);
        }
        node = node.parentElement;
      }
      // Nothing opaque all the way up: the canvas is white by CSS default,
      // but color-scheme: dark makes it the UA's dark canvas. Read it off html.
      const html = getComputedStyle(document.documentElement);
      const root = parse(html.backgroundColor);
      let base: number[] = root && root[3] >= 0.999 ? [root[0], root[1], root[2]]
        : (html.colorScheme || '').includes('dark') ? [18, 18, 18] : [255, 255, 255];
      for (let i = stack.length - 1; i >= 0; i--) base = over(stack[i], base);
      return base;
    };

    /** Cumulative opacity from the element up to the root. */
    const effOpacity = (el: Element) => {
      let o = 1, node: Element | null = el;
      while (node) {
        o *= parseFloat(getComputedStyle(node).opacity || '1');
        node = node.parentElement;
      }
      return o;
    };

    const selectorOf = (el: Element) => {
      const bits: string[] = [];
      let node: Element | null = el;
      for (let i = 0; node && i < 3; i++, node = node.parentElement) {
        let s = node.tagName.toLowerCase();
        if (node.id) { bits.unshift(`#${node.id}`); break; }
        const cls = (node.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean);
        if (cls.length) s += '.' + cls.slice(0, 2).join('.');
        bits.unshift(s);
      }
      return bits.join(' > ');
    };

    const out: Array<Omit<Finding, 'screen'>> = [];
    const seen = new Set<string>();

    for (const el of Array.from(document.querySelectorAll<HTMLElement>('body *'))) {
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none') continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) continue;
      // Off-screen (a hidden screen section that is still display:block)
      if (rect.bottom < 0 || rect.top > (window.innerHeight * 3)) continue;
      const opacity = effOpacity(el);
      if (opacity < 0.05) continue;

      const bg = backdropOf(el);
      if (!bg) continue;

      // ── text ────────────────────────────────────────────────────────────
      const ownText = Array.from(el.childNodes)
        .filter(n => n.nodeType === Node.TEXT_NODE)
        .map(n => (n.textContent || '').trim())
        .join(' ')
        .trim();
      if (ownText) {
        const c = parse(cs.color);
        if (c) {
          const fg = over([c[0], c[1], c[2], c[3] * opacity], bg);
          const r = ratio(fg, bg);
          const px = parseFloat(cs.fontSize) || 16;
          const bold = (parseInt(cs.fontWeight, 10) || 400) >= 700;
          const large = px >= 24 || (bold && px >= 18.66);
          const need = large ? 3 : 4.5;
          if (r < need) {
            const key = `t|${selectorOf(el)}|${ownText.slice(0, 20)}`;
            if (!seen.has(key)) {
              seen.add(key);
              out.push({
                kind: 'text', ratio: Math.round(r * 100) / 100,
                sample: ownText.slice(0, 48), selector: selectorOf(el),
                fg: cs.color, bg: `rgb(${bg.map(Math.round).join(',')})`,
              });
            }
          }
        }
      }

      // ── borders ─────────────────────────────────────────────────────────
      const parentBg = el.parentElement ? backdropOf(el.parentElement) : bg;
      const ownBg = backdropOf(el) || bg;
      for (const side of ['Top', 'Right', 'Bottom', 'Left'] as const) {
        const w = parseFloat(cs[`border${side}Width` as never] as string) || 0;
        if (w < 0.5) continue;
        if ((cs[`border${side}Style` as never] as string) === 'none') continue;
        const bc = parse(cs[`border${side}Color` as never] as string);
        if (!bc || bc[3] < 0.05) continue;
        const line = over([bc[0], bc[1], bc[2], bc[3] * opacity], ownBg);
        const inner = ratio(line, ownBg);
        const outer = parentBg ? ratio(line, parentBg) : inner;
        if (Math.max(inner, outer) < 1.35) {
          const key = `b|${selectorOf(el)}`;
          if (!seen.has(key)) {
            seen.add(key);
            out.push({
              kind: 'border',
              ratio: Math.round(Math.max(inner, outer) * 100) / 100,
              sample: `border-${side.toLowerCase()} ${w}px`,
              selector: selectorOf(el),
              fg: cs[`border${side}Color` as never] as string,
              bg: `rgb(${ownBg.map(Math.round).join(',')})`,
            });
          }
        }
      }
    }
    return out;
  });

  return found.map(f => ({ ...f, screen }));
}
