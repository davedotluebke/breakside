"""
Shared core of the two "say who" narration endpoints — the lineup for the
next point (narration_lineup.py, POST /api/narration/lineup) and the squads
of a scrimmage (narration_squads.py, POST /api/narration/squads).

Both turn a coach's spoken words into taps on a list of players, and both
work the same way: the MODEL only reports what was said — names, and for
anything that places people it did not name, a quote — and the SERVER
applies it. What that takes is here, once:

  - text normalization and the evidence checks (a quote must occur in the
    transcript; a removal quote must name the player it removes);
  - the lexicons that make a collective phrase verifiable: clear-everyone,
    "the rest", the gender-group words, the number in "two more";
  - the CLOSED ROSTER: a coach names only players on the roster, so a name
    the recognizer mangled is resolved to the one roster name it is closest
    to (_resolve_roster_name), and a name the model gave up on is found
    again through the model's own worksheet (_worksheet_phrase);
  - the prompt fragments both prompts are built from (prompt_* / rule_*),
    so a rule about names or gender words is written, and tuned, in one
    place;
  - the Anthropic transport and the reply-shaping helpers.

Each endpoint keeps what is its own: its request and response, its set
arithmetic, and the rules of its prompt that are about lines or squads.
"""
from __future__ import annotations

import difflib
import logging
import os
import re
from typing import Any, Dict, List, Optional

import httpx
from pydantic import BaseModel

logger = logging.getLogger(__name__)

# Dual-import pattern, mirroring narration.py / the rest of the backend.
try:
    from narration import _last_json_object  # type: ignore
except ImportError:
    from breakside_server.narration import _last_json_object  # type: ignore


def _anthropic_key() -> Optional[str]:
    return os.getenv("ANTHROPIC_API_KEY", "") or None


def _lineup_model() -> str:
    """Model for lineup extraction.

    NARRATION_LINEUP_MODEL wins; otherwise follow NARRATION_SLOW_MODEL so
    one env knob moves both narration passes; otherwise the same default
    as the finalize pass.
    """
    return (
        os.getenv("NARRATION_LINEUP_MODEL")
        or os.getenv("NARRATION_SLOW_MODEL")
        or "claude-sonnet-4-5-20250929"
    )


GENDER_GROUPS = ("FMP", "MMP")
ANY_GROUP = "ANY"
MAX_FILL_COUNT = 30


class RosterPlayer(BaseModel):
    name: str
    nickname: Optional[str] = None
    number: Optional[str] = None
    # "FMP" | "MMP"; anything else (or absent — clients before 2.27 did not
    # send it) is unknown and belongs to neither gender group.
    gender: Optional[str] = None


def _gender_of(p) -> Optional[str]:
    """A roster entry's gender group, or None when unknown."""
    gender = str(getattr(p, "gender", None) or "").strip().upper()
    return gender if gender in GENDER_GROUPS else None


# =============================================================================
# Text normalization
# =============================================================================

_QUOTED_SPAN_RE = re.compile(r"[\"\u2018\u2019\u201c\u201d'][^\"\u2018\u2019\u201c\u201d']*[\"\u2018\u2019\u201c\u201d']")
_DECOR_RE = re.compile(r"[0-9#()\[\].,_'\"-]+")


def _normalize_name(s: str) -> str:
    """Digits/decoration-tolerant form, mirroring lineupResolve.js
    normalizeName — rosters sometimes embed jersey numbers in the name
    string ("Jamal 23") while the model returns the cleaned name."""
    s = _QUOTED_SPAN_RE.sub(" ", str(s or "").lower())
    s = _DECOR_RE.sub(" ", s)
    return " ".join(s.split())


_TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"]
_UNITS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
          "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen",
          "seventeen", "eighteen", "nineteen"]


def _number_words(n: int) -> str:
    """0-99 as spoken words ('23' -> 'twenty three'), for matching jersey
    numbers inside quoted evidence."""
    if 0 <= n < 20:
        return _UNITS[n]
    if 20 <= n < 100:
        tens, unit = divmod(n, 10)
        return _TENS[tens] + (f" {_UNITS[unit]}" if unit else "")
    return str(n)


_LIGHT_STRIP_RE = re.compile(r"[^a-z0-9\s]+")


