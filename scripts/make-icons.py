#!/usr/bin/env python3
"""
Generate the favicon / app-icon set from the wordmark.

    python3 scripts/make-icons.py            # writes images/favicon-*.png, images/favicon.ico,
                                             # and the images/staging/ equivalents

The icon is the wordmark's "k" (the whiteboard X-player and its line), cut out
of images/logo.wordmark.dark.png as its two orange connected components, so it
stays pixel-faithful to the logo. Sizes from 96 px up add the arrow, shrunk to
run along the bottom with its tail ending just past the X. 48 px drops the
arrow (it turns to mud under ~64 px) and thickens the strokes.

16 and 32 px are cut as an optical size rather than a shrink: at that scale
the logo's X is ~6 px tall and fuses into a "k" whatever the spacing, so the
line and the X are set further apart, the X is drawn half again larger than
the logo's proportions, and the arrow at 32 px is a straight one-pixel line
with a left-pointing head drawn at the target size. 16 px carries no arrow.

Production is the orange mark on white (matching the app header); staging is a
white mark on the staging purple. All geometry is in fractions of a 1024 px
canvas, so every size shares one layout.

Needs Pillow and numpy.
"""
import os
from collections import deque

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'images', 'logo.wordmark.dark.png')
SIZES = [16, 32, 48, 96, 192, 512]
ICO_SIZES = [16, 32, 48]

WHITE = (255, 255, 255)
ORANGE = (251, 86, 0)             # the wordmark's orange, for the pixel arrow
STAGING_PURPLE = (224, 52, 235)   # the purple the previous staging icons used

# Layout, as fractions of the canvas.
K_HEIGHT = 0.76      # the mark's height
K_SHIFT = 0.08       # nudge the mark right so the arrow's head has room on the left
ARROW_WIDTH = 0.86
ARROW_GAP = 0.03     # between the mark's foot and the arrow
ARROW_TAIL_PAST_K = 0.06
EDGE = 0.04          # minimum margin the arrow keeps from the icon's edge
BOLD = {16: 10, 32: 8, 48: 4}   # stroke dilation (px at 780 px mark height) for tiny sizes

# Optical size for 16 and 32 px (see the docstring).
SMALL_GAP = 0.14         # line-to-X gap, as a fraction of the line's height (logo: ~0.03)
SMALL_X_SCALE = 1.5      # the X, relative to its size in the logo
SMALL_ARROW = {32: dict(y=28, x0=4, x1=27, head=2)}   # straight pixel arrow; 16 px has none
X_HEIGHT = 137 / 360     # the X's height and top edge relative to the line, in the logo
X_TOP = 171 / 360


def load_parts():
    """Cut the mark (stroke + X together), the stroke, the X and the arrow out of the dark wordmark."""
    a = np.array(Image.open(SRC).convert('RGBA')).astype(int)
    r, g, b, al = a[..., 0], a[..., 1], a[..., 2], a[..., 3]
    orange = (al > 40) & (r > 150) & (r - b > 80) & (r - g > 30)
    h, w = orange.shape
    lab = np.zeros((h, w), int)
    n = 0
    for y0, x0 in zip(*np.nonzero(orange)):
        if lab[y0, x0]:
            continue
        n += 1
        lab[y0, x0] = n
        q = deque([(y0, x0)])
        while q:
            y, x = q.popleft()
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    yy, xx = y + dy, x + dx
                    if 0 <= yy < h and 0 <= xx < w and orange[yy, xx] and not lab[yy, xx]:
                        lab[yy, xx] = n
                        q.append((yy, xx))
    big = sorted(range(1, n + 1), key=lambda i: (lab == i).sum(), reverse=True)[:3]
    # Left to right in the logo: the arrow (its head sits under the B), the line, the X.
    big.sort(key=lambda i: np.nonzero(lab == i)[1].min())
    arrow_id, stroke_id, x_id = big

    def part(ids):
        m = np.isin(lab, ids)
        # 1 px dilation keeps the anti-aliased edge the colour threshold misses.
        m = np.array(Image.fromarray((m * 255).astype(np.uint8)).filter(ImageFilter.MaxFilter(3))) > 0
        ys, xs = np.nonzero(m)
        y0, y1, x0, x1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
        sub = a[y0:y1, x0:x1].copy()
        sub[..., 3] = np.where(m[y0:y1, x0:x1], sub[..., 3], 0)
        return Image.fromarray(sub.astype(np.uint8), 'RGBA')

    return part([stroke_id, x_id]), part([stroke_id]), part([x_id]), part([arrow_id])


