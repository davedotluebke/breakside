"""
Squads narration endpoint — speech-to-squads for the scrimmage dialog.

POST /api/narration/squads
    The coach, setting up a scrimmage (teams/scrimmageDialogs.js), says who
    goes on which squad — "Alice and Bob on Orange, Dana on Black", "Eve
    sits out", "everyone else on Black", "the rest of the FMPs on Orange",
    "two more guys on Black" — and the model only reports it. The endpoint
    maps squad words to the two squad keys, puts every UNSTATED placement
    on the FIRST squad (the one rule a coach who just rattles off names
    relies on), resolves names the recognizer mangled against the closed
    roster, verifies the evidence for sit-outs, a clear and the collective
    phrases and expands those itself (_apply_squad_changes), and hands a
    verified count back for the picker to choose. Requires Coach or Stat
    Keeper access to the ``teamId`` in the body (whoever may start the
    scrimmage may narrate its squads) — there is no game yet when a
    scrimmage is being set up.

The sibling of narration_lineup.py (the next point's line); what the two
share — evidence checks, lexicons, the closed roster, prompt fragments, the
model call — is narration_common.py. The frontend counterpart is
narration/squadNarration.js.

Four things are the server's, not the model's:
  - the DEFAULT SQUAD: a name read out with no squad means the first squad;
    the model leaves the squad blank and the server fills it in;
  - the CLOSED ROSTER: a name the recognizer mangled is resolved to the one
    roster name it is closest to when the model did not do so itself;
  - COLLECTIVE phrases, which the model only reports, with a quote; the
    server verifies the quote and expands it over the roster, skipping
    anyone who is not here today and, for a "rest", anyone the coach has
    already placed (roster[].pinned);
  - COUNTS — "two more FMPs on Dark" — which nobody on the server picks:
    the verified instruction goes back as a ``fill`` and the picker chooses,
    with the same balance rules as its Auto button.

And a VOICED AUTO — "auto the rest", "auto-select everybody else", "auto-pick
the FMPs" — is the Auto button by voice: verified here (the quote must hold
the word "auto" and name no squad) and returned as ``voiced_auto`` for the
picker to deal.
"""
from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

# Dual-import pattern, mirroring narration.py / the rest of the backend.
try:
    from auth import get_json_body, require_body_team_recorder  # type: ignore
except ImportError:
    from breakside_server.auth import (  # type: ignore
        get_json_body,
        require_body_team_recorder,
    )

try:
    from narration import parse_body  # type: ignore
except ImportError:
    from breakside_server.narration import parse_body  # type: ignore

try:
    import narration_common as common  # type: ignore
    from narration_common import (  # type: ignore
        ANY_GROUP, GENDER_GROUPS, RosterPlayer,
        _REMOVAL_RE, _REST_LEXICON_RE,
        _anthropic_key, _auto_evidence_ok, _clear_evidence_ok, _evidence_in_transcript, _gender_of,
        _group_in_quote, _has_removal_words, _is_auto_word, _light_normalize, _normalize_name, _quote_names_player, _resolve_roster_name,
        _rest_evidence_ok, _shape_groups, _shape_out_entries, _shape_phrases,
        _verified_group, _worksheet_phrase,
        prompt_roster, prompt_transcript, prompt_worksheet, rule_closed_roster, rule_gender_words,
    )
except ImportError:
    from breakside_server import narration_common as common  # type: ignore
    from breakside_server.narration_common import (  # type: ignore
        ANY_GROUP, GENDER_GROUPS, RosterPlayer,
        _REMOVAL_RE, _REST_LEXICON_RE,
        _anthropic_key, _auto_evidence_ok, _clear_evidence_ok, _evidence_in_transcript, _gender_of,
        _group_in_quote, _has_removal_words, _is_auto_word, _light_normalize, _normalize_name, _quote_names_player, _resolve_roster_name,
        _rest_evidence_ok, _shape_groups, _shape_out_entries, _shape_phrases,
        _verified_group, _worksheet_phrase,
        prompt_roster, prompt_transcript, prompt_worksheet, rule_closed_roster, rule_gender_words,
    )