def _light_normalize(s: str) -> str:
    """Lowercase, strip punctuation, collapse whitespace — but KEEP digits
    (unlike _normalize_name) so quotes with jersey numbers stay checkable."""
    return " ".join(_LIGHT_STRIP_RE.sub(" ", str(s or "").lower()).split())


# =============================================================================
# Evidence: quotes, and the lexicons that make a collective phrase verifiable
# =============================================================================

def _evidence_in_transcript(said: str, transcript: str) -> bool:
    """The quoted removal words must actually occur in the transcript —
    a fabricated quote ('Priya comes off' when the coach only recited other
    names) fails this regardless of how plausible it sounds."""
    said_l = _light_normalize(said)
    return bool(said_l) and said_l in _light_normalize(transcript)


def _evidence_references_player(said: str, out_name: str, roster) -> bool:
    """Does the quoted removal evidence actually reference this player —
    by a name token, nickname token, or jersey number (digits or words)?
    'Line is Kris, Sam, ...' quoted as evidence for removing Priya
    references her in no way and is rejected."""
    said_norm_tokens = set(_normalize_name(said).split())
    name_tokens = set(_normalize_name(out_name).split())
    if said_norm_tokens & name_tokens:
        return True

    # Resolve the out-name to a roster entry for nickname/number checks.
    player = None
    for p in roster:
        if p.name == out_name or p.name.casefold() == out_name.casefold():
            player = p
            break
    if player is None:
        norm = _normalize_name(out_name)
        hits = [p for p in roster if _normalize_name(p.name) == norm]
        player = hits[0] if len(hits) == 1 else None
    if player is None:
        return False

    if player.nickname and set(_normalize_name(player.nickname).split()) & said_norm_tokens:
        return True
    if player.number:
        num = str(player.number).strip()
        if num and re.search(rf"(?<![0-9]){re.escape(num)}(?![0-9])", said):
            return True
        try:
            words = set(_number_words(int(num)).split())
        except ValueError:
            words = set()
        if words and words <= said_norm_tokens:
            return True
    return False


# Collective clear-everyone idioms, matched against the LIGHT-normalized
# quote ("Wholesale" is the app's clear button — coaches verb it; STT may
# split it "whole sale").
_CLEAR_LEXICON_RE = re.compile(
    r"whole ?sale"
    r"|every(one|body)('?s)?\s+(comes?\s+|goes?\s+)?(off|out)"
    r"|all\s+(the\s+)?players?\s+(come\s+|go\s+)?(off|out)"
    r"|clear\s+(the\s+|both\s+)?(line|list|selection|squads?|teams?)"
    r"|clear\s+every(one|body)"
    r"|(take|start)\s+every(one|body)\s+(off|over)"
    r"|start\s+(over|fresh)"
)


def _clear_evidence_ok(said: str, transcript: str) -> bool:
    """A voiced clear-everyone is honored only when its quote occurs in the
    transcript AND actually contains a collective-clear idiom — the same
    trust-but-verify stance as per-player outs, adapted for a phrase that
    by design names nobody."""
    if not said or not _evidence_in_transcript(said, transcript):
        return False
    return bool(_CLEAR_LEXICON_RE.search(_light_normalize(said)))


# "everyone else on Black" — and, inside a group quote, what makes "the rest
# of the FMPs" a rest rather than "all the FMPs". Matched against the
# light-normalized quote.
_REST_LEXICON_RE = re.compile(
    r"every(one|body)\s+else"
    r"|(the\s+)?rest\s+(of\s+)?"
    r"|(all\s+)?the\s+others?\b"
    r"|\bother\s"
    r"|(all\s+)?the\s+remaining"
    r"|\bremaining\b"
    r"|the\s+remainder"
    r"|\bleft\s*over"
)


# Words that name a gender group. FMP = female-matching player, MMP =
# male-matching player (the app's own terms, store/models.js Gender); GMP
# and BMP are the girl-/boy-matching spellings some teams use. Speech-to-
# text writes the initialisms every which way ("FMPs", "F.M.P.s", "FMP's"),
# and light normalization turns the punctuation into spaces.
_GROUP_LEXICON = {
    "FMP": re.compile(r"\b(f\s?m\s?p|g\s?m\s?p|females?|wom[ae]n|girls?|lad(y|ies)|gals?)(\s?s)?\b"),
    "MMP": re.compile(r"\b(m\s?m\s?p|b\s?m\s?p|males?|m[ae]n|guys?|boys?|dudes?|gentlem[ae]n|fellas?)(\s?s)?\b"),
}