def small_mark(stroke, x):
    """The 16/32 px mark: line and X re-set with the wider gap and the larger X, 780 px tall."""
    st = fit(stroke, h=780)
    xx = fit(x, h=int(780 * X_HEIGHT * SMALL_X_SCALE))
    gap = int(780 * SMALL_GAP)
    out = Image.new('RGBA', (st.width + gap + xx.width, 780), (0, 0, 0, 0))
    out.alpha_composite(st, (0, 0))
    # keep the X centred on where the logo's X sits, despite being taller
    out.alpha_composite(xx, (st.width + gap, int(780 * X_TOP) - (xx.height - int(780 * X_HEIGHT)) // 2))
    return out


def draw_small_arrow(im, spec, color):
    """Straight one-pixel shaft with a left-pointing head, drawn crisp at the target size."""
    d = ImageDraw.Draw(im)
    y, x0, x1, head = spec['y'], spec['x0'], spec['x1'], spec['head']
    d.line((x0, y, x1, y), fill=color)
    for k in range(1, head + 1):
        d.point((x0 + k, y - k), fill=color)
        d.point((x0 + k, y + k), fill=color)


def tint(img, color):
    """Recolour, keeping the alpha."""
    out = Image.new('RGBA', img.size, color + (0,))
    out.putalpha(img.getchannel('A'))
    return out


def fit(img, w=None, h=None):
    W, H = img.size
    s = (h / H) if h else (w / W)
    return img.resize((max(1, round(W * s)), max(1, round(H * s))), Image.LANCZOS)


def embolden(img, px):
    """Thicken strokes by dilating the alpha, filled with the mark's own colour."""
    if px <= 0:
        return img
    arr = np.array(img)
    col = tuple(np.median(arr[..., :3][arr[..., 3] > 128], axis=0).astype(np.uint8))
    alpha = img.getchannel('A').filter(ImageFilter.MaxFilter(px * 2 + 1))
    out = Image.new('RGBA', img.size, col + (0,))
    out.putalpha(alpha)
    return out


def render(size, parts, bg, fg=None):
    """One icon. fg=None keeps the wordmark's orange; a colour tuple recolours the mark."""
    k, stroke, x, arrow = parts
    S = 1024
    canvas = Image.new('RGBA', (S, S), bg + (255,))
    if size <= 32:
        return render_small(size, stroke, x, canvas, bg, fg)
    with_arrow = size >= 96
    bold = BOLD.get(size, 0)
    if bold:
        k = embolden(fit(k, h=780), bold)
    kk = fit(k, h=int(S * K_HEIGHT))
    if fg:
        kk = tint(kk, fg)
    kx = (S - kk.width) // 2 + int(S * K_SHIFT)
    if with_arrow:
        ar = fit(arrow, w=int(S * ARROW_WIDTH))
        if fg:
            ar = tint(ar, fg)
        gap = int(S * ARROW_GAP)
        top = (S - (kk.height + gap + ar.height)) // 2
        ax = kx + kk.width + int(S * ARROW_TAIL_PAST_K) - ar.width
        ax = max(int(S * EDGE), min(ax, S - ar.width - int(S * EDGE)))
        canvas.alpha_composite(kk, (kx, top))
        canvas.alpha_composite(ar, (ax, top + kk.height + gap))
    else:
        canvas.alpha_composite(kk, (kx, (S - kk.height) // 2))
    return canvas.resize((size, size), Image.LANCZOS)


def render_small(size, stroke, x, canvas, bg, fg):
    """The 16/32 px optical size: re-set mark, centred above a band for the pixel arrow."""
    S = canvas.width
    arrow_spec = SMALL_ARROW.get(size)
    m = embolden(small_mark(stroke, x), BOLD[size])
    if fg:
        m = tint(m, fg)
    band = 0.20 if arrow_spec else 0.0
    mm = fit(m, h=int(S * (0.66 if arrow_spec else K_HEIGHT)))
    canvas.alpha_composite(mm, ((S - mm.width) // 2, int((S * (1 - band) - mm.height) // 2)))
    im = canvas.resize((size, size), Image.LANCZOS)
    if arrow_spec:
        draw_small_arrow(im, arrow_spec, fg or ORANGE)
    return im


def write_set(out_dir, parts, bg, fg):
    os.makedirs(out_dir, exist_ok=True)
    icons = {s: render(s, parts, bg, fg).convert('RGB') for s in SIZES}
    for s, im in icons.items():
        im.save(os.path.join(out_dir, f'favicon-{s}x{s}.png'), optimize=True)
    icons[ICO_SIZES[-1]].save(os.path.join(out_dir, 'favicon.ico'),
                              sizes=[(s, s) for s in ICO_SIZES],
                              append_images=[icons[s] for s in ICO_SIZES[:-1]])
    print(f'wrote {len(SIZES)} PNGs + favicon.ico to {os.path.relpath(out_dir, ROOT)}')


def main():
    parts = load_parts()
    write_set(os.path.join(ROOT, 'images'), parts, WHITE, None)
    write_set(os.path.join(ROOT, 'images', 'staging'), parts, STAGING_PURPLE, WHITE)


if __name__ == '__main__':
    main()