router = APIRouter(prefix="/api/narration", tags=["narration-squads"])

SQUAD_KEYS = ("X", "Y")


class SquadsRosterPlayer(RosterPlayer):
    # The picker's "here today" box. A player who is not here is never
    # swept up by a collective phrase or picked for a count — only naming
    # them puts them on a squad.
    here: bool = True
    # Placed on a squad by the coach (a tap, or an earlier narration), as
    # opposed to dealt there by Auto. "Everyone else" and "the rest of the
    # FMPs" leave pinned players where the coach put them.
    pinned: bool = False


class SquadsRequest(BaseModel):
    # Authorization is against the TEAM (require_body_team_recorder): a new
    # scrimmage has no game yet when its squads are being called.
    teamId: str
    transcript: str = Field(max_length=8000)
    # The whole team roster (everyone the picker lists), not one squad's.
    roster: List[SquadsRosterPlayer] = Field(max_length=60)
    # {"X": "Dark", "Y": "Light"} — what the coach calls the two squads.
    squad_names: Dict[str, str]
    # Who is on each squad now, by roster name — the picker's current state,
    # which the voiced placements are applied to (an unnamed player stays put).
    current_squads: Dict[str, List[str]] = {}


class SquadPlacement(BaseModel):
    name: str
    squad: str  # "X" | "Y"


class SquadGroupMove(BaseModel):
    group: str  # "FMP" | "MMP"
    squad: str  # "X" | "Y"
    scope: str  # "all" | "rest"


class SquadFill(BaseModel):
    """A verified "N more <group> on <squad>": the picker chooses who."""
    squad: str  # "X" | "Y"
    group: str  # "FMP" | "MMP" | "ANY"
    count: int


class SquadsResponse(BaseModel):
    # The resulting squads, derived server-side: {"X": [...], "Y": [...]},
    # before any ``fills`` are picked.
    squads: Dict[str, List[str]]
    # Players voiced off both squads (evidence-verified), in spoken order.
    out: List[str] = []
    # Counts for the picker to fill, in spoken order, after ``squads``.
    fills: List[SquadFill] = []
    unmatched: List[str] = []
    note: str = ""
    error: Optional[str] = None
    # Observability: what the model voiced, after the default-squad rule
    # and name resolution.
    voiced_assign: List[SquadPlacement] = []
    voiced_clear: bool = False
    # The squad an honored "everyone else on …" sent the unnamed players to.
    voiced_rest: Optional[str] = None
    voiced_groups: List[SquadGroupMove] = []
    # The coach handed the placing to Auto ("auto the rest", "auto-pick the
    # FMPs"): "ANY", or the gender group to deal. The picker deals whoever
    # is here and on neither squad, after everything above — the Auto
    # button's own deal.
    voiced_auto: List[str] = []


async def _squads_request(
    body: Dict[str, Any] = Depends(get_json_body)
) -> SquadsRequest:
    return parse_body(SquadsRequest, body)