_COUNT_SYNONYMS = {
    1: {"a", "an", "one", "another", "single"},
    2: {"couple", "pair"},
}


def _rest_evidence_ok(said: str, transcript: str) -> bool:
    if not said or not _evidence_in_transcript(said, transcript):
        return False
    return bool(_REST_LEXICON_RE.search(_light_normalize(said)))


def _group_evidence_ok(said: str, group: str, transcript: str) -> bool:
    """A group phrase is honored only when its quote occurs in the transcript
    and, for a gender group, actually contains a word for THAT group — a
    model that reports "the FMPs" from a quote about "the guys" is refused."""
    if not said or not _evidence_in_transcript(said, transcript):
        return False
    if group == ANY_GROUP:
        return True
    lexicon = _GROUP_LEXICON.get(group)
    return bool(lexicon and lexicon.search(_light_normalize(said)))


def _group_in_quote(said: str) -> Optional[str]:
    """The gender group a quote names, when it names exactly one."""
    norm = _light_normalize(said)
    hits = [g for g in GENDER_GROUPS if _GROUP_LEXICON[g].search(norm)]
    return hits[0] if len(hits) == 1 else None


def _count_evidence_ok(said: str, count: int) -> bool:
    """The number in a "two more FMPs" must be in the quote — as digits, as
    words, or as one of the few idioms for one and two."""
    norm = _light_normalize(said)
    tokens = set(norm.split())
    if re.search(rf"(?<![0-9]){count}(?![0-9])", norm):
        return True
    words = set(_number_words(count).split())
    if words and words <= tokens:
        return True
    return bool(_COUNT_SYNONYMS.get(count, set()) & tokens)


def _group_key(spoken: Any) -> Optional[str]:
    g = str(spoken or "").strip().upper()
    if g in GENDER_GROUPS or g == ANY_GROUP:
        return g
    return None


# Words that take somebody OFF rather than putting them on. Matched against
# the light-normalized text (apostrophes are already spaces: "isn t here").
_REMOVAL_RE = re.compile(
    r"\bsits?\b|\bsitting\b|\bis out\b|\bs out\b|\bare out\b|\bisn t here\b|\bnot here\b"
    r"|\binjured\b|\bhurt\b|\boff\b|\babsent\b|\bcan t (make|play)\b"
    r"|\b(comes?|coming|goes?|going)\s+out\b|\btakes?\s+a\s+break\b|\bresting\b|\brests?\b"
)


# The coach handing the picking to the app's Auto button: "auto the rest",
# "auto-pick the FMPs", "auto-select everybody else", "autofill". The word
# itself is the evidence; no other phrasing ("fill in the rest", "that
# completes the line") is taken for it. Matched against light-normalized
# text, where "auto-pick" has become "auto pick".
_AUTO_LEXICON_RE = re.compile(r"\bauto\w*\b")
# A recognizer can write the word as the name "Otto". Honored only when
# nobody on the roster answers to it.
_AUTO_MISHEARD = "otto"
# "the rest" is who is left, not somebody resting: taken out before a quote
# is tested for removal words (_REMOVAL_RE has "rest" / "rests").
_THE_REST_RE = re.compile(r"\bthe\s+rest\b")


def _roster_has_first_name(roster, word: str) -> bool:
    for p in roster or ():
        for label in (getattr(p, "name", None), getattr(p, "nickname", None)):
            tokens = _normalize_name(label or "").split()
            if tokens and tokens[0] == word:
                return True
    return False


def _auto_evidence_ok(said: str, roster=()) -> bool:
    """Whether a quote hands the picking to Auto: it must contain the word."""
    norm = _light_normalize(said)
    if _AUTO_LEXICON_RE.search(norm):
        return True
    return (_AUTO_MISHEARD in norm.split()
            and not _roster_has_first_name(roster, _AUTO_MISHEARD))


def _is_auto_word(heard: str) -> bool:
    """A model's "unmatched" reference that is only the word itself."""
    norm = _light_normalize(heard)
    return norm == _AUTO_MISHEARD or bool(_AUTO_LEXICON_RE.fullmatch(norm))


