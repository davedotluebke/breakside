#!/usr/bin/env python3
"""
Generate the favicon / app-icon set from the wordmark.

    python3 scripts/make-icons.py            # writes images/favicon-*.png, images/favicon.ico,
                                             # and the images/staging/ equivalents

The icon is the wordmark's "k" (the whiteboard X-player and its line), cut out
of images/logo.wordmark.dark.png as its two orange connected components, so it
stays pixel-faithful to the logo. Sizes from 96 px up add the arrow, shrunk to
run along the bottom with its tail ending just past the X. Smaller sizes drop
the arrow (it turns to mud under ~64 px) and thicken the strokes so the mark
still reads at 16 px.

Production is the orange mark on white (matching the app header); staging is a
white mark on the staging purple. All geometry is in fractions of a 1024 px
canvas, so every size shares one layout.

Needs Pillow and numpy.
"""
import os
from collections import deque

import numpy as np
from PIL import Image, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'images', 'logo.wordmark.dark.png')
SIZES = [16, 32, 48, 96, 192, 512]
ICO_SIZES = [16, 32, 48]

WHITE = (255, 255, 255)
STAGING_PURPLE = (224, 52, 235)   # the purple the previous staging icons used

# Layout, as fractions of the canvas.
K_HEIGHT = 0.76      # the mark's height
K_SHIFT = 0.08       # nudge the mark right so the arrow's head has room on the left
ARROW_WIDTH = 0.86
ARROW_GAP = 0.03     # between the mark's foot and the arrow
ARROW_TAIL_PAST_K = 0.06
EDGE = 0.04          # minimum margin the arrow keeps from the icon's edge
BOLD = {16: 14, 32: 8, 48: 4}   # stroke dilation (px at 780 px mark height) for tiny sizes


def load_parts():
    """Cut the mark (stroke + X) and the arrow out of the dark wordmark."""
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
    # The arrow starts far to the left (its head sits under the B); the other two are the k.
    arrow_id = min(big, key=lambda i: np.nonzero(lab == i)[1].min())

    def part(ids):
        m = np.isin(lab, ids)
        # 1 px dilation keeps the anti-aliased edge the colour threshold misses.
        m = np.array(Image.fromarray((m * 255).astype(np.uint8)).filter(ImageFilter.MaxFilter(3))) > 0
        ys, xs = np.nonzero(m)
        y0, y1, x0, x1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
        sub = a[y0:y1, x0:x1].copy()
        sub[..., 3] = np.where(m[y0:y1, x0:x1], sub[..., 3], 0)
        return Image.fromarray(sub.astype(np.uint8), 'RGBA')

    return part([i for i in big if i != arrow_id]), part([arrow_id])


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


def render(size, k, arrow, bg, fg=None):
    """One icon. fg=None keeps the wordmark's orange; a colour tuple recolours the mark."""
    S = 1024
    canvas = Image.new('RGBA', (S, S), bg + (255,))
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


def write_set(out_dir, k, arrow, bg, fg):
    os.makedirs(out_dir, exist_ok=True)
    icons = {s: render(s, k, arrow, bg, fg).convert('RGB') for s in SIZES}
    for s, im in icons.items():
        im.save(os.path.join(out_dir, f'favicon-{s}x{s}.png'), optimize=True)
    icons[ICO_SIZES[-1]].save(os.path.join(out_dir, 'favicon.ico'),
                              sizes=[(s, s) for s in ICO_SIZES],
                              append_images=[icons[s] for s in ICO_SIZES[:-1]])
    print(f'wrote {len(SIZES)} PNGs + favicon.ico to {os.path.relpath(out_dir, ROOT)}')


def main():
    k, arrow = load_parts()
    write_set(os.path.join(ROOT, 'images'), k, arrow, WHITE, None)
    write_set(os.path.join(ROOT, 'images', 'staging'), k, arrow, STAGING_PURPLE, WHITE)


if __name__ == '__main__':
    main()