@router.post("/squads", response_model=SquadsResponse)
async def extract_squads(
    user: dict = Depends(require_body_team_recorder),
    req: SquadsRequest = Depends(_squads_request),
):
    """
    Place players on a scrimmage's squads from the coach's spoken narration.

    Same error contract as /lineup: 503 without a key, 200 with ``error``
    set (and the current squads echoed back unchanged) when the model call
    fails — the client applies nothing that carries an error.
    """
    anthropic_key = _anthropic_key()
    if not anthropic_key:
        raise HTTPException(
            status_code=503,
            detail="Lineup narration unavailable: ANTHROPIC_API_KEY not configured",
        )

    unchanged = _current_squads(req)
    if not req.transcript.strip():
        return SquadsResponse(squads=unchanged, error="Empty transcript")
    if not req.roster:
        return SquadsResponse(squads=unchanged, error="Empty roster")
    if not all(str(req.squad_names.get(k) or "").strip() for k in SQUAD_KEYS):
        return SquadsResponse(squads=unchanged, error="Both squad names are required")

    prompt = _build_squads_prompt(req)
    try:
        result = await _call_claude_squads(anthropic_key, prompt)
    except Exception as e:  # noqa: BLE001 — degrade to an error payload, never a 500
        logger.exception("Squad extraction LLM call failed")
        return SquadsResponse(squads=unchanged, error=str(e))

    d = _derive_squads(result, req)
    # Counts only — no names, no transcript: enough to tell, from the log,
    # whether a "that didn't work" was the recognizer, the model or a guard.
    logger.info(
        "Squads: placed=%d out=%d groups=%d fills=%d auto=%d rest=%s clear=%s "
        "unmatched=%d resolved_by_closest=%d dropped=%d",
        len(d.assign), len(d.outs), len(d.groups), len(d.fills), len(d.autos), d.rest, d.cleared,
        len(d.unmatched), len(d.resolved), len(d.dropped),
    )
    note = str(result.get("note") or "")
    return SquadsResponse(
        squads=d.squads, out=d.outs, unmatched=d.unmatched, note=note,
        fills=[SquadFill(squad=k, group=g, count=n) for g, k, n in d.fills],
        voiced_assign=[SquadPlacement(name=n, squad=s) for n, s in d.assign],
        voiced_clear=d.cleared, voiced_rest=d.rest,
        voiced_groups=[SquadGroupMove(group=g, squad=k, scope=s) for g, k, s in d.groups],
        voiced_auto=d.autos,
    )


def _current_squads(req: SquadsRequest) -> Dict[str, List[str]]:
    return {k: [str(n) for n in (req.current_squads.get(k) or [])] for k in SQUAD_KEYS}


def _squad_key(spoken: str, squad_names: Dict[str, str]) -> Optional[str]:
    """Map the model's squad field to "X" / "Y".

    Accepts the squad's name (case-insensitive, decoration-tolerant), the
    key letter itself, or a blank — which is the default-squad rule: None
    is returned ONLY for a non-empty string that names neither squad, so
    the caller can tell "unstated" (→ first squad) from "unrecognised".
    """
    raw = str(spoken or "").strip()
    if not raw:
        return SQUAD_KEYS[0]
    norm = _normalize_name(raw)
    for key in SQUAD_KEYS:
        if norm and norm == _normalize_name(squad_names.get(key, "")):
            return key
    if raw.upper() in SQUAD_KEYS:
        return raw.upper()
    for key in SQUAD_KEYS:
        name_norm = _normalize_name(squad_names.get(key, ""))
        if norm and name_norm and (norm in name_norm.split() or name_norm in norm.split()):
            return key
    return None


def _squad_in_quote(said: str, squad_names: Dict[str, str]) -> Optional[str]:
    """The squad a quote names — by its whole name or a word of it, the same
    latitude _squad_key gives the model — when it names exactly ONE. None
    for neither and for both ("auto the rest between Orange and Black")."""
    tokens = _light_normalize(said).split()
    padded = f" {' '.join(tokens)} "
    hits = []
    for key in SQUAD_KEYS:
        name = _normalize_name(squad_names.get(key, ""))
        if name and (f" {name} " in padded or any(len(t) >= 3 and t in tokens for t in name.split())):
            hits.append(key)
    return hits[0] if len(hits) == 1 else None


def _hands_to_auto(said: str, req: "SquadsRequest") -> bool:
    """Whether a quote (already known to be in the transcript) hands the
    placing to the picker's Auto: it holds the word "auto", takes nobody
    off, and does not name one squad. Auto deals across BOTH squads, so
    "auto the rest onto Black" is not a deal — it is "the rest onto Black"."""
    return (_auto_evidence_ok(said, req.roster)
            and not _has_removal_words(said)
            and _squad_in_quote(said, req.squad_names) is None)