def _has_removal_words(said: str) -> bool:
    """Removal words in a group phrase's quote, "the rest" aside."""
    return bool(_REMOVAL_RE.search(_THE_REST_RE.sub(" ", _light_normalize(said))))


# =============================================================================
# The closed roster: resolving a name as heard
# =============================================================================

# A heard name is taken for a roster player when it is at least this similar
# to one of their names and clearly more similar than to anyone else's.
_CLOSEST_MIN_SCORE = 0.65
_CLOSEST_MIN_MARGIN = 0.1


def _exact_roster_name(name: str, roster) -> Optional[str]:
    """The roster's own spelling for ``name`` when it IS a roster name:
    exact → casefold → nickname → unique normalized (the frontend matcher's
    ladder, narration/lineupResolve.js matchRosterPlayer), or a jersey number
    exactly one player wears."""
    wanted = str(name or "").strip()
    if not wanted:
        return None
    for p in roster:
        if p.name == wanted:
            return p.name
    folded = wanted.casefold()
    for p in roster:
        if p.name.casefold() == folded:
            return p.name
    for p in roster:
        if p.nickname and str(p.nickname).casefold() == folded:
            return p.name
    norm = _normalize_name(wanted)
    if norm:
        hits = [p for p in roster if _normalize_name(p.name) == norm]
        if len(hits) == 1:
            return hits[0].name
    # A bare jersey number ("7", "#7") that exactly one player wears.
    digits = wanted.lstrip("#").strip()
    if digits.isdigit():
        hits = [p for p in roster if str(p.number or "").strip() == digits]
        if len(hits) == 1:
            return hits[0].name
    return None


def _name_similarity(heard: str, candidate: str) -> float:
    if not heard or not candidate:
        return 0.0
    score = difflib.SequenceMatcher(None, heard, candidate).ratio()
    # Recognizers get the start of a name right far more often than the
    # rest; a shared first letter separates "Mya" → Mia from the Omar that
    # merely shares its letters.
    if heard[0] == candidate[0]:
        score = min(1.0, score + 0.05)
    # A clipped name ("Char" for Charlie) is a prefix, which the ratio
    # alone undersells.
    if len(heard) >= 3 and candidate.startswith(heard):
        score = max(score, 0.85)
    return score


def _closest_roster_name(heard: str, roster) -> Optional[str]:
    """The ONE roster player a mangled name most plausibly is, or None.

    The roster is closed — a coach setting up a scrimmage names only people
    on the team — so a name the recognizer wrote wrongly ("Dayna", "Chris",
    "Zoey") is somebody on it. Compared against each player's full name, each
    word of it and their nickname; taken only when the best score clears
    _CLOSEST_MIN_SCORE and beats the runner-up by _CLOSEST_MIN_MARGIN, so a
    name that could be two players stays unmatched rather than guessed.
    """
    norm = _normalize_name(heard)
    forms = {norm} | {t for t in norm.split() if len(t) >= 3}
    forms = {f for f in forms if len(f) >= 3}
    if not forms:
        return None
    scored = []
    for p in roster:
        cands = set()
        for source in (p.name, p.nickname):
            n = _normalize_name(source or "")
            if n:
                cands.add(n)
                cands.update(n.split())
        best = max((_name_similarity(f, c) for f in forms for c in cands), default=0.0)
        scored.append((best, p.name))
    scored.sort(key=lambda t: t[0], reverse=True)
    if not scored:
        return None
    best, name = scored[0]
    runner_up = scored[1][0] if len(scored) > 1 else 0.0
    if best >= _CLOSEST_MIN_SCORE and best - runner_up >= _CLOSEST_MIN_MARGIN:
        return name
    return None


def _resolve_roster_name(name: str, roster):
    """(roster name | None, resolved_by_closest)."""
    exact = _exact_roster_name(name, roster)
    if exact is not None:
        return exact, False
    closest = _closest_roster_name(name, roster)
    return closest, closest is not None


def _quote_names_player(said: str, roster_name: str, roster) -> bool:
    """Does a quote refer to this player once mangled names are allowed for?
    The strict check first (a name, nickname or number token); failing that,
    any word of the quote that resolves — as a heard name — to this player
    and to nobody else ("Dayna sits out" names Dana)."""
    if _evidence_references_player(said, roster_name, roster):
        return True
    for token in _normalize_name(said).split():
        if len(token) >= 3 and _closest_roster_name(token, roster) == roster_name:
            return True
    return False


