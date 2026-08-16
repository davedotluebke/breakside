#!/usr/bin/env python3
"""Keep the two-theme color palette honest.

Run after any color work:  ./scripts/lint-css-tokens.py

Three checks, each of which catches a class of bug that light mode hides and
dark mode exposes (see ARCHITECTURE.md § Theming):

  1. RAW COLORS — a hex/rgb literal outside css/tokens.css. It cannot flip with
     the theme, so it is either invisible or glaring in one of them.

  2. ROLE MISMATCH — a token used in the wrong property. A `--surface-*` in a
     `color:` is fine in light mode by accident (pale surfaces, pale text) and
     vanishes the moment the palette inverts. Likewise a `--text-*` as a fill.

  3. PALETTE PARITY — a :root token with no `:root[data-theme="dark"]`
     counterpart (it would keep its light value on a black page), a dark-only
     token, or a token nothing references.

Exits non-zero if anything is found.
"""
import glob
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TOKENS = ROOT / 'css' / 'tokens.css'

# Every stylesheet that participates in the app's theme. The landing page, the
# invite page and the public viewer are self-contained and deliberately absent.
SHEETS = (sorted(glob.glob(str(ROOT / 'css' / '*.css')))
          + [str(ROOT / 'ui' / 'panelSystem.css')]
          + sorted(glob.glob(str(ROOT / 'narration' / '*.css')))
          + sorted(glob.glob(str(ROOT / 'playByPlay' / '*.css'))))

# auth/auth.css draws its own dark blue gradient in BOTH themes; it is exempt
# from the raw-color rule by design.
RAW_EXEMPT = {str(ROOT / 'css' / 'tokens.css')}
# fieldPbp.css keeps its own light+dark pitch palette next to each other, for
# the same reason tokens.css keeps the app's: it is a palette definition.
PALETTE_FILES = {str(ROOT / 'playByPlay' / 'fieldPbp.css')}

COMMENT_RE = re.compile(r'/\*.*?\*/', re.S)
DECL_RE = re.compile(r'(^|[{;])\s*([-a-zA-Z]+)\s*:\s*([^;{}]*?)(?=[;}])', re.S | re.M)
VAR_USE_RE = re.compile(r'var\(\s*(--[-a-zA-Z0-9]+)')
VAR_DEF_RE = re.compile(r'^\s*(--[-a-zA-Z0-9]+)\s*:\s*([^;]+);', re.M)
COLOR_RE = re.compile(
    r'#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|\b(?:white|black|grey|gray)\b')
VAR_SPAN_RE = re.compile(r'var\(\s*--[-a-zA-Z0-9]+\s*(?:,[^)]*)?\)')

# token prefix (or exact name) -> the property roles it is allowed in
ROLES = {
    'surface-': {'bg'}, 'text-': {'fg'}, 'ink-': {'fg'},
    'border-': {'border', 'bg', 'shadow'},   # hairlines are drawn all three ways
    'shadow-': {'shadow'},
    'gray-chrome': {'bg'}, 'gray-dark': {'bg'}, 'grip': {'bg'},
    'btn-': {'bg', 'fg'},                    # --btn-disabled-text is a fg
    'muted-': {'bg'}, 'wash': {'bg'}, 'wash-': {'bg'},
    'overlay-': {'bg'}, 'on-overlay': {'fg'},
    'ink-faint': {'fg'}, 'ink-dim': {'fg'},
    'table-sticky-edge': {'shadow', 'border'},
    'timer-': {'fg'},
    'white': {'fg', 'bg', 'border', 'shadow'},
    'black': {'fg', 'bg', 'border', 'shadow'},
}
# Tokens whose light value is intentionally identical in dark.
INVARIANT = {'--white', '--black', '--overlay-scrim', '--overlay-scrim-strong',
             '--on-overlay', '--on-overlay-muted', '--pbp-chip-num'}


def blank_comments(text):
    return COMMENT_RE.sub(lambda m: '\n' * m.group(0).count('\n'), text)