def _worksheet_squad(heard: str, phrases, req) -> Optional[str]:
    """The squad of the worksheet phrase a heard name was spoken in, or None
    when no phrase of the transcript contains it, or the phrase is not about
    placing anyone — a sit-out, which the caller must not turn into a
    placement."""
    phrase = _worksheet_phrase(heard, phrases, req.transcript)
    if phrase is None or _REMOVAL_RE.search(_light_normalize(phrase.get("words", ""))):
        return None
    key = _squad_key(phrase.get("squad"), req.squad_names)
    return key if key is not None else SQUAD_KEYS[0]


# =============================================================================
# Derivation
# =============================================================================

class SquadDerivation:
    """Everything _derive_squads works out, named so callers do not unpack
    a tuple that keeps growing."""

    def __init__(self):
        self.squads: Dict[str, List[str]] = {k: [] for k in SQUAD_KEYS}
        self.assign: List[tuple] = []      # (roster name, squad key)
        self.outs: List[str] = []          # roster names
        self.cleared: bool = False
        self.rest: Optional[str] = None    # squad key
        self.groups: List[tuple] = []      # (group, squad key, "all" | "rest")
        self.fills: List[tuple] = []       # (group, squad key, count)
        self.autos: List[str] = []         # groups handed to Auto ("ANY" = everyone left)
        self.unmatched: List[str] = []
        self.resolved: List[tuple] = []    # (heard, roster name) — closest-name resolutions
        self.dropped: List[str] = []       # what a guard refused, for the log