def _worksheet_phrase(heard: str, phrases, transcript: str) -> Optional[Dict[str, Any]]:
    """The worksheet phrase a heard word was spoken in, or None.

    Both prompts have the model cut the transcript into phrases before it
    answers. When it then gives up on a name ("unmatched") that the closed
    roster can resolve, the phrase says what the coach was doing with it.
    Only a phrase that really occurs in the transcript counts — the
    worksheet is the model's, and is trusted no further than a quote.
    """
    word = _light_normalize(heard)
    if not word:
        return None
    for ph in phrases or []:
        if not isinstance(ph, dict):
            continue
        words = _light_normalize(ph.get("words", ""))
        if not words or f" {word} " not in f" {words} ":
            continue
        if not _evidence_in_transcript(ph.get("words", ""), transcript):
            continue
        return ph
    return None


# =============================================================================
# Prompt fragments shared by both prompts
# =============================================================================

def _roster_line(p) -> str:
    """One roster line of a prompt: name, "nickname", #number, [group]."""
    parts = [p.name]
    if p.nickname:
        parts.append(f'"{p.nickname}"')
    if p.number:
        parts.append(f"#{p.number}")
    gender = _gender_of(p)
    if gender:
        parts.append(f"[{gender}]")
    return "- " + " ".join(parts)


def prompt_roster(roster) -> str:
    """The roster section both prompts open with."""
    block = "\n".join(_roster_line(p) for p in roster)
    return (
        'Team roster. This list is CLOSED: these are the only people the coach can be talking about. '
        'Each line is the name, then an optional "nickname" in quotes, an optional #jersey-number, and '
        '(when known) the player\'s gender group in brackets ([FMP] female-matching, [MMP] male-matching). '
        'Match spoken references against the name, the "nickname" and the #jersey-number:\n'
        f"{block}"
    )


def prompt_transcript(transcript: str) -> str:
    return (
        "Transcript of what the coach said (speech-to-text; names are often transcribed wrongly, "
        "and there may be unrelated chatter):\n"
        "---\n"
        f"{transcript}\n"
        "---"
    )


def prompt_worksheet(example: str, beside: str) -> str:
    """The worksheet instruction: the model cuts the transcript into phrases
    FIRST and answers from them. It is what stops a small model carrying one
    phrase's meaning into the next, and what _worksheet_phrase reads when
    the model gives up on a name."""
    return (
        f'Fill "phrases" FIRST, as a worksheet: cut the transcript into its phrases in the order spoken '
        f"({example}), and beside each write {beside}. Then build everything else from the worksheet, "
        "one phrase at a time: what a phrase says applies to the players in that phrase and to no other phrase's."
    )


def rule_closed_roster(n, name_field: str, kept: str = "") -> str:
    """The names rule, shared word for word: the roster is closed, so a
    mangled name is somebody on it. ``name_field`` is where a name goes in
    this prompt's reply; ``kept`` is what an as-heard name keeps."""
    return (
        f"{n}. THE ROSTER IS CLOSED, and speech-to-text mangles names. A name-like word that is not spelled "
        "like anyone on the roster is a MISHEARING of somebody who is — never a different person. "
        '"Dayna" on a roster with a Dana IS Dana; "Chris" is Kris; "Zoey" is Zoe; "Jakes" is Jake. '
        f'Put the ROSTER spelling in {name_field} and do NOT also list the word in "unmatched". Only when a '
        "name-like word sounds equally like two roster players, or like none of them, put it in "
        f"{name_field} exactly AS HEARD{kept} — the app will resolve it or tell the coach. Spoken references "
        'may also be full names, nicknames or jersey numbers ("number 12", "twelve", "#12"); a trailing '
        'initial or fragment ("Morgan V", "Morgan MV") disambiguates similarly-named players. Spell every '
        "resolved name EXACTLY as its roster line spells the name — digits and symbols included when they "
        'are part of the name itself ("Jamal 23", "23 Jamal", "Jamal #23"), never a cleaned-up version, and '
        'never with the "nickname", #jersey-number or [group] decorations appended. "unmatched" is only for '
        'references you could not turn into a player at all ("the new kid", "what\'s-his-name").'
    )