def role_of(prop):
    p = prop.lower()
    if p.startswith('background'):
        return 'bg'
    if p in ('color', 'caret-color', '-webkit-text-fill-color', 'fill', 'stroke'):
        return 'fg'
    if p.startswith(('border', 'outline', 'column-rule')):
        return 'border'
    if 'shadow' in p:
        return 'shadow'
    return None


def is_chromatic(literal):
    """True if the color carries hue (a glow), False if it is a grey/black."""
    m = re.match(r'rgba?\(([^)]+)\)', literal)
    if m:
        try:
            r, g, b = [float(x) for x in m.group(1).split(',')[:3]]
        except ValueError:
            return False
    elif literal.startswith('#'):
        h = literal[1:]
        if len(h) in (3, 4):
            h = ''.join(c * 2 for c in h[:3])
        try:
            r, g, b = (int(h[i:i + 2], 16) for i in (0, 2, 4))
        except ValueError:
            return False
    else:
        return False
    return max(r, g, b) - min(r, g, b) > 12


def rel(path):
    return str(Path(path).relative_to(ROOT))


def check_raw_colors():
    bad = []
    for f in SHEETS:
        if f in RAW_EXEMPT or f in PALETTE_FILES:
            continue
        text = blank_comments(Path(f).read_text())
        for m in DECL_RE.finditer(text):
            prop, value = m.group(2), m.group(3)
            if role_of(prop) is None:
                continue
            stripped = VAR_SPAN_RE.sub('', value)   # var() fallbacks are fine
            for lit in COLOR_RE.findall(stripped):
                # A COLORED glow under a saturated button is tinted to that
                # button's own fill and reads the same against either page, so
                # it is allowed to stay a literal. A NEUTRAL drop shadow is the
                # one that renders as nothing on black; those must use a
                # --shadow-* preset, which becomes a ring in dark mode.
                if 'shadow' in prop.lower() and is_chromatic(lit):
                    continue
                line = text[:m.start()].count('\n') + 1
                bad.append(f'{rel(f)}:{line}  {prop}: …{lit}…  '
                           f'[raw color — add a token to css/tokens.css]')
    return bad


def check_roles():
    bad = []
    for f in SHEETS:
        if f in RAW_EXEMPT:
            continue
        text = blank_comments(Path(f).read_text())
        for m in DECL_RE.finditer(text):
            prop, value = m.group(2), m.group(3)
            role = role_of(prop)
            if role is None:
                continue
            line = text[:m.start()].count('\n') + 1
            for var in VAR_USE_RE.findall(value):
                name = var[2:]
                for prefix, allowed in ROLES.items():
                    if name == prefix or name.startswith(prefix):
                        if role not in allowed:
                            bad.append(f'{rel(f)}:{line}  {prop}: var({var})  '
                                       f'[{role} use of a {prefix}* token]')
                        break
    return bad


def check_parity():
    src = TOKENS.read_text()
    split = src.index('\n:root[data-theme="dark"] {')
    light = dict(VAR_DEF_RE.findall(src[:split]))
    dark = dict(VAR_DEF_RE.findall(src[split:]))

    used = set()
    for f in SHEETS + [str(ROOT / 'index.html')]:
        if f == str(TOKENS):
            continue
        used |= set(VAR_USE_RE.findall(Path(f).read_text()))

    bad = []
    bad += [f'css/tokens.css  {k} has no dark counterpart'
            for k in light if k not in dark and k not in INVARIANT]
    bad += [f'css/tokens.css  {k} is defined only in the dark block'
            for k in dark if k not in light]
    bad += [f'css/tokens.css  {k} is never referenced' for k in light if k not in used]
    return bad, len(light)


def main():
    raw, roles = check_raw_colors(), check_roles()
    parity, n = check_parity()
    for label, rows in (('RAW COLORS', raw), ('ROLE MISMATCHES', roles),
                        ('PALETTE PARITY', parity)):
        print(f'\n{label}: {len(rows)}')
        for r in rows:
            print(f'  {r}')
    total = len(raw) + len(roles) + len(parity)
    print(f'\n{n} tokens; {total} problem(s).')
    return 1 if total else 0


sys.exit(main())