def _derive_squads(result: Dict[str, Any], req: SquadsRequest) -> SquadDerivation:
    """The complete post-model derivation for /squads, in one place (the
    same reason as _derive_players): shape the reply defensively, resolve
    names against the closed roster, verify the evidence for a clear, the
    sit-outs, an "everyone else" and the group phrases, apply the
    default-squad rule, then the tap-equivalent set arithmetic."""
    d = SquadDerivation()
    roster = req.roster
    unresolved: List[str] = []

    d.cleared = bool(result.get("clear"))
    if d.cleared and not _clear_evidence_ok(str(result.get("clear_said") or ""), req.transcript):
        d.cleared = False
        d.dropped.append("<clear>")

    for entry in result.get("assign", []):
        if not isinstance(entry, dict) or not entry.get("name"):
            continue
        heard = str(entry["name"])
        name, by_closest = _resolve_roster_name(heard, roster)
        if name is None:
            unresolved.append(heard)
            continue
        if by_closest:
            d.resolved.append((heard, name))
        key = _squad_key(entry.get("squad"), req.squad_names)
        if key is None:
            # Named a squad that is not one of the two: the player was still
            # placed on purpose, so the first squad is the honest fallback.
            d.dropped.append(f"{name}:squad={entry.get('squad')!r}")
            key = SQUAD_KEYS[0]
        d.assign.append((name, key))

    # A name the model gave up on ("unmatched") although exactly one roster
    # player is close to it: the roster is closed, so that is who it is. The
    # squad comes from the model's own worksheet — the phrase the word was
    # spoken in — and only a phrase that really is in the transcript counts.
    # Never overrides something the model did place.
    placed = {n for n, _ in d.assign}
    out_names_raw = {str(e.get("name")) for e in result.get("out", []) if isinstance(e, dict)}
    for u in result.get("unmatched", []):
        if not isinstance(u, (str, int)):
            continue
        heard = str(u)
        name, _ = _resolve_roster_name(heard, roster)
        if name is None or name in placed or name in out_names_raw:
            continue
        key = _worksheet_squad(heard, result.get("phrases", []), req)
        if key is None:
            continue
        d.assign.append((name, key))
        d.resolved.append((heard, name))
        placed.add(name)

    for e in result.get("out", []):
        if not isinstance(e, dict) or not e.get("name"):
            continue
        heard = str(e["name"])
        said = str(e.get("said") or "").strip()
        name, by_closest = _resolve_roster_name(heard, roster)
        if (name is not None and said and _evidence_in_transcript(said, req.transcript)
                and _quote_names_player(said, name, roster)):
            d.outs.append(name)
            if by_closest:
                d.resolved.append((heard, name))
        else:
            d.dropped.append(name or heard)

    rest_raw = str(result.get("rest") or "").strip()
    rest_said = str(result.get("rest_said") or "").strip()
    if rest_said and _evidence_in_transcript(rest_said, req.transcript) and _hands_to_auto(rest_said, req):
        # "Dana on Black, auto the rest" filed under ``rest`` with the squad
        # carried over from Dana: the coach named no squad for the rest, so
        # it is a deal, never "everyone else on Black".
        auto_group = _group_in_quote(rest_said) or ANY_GROUP
        if auto_group not in d.autos:
            d.autos.append(auto_group)
    elif rest_raw:
        rest_key = _squad_key(rest_raw, req.squad_names)
        if rest_key is None or not _rest_evidence_ok(rest_said, req.transcript):
            d.dropped.append("<rest>")
        else:
            d.rest = rest_key

    for g in result.get("groups", []):
        if not isinstance(g, dict):
            continue
        key = _squad_key(g.get("squad"), req.squad_names)
        said = str(g.get("said") or "").strip()
        verified, why = _verified_group(g, req.transcript)
        if verified is None:
            d.dropped.append(why or "<group>")
            continue
        group, count = verified
        if count is None and _hands_to_auto(said, req):
            # The Auto button by voice. Whatever squad the model wrote
            # beside it was carried from another phrase: the quote names none.
            if group not in d.autos:
                d.autos.append(group)
            continue
        if _auto_evidence_ok(said, roster):
            # "auto the rest onto Black": the squad is in the quote, and the
            # model, told that Auto takes no squad, may have left it blank.
            key = _squad_in_quote(said, req.squad_names) or key
        if key is None:
            d.dropped.append("<group>")
            continue
        if count is not None:
            # "auto-pick two more guys for Black" is a count like any other.
            d.fills.append((group, key, count))
        elif group == ANY_GROUP:
            if d.rest is None and _auto_evidence_ok(said, roster) and _rest_evidence_ok(said, req.transcript):
                # "auto the rest onto Black", filed here instead of ``rest``.
                d.rest = key
            else:
                # "Everyone on Dark" with no gender and no number is not a
                # group move; an ungendered "everyone else" is ``rest``.
                d.dropped.append("<group:any>")
        else:
            scope = "rest" if _REST_LEXICON_RE.search(_light_normalize(said)) else "all"
            d.groups.append((group, key, scope))

    base = {k: [] for k in SQUAD_KEYS} if d.cleared else _current_squads(req)
    d.squads = _apply_squad_changes(
        base, d.assign, d.outs, d.rest, roster, groups=d.groups, cleared=d.cleared)

    # What could not be placed: the model's own unmatched references — minus
    # any that turn out to be a player it did place (a small model lists
    # "Dayna" as unmatched AND places Dana) — plus names it placed that
    # resolve to nobody.
    named = {n for n, _ in d.assign} | set(d.outs)
    seen = set()
    for u in list(result.get("unmatched", [])) + unresolved:
        if not isinstance(u, (str, int)):
            continue
        u = str(u)
        resolved, _ = _resolve_roster_name(u, roster)
        if resolved is not None and resolved in named:
            continue
        # "Otto" / "auto" listed as a name nobody matched, when the phrase
        # it came from was honored as the hand-off to Auto.
        if d.autos and _is_auto_word(u):
            continue
        if u.casefold() in seen:
            continue
        seen.add(u.casefold())
        d.unmatched.append(u)
    return d


def _roster_facts(roster) -> List[tuple]:
    """(name, gender group | None, here, pinned) per roster entry. A plain
    list of names is accepted too (everyone here, nobody pinned)."""
    facts = []
    for p in roster:
        if isinstance(p, str):
            facts.append((p, None, True, False))
            continue
        facts.append((
            p.name,
            _gender_of(p),
            bool(getattr(p, "here", True)),
            bool(getattr(p, "pinned", False)),
        ))
    return facts