def rule_gender_words() -> str:
    """Which spoken words mean which gender group — one list for both prompts."""
    return (
        '   - Gender words: FMP = "FMP(s)", "GMP(s)" (girl-matching player — a real term some teams use; '
        'it is NOT a mishearing of MMP), "female players", "female-matching players", "women", "girls", '
        '"ladies". MMP = "MMP(s)", "BMP(s)" (boy-matching player), "male players", "male-matching players", '
        '"men", "guys", "boys". Use "ANY" only for a number with no gender word.'
    )


# ── Anthropic transport and reply shaping ────────────────────────────────

async def _call_claude_json(api_key: str, prompt: str, anchor_key: str) -> Dict[str, Any]:
    """POST the prompt to the Anthropic Messages API and return the LAST JSON
    object in the reply that has ``anchor_key`` (smaller models sometimes
    emit a wrong object, reconsider, and emit a corrected one).

    Raises on transport/API/parse failure — the endpoints convert that to
    an error payload.
    """
    model = _lineup_model()
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(
            "https://api.anthropic.com/v1/messages",
            headers={
                "x-api-key": api_key,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            },
            json={
                "model": model,
                "max_tokens": 1024,
                "messages": [{"role": "user", "content": prompt}],
            },
        )
    if resp.status_code != 200:
        raise RuntimeError(f"Anthropic API {resp.status_code}: {resp.text[:500]}")

    body = resp.json()
    text = "".join(
        block.get("text", "") for block in body.get("content", []) if block.get("type") == "text"
    ).strip()
    return _last_json_object(text, anchor_key)


def _shape_out_entries(raw) -> List[Dict[str, str]]:
    """"out" as [{name, said}]; a bare string is an entry with no evidence."""
    outs = []
    for entry in raw if isinstance(raw, list) else []:
        if isinstance(entry, dict) and entry.get("name"):
            outs.append({"name": str(entry["name"]), "said": str(entry.get("said") or "")})
        elif isinstance(entry, (str, int)) and not isinstance(entry, bool):
            outs.append({"name": str(entry), "said": ""})
    return outs


def _shape_groups(raw, extra_key: str) -> List[Dict[str, Any]]:
    """"groups" as [{group, <extra_key>, count, said}]; ``extra_key`` is the
    endpoint's own field ("squad" for squads, "does" for lineups). A count
    is an int or None."""
    groups = []
    for entry in raw if isinstance(raw, list) else []:
        if not isinstance(entry, dict):
            continue
        count = entry.get("count")
        if isinstance(count, str) and count.strip().isdigit():
            count = int(count.strip())
        if isinstance(count, bool) or not isinstance(count, int):
            count = None
        groups.append({
            "group": str(entry.get("group") or ""),
            extra_key: str(entry.get(extra_key) or ""),
            "count": count,
            "said": str(entry.get("said") or ""),
        })
    return groups


def _shape_phrases(raw, extra_key: str) -> List[Dict[str, str]]:
    """The worksheet as [{words, <extra_key>}]."""
    phrases = []
    for entry in raw if isinstance(raw, list) else []:
        if isinstance(entry, dict) and entry.get("words"):
            phrases.append({"words": str(entry["words"]), extra_key: str(entry.get(extra_key) or "")})
    return phrases


def _verified_group(entry: Dict[str, Any], transcript: str):
    """(group, count) for a "groups" entry that passes its evidence checks,
    else (None, reason). The gender group is read from the QUOTE when the
    quote names exactly one — it outranks the model's label, because models
    take "GMPs" for a mishearing of "MMPs" — and a count must be in the
    quote, as digits, words, or an idiom for one or two."""
    group = _group_key(entry.get("group"))
    said = str(entry.get("said") or "").strip()
    quoted = _group_in_quote(said)
    if quoted is not None:
        group = quoted
    if group is None or not _group_evidence_ok(said, group, transcript):
        return None, "<group>"
    count = entry.get("count")
    if isinstance(count, bool) or not isinstance(count, int):
        count = None
    if count is not None and (not (1 <= count <= MAX_FILL_COUNT) or not _count_evidence_ok(said, count)):
        return None, "<group:count>"
    return (group, count), None