def _apply_squad_changes(
    current: Dict[str, List[str]],
    assign: List[tuple],
    outs: List[str],
    rest: Optional[str],
    roster,
    groups=(),
    cleared: bool = False,
) -> Dict[str, List[str]]:
    """squads = current, with the collective phrases expanded first and the
    named placements applied over them.

    Collective phrases place players the coach did NOT name, and only ones
    who are here today: a gender group ("the FMPs on Orange": everyone in
    the group; "the rest of the FMPs": everyone in it the coach has not
    already placed — roster ``pinned``), then an ungendered "everyone else"
    over whoever no group claimed, again leaving pinned players alone. A
    clear un-pins everyone: nothing placed before it survives it.

    Then every out comes off both squads and every named player moves to
    the squad voiced for them. A later statement about a player wins (a
    duplicate name is kept to the last placement), and an out beats a
    placement for the same name. Name matching is the same exact → casefold
    → unique-normalized ladder as _apply_changes.
    """
    def _matches(a: str, b: str) -> bool:
        if a == b or a.casefold() == b.casefold():
            return True
        na, nb = _normalize_name(a), _normalize_name(b)
        return bool(na) and na == nb

    # Last placement per name wins; an out cancels a placement.
    final: List[tuple] = []
    for name, key in assign:
        final = [(n, k) for n, k in final if not _matches(n, name)]
        final.append((name, key))
    final = [(n, k) for n, k in final if not any(_matches(n, o) for o in outs)]

    def _remove(lst: List[str], name: str) -> List[str]:
        hit = next((x for x in lst if x == name), None)
        if hit is None:
            hit = next((x for x in lst if x.casefold() == name.casefold()), None)
        if hit is None:
            norm = _normalize_name(name)
            hits = [x for x in lst if norm and _normalize_name(x) == norm]
            hit = hits[0] if len(hits) == 1 else None
        return [x for x in lst if x != hit] if hit is not None else lst

    squads = {k: list(current.get(k) or []) for k in SQUAD_KEYS}
    named = [n for n, _ in final] + list(outs)
    facts = _roster_facts(roster)

    def _move(names: List[str], key: str) -> None:
        for k in SQUAD_KEYS:
            for n in names:
                squads[k] = _remove(squads[k], n)
        for n in names:
            if not any(_matches(n, x) for x in squads[key]):
                squads[key].append(n)

    claimed: List[str] = []

    def _unnamed(include_pinned: bool, group: Optional[str] = None) -> List[str]:
        return [
            name for name, gender, here, pinned in facts
            if here
            and (group is None or gender == group)
            and (include_pinned or cleared or not pinned)
            and not any(_matches(name, m) for m in named)
            and name not in claimed
        ]

    for group, key, scope in groups:
        members = _unnamed(include_pinned=(scope == "all"), group=group)
        _move(members, key)
        claimed.extend(members)

    if rest:
        _move(_unnamed(include_pinned=False), rest)

    for name in outs:
        for k in SQUAD_KEYS:
            squads[k] = _remove(squads[k], name)
    for name, key in final:
        for k in SQUAD_KEYS:
            squads[k] = _remove(squads[k], name)
        squads[key].append(name)
    return squads


# =============================================================================
# Prompt
# =============================================================================

def _build_squads_prompt(req: SquadsRequest) -> str:
    first = req.squad_names["X"].strip()
    second = req.squad_names["Y"].strip()
    worksheet = prompt_worksheet(
        f'"Alice and Dana on {first}" / "the rest of the FMPs on {second}"',
        'the squad THAT phrase puts people on ("" when it names none and none carries to it)',
    )

    def squad_block(key: str) -> str:
        names = req.current_squads.get(key) or []
        return "\n".join(f"- {n}" for n in names) if names else "(empty)"

    return f"""You are the voice-input layer for a scrimmage set-up screen in an ultimate frisbee app. The team is split into two squads, "{first}" and "{second}". The coach speaks; you report WHICH PLAYERS GO ON WHICH SQUAD and WHO SITS OUT — the verbal equivalent of tapping a player's "{first}" or "{second}" button on the list. You never fill, balance, complete or output a squad yourself: you report what the coach said and the app applies it, including choosing the players when the coach asks for a number of them or hands the placing to the app by saying "auto" ("auto the rest").

{prompt_roster(req.roster)}

Currently on "{first}" (context only — the app applies what you report to this):
{squad_block("X")}

Currently on "{second}" (context only):
{squad_block("Y")}

{prompt_transcript(req.transcript)}

Reply with ONLY a JSON object of this exact shape (no prose, no markdown fences):
{{"phrases": [{{"words": "a phrase of the transcript", "squad": "{first}" | "{second}" | ""}}, ...], "clear": false, "clear_said": "", "assign": [{{"name": "Name", "squad": "{first}" | "{second}" | ""}}, ...], "groups": [{{"group": "FMP" | "MMP" | "ANY", "squad": "{first}" | "{second}" | "", "count": null, "said": "the coach's exact words"}}, ...], "rest": "", "rest_said": "", "out": [{{"name": "Name", "said": "the coach's exact words"}}, ...], "unmatched": ["spoken reference", ...], "note": ""}}

{worksheet}

How to interpret the transcript:
1. Every player the coach names goes in "assign", with "squad" set to the squad the coach put them on, spelled exactly "{first}" or "{second}". "Alice and Bob on {first}, Dana {second}" → Alice and Bob with "{first}", Dana with "{second}". Squads may be referred to by name, by colour, or by a word of the name; map them to the two names above.
2. A name spoken with NO squad gets "squad": "" — leave it blank, never guess. The app puts blank placements on "{first}", so a coach who simply reads out a list ("Alice, Bob, Charlie, Dana") is filling "{first}". A squad named once carries to the names that follow it until another squad is named: "{second} is Eve, Hank and Iris" gives all three "{second}"; "{first}: Alice, Bob. {second}: Dana, Eve" splits them.
{rule_closed_roster(3, '"name"', " (keeping its squad)")}
4. "X sits out", "X is out", "X isn't here", "X is injured", "X off", "take X off" — X goes in "out" (rule 3 applies to the name), quoting the coach's exact words in "said". A player never appears in both "assign" and "out": the coach's LAST statement about a player wins ("Alice on {first}… actually Alice is sitting out" → out only). RETRACTED words are void as evidence.
5. GROUPS — the coach places players by gender group or by number instead of by name. Report each such phrase as one "groups" entry, quoting the coach's exact words in "said"; NEVER expand it into names in "assign" — the app knows who is in each group, who is here and who is already placed.
{rule_gender_words()}
   - The whole group, "count": null: "the FMPs on {first}", "all the women on {second}", "girls are {first}" → {{"group": "FMP", "squad": "…", "count": null, "said": "…"}}.
   - The rest of a group, "count": null: "the rest of the FMPs on {second}", "the other guys on {first}", "the remaining women go {second}" → the same shape. Keep the word "rest" / "other" / "remaining" inside "said": the app reads from your quote that the coach meant only the ones not yet placed.
   - A number of them: "two more FMPs on {first}", "another guy on {second}", "add a couple of women to {first}", "three more on {second}" → "count" is the number (2, 1, 2, 3) and "said" contains the number word; "group" is "ANY" when no gender word was said. The app chooses which players.
   - A group phrase with no squad gets "squad": "", like a name (rule 2), and a squad named earlier carries to it.
   - AUTO — the coach hands the placing to the app's Auto button, and says the word "auto" to do it: "auto the rest", "and auto-pick the rest", "auto-select everybody else", "auto the squads", "autofill" → {{"group": "ANY", "squad": "", "count": null, "said": "…"}}. For ONE gender group only — "auto-pick the FMPs", "auto the guys", "auto the rest of the women" → the same entry with "group": "FMP" | "MMP". The word "auto" must be inside "said". "squad" is ALWAYS "" here, even right after a squad was named: Auto deals players across BOTH squads, so no squad carries to it, and it is NOT rule 6 — leave "rest" empty. The app deals everyone who is here and on neither squad (of that group, when one is named), balanced, the way its Auto button does; you never place anyone for it. Auto only PLACES PLAYERS WHO ARE ON NEITHER SQUAD — it takes nobody off, so it never stands in for a clear: "Start over. Auto everybody." is BOTH a clear (rule 7: "clear": true, "clear_said": "Start over") AND this entry. Players the coach names in the same breath still go in "assign" / "out" as usual. The recognizer sometimes writes "auto" as "Otto": when nobody on the roster is called Otto, "Otto the rest" is this phrase — quote it as written, and Otto is not a name for "assign" or "unmatched".
6. "everyone else on {second}", "the rest on {first}", "the others are {second}" — with NO gender word, and a squad to go to — set "rest" to that squad name and quote the words in "rest_said". The app then sends every player you did not name, and no group covered, to that squad. Do not list those players yourself.
7. CLEAR-EVERYONE: "clear the squads", "start fresh", "start over", "everybody off", "wholesale" — set "clear": true and quote the words in "clear_said". A clear empties both squads before anything else you report applies.
8. Later statements override earlier ones ("Dana on {first} — no, {second}" → Dana with "{second}"; "is that Hank? no, Morgan" → Morgan, Hank nowhere). Ignore asides: chatter, the weather, who is late, the score of the last point. Wrap-ups ("that's everyone", "that's the split") add nobody.
9. THE CARDINAL RULE: "assign" and "out" contain ONLY players the coach referred to by name, nickname or number. Never anyone else, however uneven the squads would be: if the coach named 3 players, "assign" has exactly 3 entries. Reciting names taps those players onto a squad; it moves nobody else. Say anything notable (a retraction, an ambiguous reference) in one short sentence in "note".
"""


# =============================================================================
# Model call and reply parsing
# =============================================================================

async def _call_claude_squads(api_key: str, prompt: str) -> Dict[str, Any]:
    """The model call for /squads (its own name so tests can mock it)."""
    return _parse_squads_reply(await common._call_claude_json(api_key, prompt, "assign"))


def _parse_squads_json(text: str) -> Dict[str, Any]:
    """Parse a raw reply. "assign" is the anchor key; a reply without it is
    a contract violation and errors out, so the client applies nothing."""
    return _parse_squads_reply(common._last_json_object(text, "assign"))


def _parse_squads_reply(parsed: Dict[str, Any]) -> Dict[str, Any]:
    if not isinstance(parsed.get("assign"), list):
        raise RuntimeError("Claude squads response missing 'assign' list")
    if "out" in parsed and not isinstance(parsed.get("out"), list):
        raise RuntimeError("Claude squads response 'out' is not a list")
    parsed["clear"] = bool(parsed.get("clear"))
    parsed["clear_said"] = str(parsed.get("clear_said") or "")
    parsed["rest"] = str(parsed.get("rest") or "")
    parsed["rest_said"] = str(parsed.get("rest_said") or "")
    assign = []
    for entry in parsed.get("assign", []):
        if isinstance(entry, dict) and entry.get("name"):
            assign.append({"name": str(entry["name"]), "squad": str(entry.get("squad") or "")})
        elif isinstance(entry, (str, int)) and not isinstance(entry, bool):
            # A bare name: the model skipped the squad field — unstated.
            assign.append({"name": str(entry), "squad": ""})
    parsed["assign"] = assign
    parsed["out"] = _shape_out_entries(parsed.get("out"))
    parsed["groups"] = _shape_groups(parsed.get("groups"), "squad")
    parsed["phrases"] = _shape_phrases(parsed.get("phrases"), "squad")
    return parsed
