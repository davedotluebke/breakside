"""
Transcription-model comparison on the narration harness: which Realtime
transcription model gets player names right, on our audio?

Two legs, both through the production-equivalent transcription session
(runner.TranscriptionConfig: semantic VAD, noise reduction, English, roster
vocabulary hint):

  events   — every audio scenario under scenarios/: WER, roster-name recall
             (runner.name_recall), and with --slow-pass the event
             precision/recall/F1 through the real /finalize prompt on the
             production slow-pass model.
  lineups  — the audio-driven lineup matrix under lineup_scenarios/ (see
             tools/generate_lineup_audio.py; clean and -noisy variants):
             WER, name recall, and the end-to-end lineup outcome — real
             lineup prompt → Claude → _derive_players → the real client
             matcher under node — graded exactly as test_narration_lineup.

Every candidate model is probed once first; models the Realtime API rejects
are reported and skipped. Runs are repeated (--runs) because the recognizer
is not deterministic.

Usage:
  python -m breakside_server.tests.narration.stt_eval --runs 3 --slow-pass --json out.json
  python -m breakside_server.tests.narration.stt_eval --models gpt-4o-mini-transcribe,gpt-transcribe --lineups-only

Environment: OPENAI_API_KEY; ANTHROPIC_API_KEY for --slow-pass and the lineup
leg. NARRATION_LINEUP_MODEL / NARRATION_SLOW_MODEL choose the Claude model
exactly as production does.
"""
from __future__ import annotations

import argparse
import asyncio
import dataclasses
import json
import os
import shutil
import subprocess
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from .runner import (
    Scenario, TranscriptionConfig, call_finalize, list_scenarios, name_recall,
    score_events, stream_audio_for_transcription, word_error_rate, _decode_audio_to_pcm16,
)

HERE = Path(__file__).resolve().parent
EVENT_SCENARIOS_DIR = HERE / "scenarios"
LINEUP_SCENARIOS_DIR = HERE / "lineup_scenarios"
REPO_ROOT = HERE.parents[2]
LINEUP_RESOLVE_JS = REPO_ROOT / "narration" / "lineupResolve.js"

DEFAULT_MODELS = [
    "gpt-4o-mini-transcribe",
    "gpt-4o-transcribe",
    "gpt-transcribe",
    "gpt-live-transcribe",
    "gpt-realtime-whisper",
    "whisper-1",
]

# $/audio-minute, developers.openai.com/api/docs/pricing (2026-09-30).
PRICE_PER_MIN = {
    "gpt-4o-mini-transcribe": 0.003,
    "gpt-4o-mini-transcribe-2025-12-15": 0.003,
    "gpt-4o-transcribe": 0.006,
    "gpt-transcribe": 0.0045,
    "gpt-live-transcribe": 0.017,
    "whisper-1": 0.006,
}

# Session knobs a model refuses (probed 2026-10-01). Production would need
# the same change to run the model, so a win here is not free.
MODEL_OVERRIDES: Dict[str, Dict[str, Any]] = {
    # "Turn detection is not supported for this transcription model."
    "gpt-live-transcribe": {"turn_detection": None},
    # Rejects turn detection too, and "The 'prompt' parameter is not
    # supported for this model." — no vocabulary hint, the lever we care about.
    "gpt-realtime-whisper": {"turn_detection": None, "vocabulary_hint": False},
}


# =============================================================================
# Lineup scenarios
# =============================================================================

@dataclass
class LineupScenario:
    name: str
    audio_path: Path
    sample_rate: int
    transcript: str
    roster: List[Dict[str, Any]]
    previous_lineup: List[str]
    current_selection: List[str]
    expected_count: int
    expect: Optional[List[str]]
    grade: Optional[str]
    must_in: List[str]
    must_out: List[str]
    allowed: List[str]

    @property
    def noisy(self) -> bool:
        return self.name.endswith("-noisy")

    def passes(self, matched: set) -> bool:
        if self.grade == "s1":
            return (set(self.must_in) <= matched
                    and not (matched & set(self.must_out))
                    and matched <= set(self.allowed))
        return matched == set(self.expect or [])


def load_lineup_scenarios(root: Path) -> List[LineupScenario]:
    out = []
    for d in list_scenarios(root):
        audio = d / "audio.flac"
        if not audio.exists():
            continue
        _, sr = _decode_audio_to_pcm16(audio)
        r = json.loads((d / "roster.json").read_text())
        e = json.loads((d / "expected.json").read_text())
        out.append(LineupScenario(
            name=d.name, audio_path=audio, sample_rate=sr,
            transcript=(d / "transcript.txt").read_text().strip(),
            roster=r["roster"], previous_lineup=r["previous_lineup"],
            current_selection=r["current_selection"], expected_count=r.get("expected_count", 7),
            expect=e.get("expect"), grade=e.get("grade"),
            must_in=e.get("must_in", []), must_out=e.get("must_out", []), allowed=e.get("allowed", []),
        ))
    return out


def frontend_match(returned: List[str], roster: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Run returned names through the REAL client matcher under node
    (same leg as test_narration_lineup._frontend_match)."""
    if not shutil.which("node"):
        raise RuntimeError("node not available for the client-matcher leg")
    script = (
        f"import {{ resolveLineupPlayers }} from '{LINEUP_RESOLVE_JS}';\n"
        f"const out = resolveLineupPlayers({json.dumps(returned)}, {json.dumps(roster)});\n"
        "console.log(JSON.stringify({m: out.players.map(p => p.name), u: out.unmatched}));"
    )
    r = subprocess.run(["node", "--input-type=module", "-e", script], capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(r.stderr[:300])
    return json.loads(r.stdout)


async def resolve_lineup(sc: LineupScenario, transcript: str) -> Dict[str, Any]:
    """The production lineup path from a transcript: prompt → Claude →
    _derive_players → client matcher → pass/fail against the fixture."""
    from breakside_server.narration_lineup import (
        LineupRequest, LineupRosterPlayer, _build_lineup_prompt, _call_claude_lineup, _derive_players,
    )
    req = LineupRequest(
        game_id="stt-eval", transcript=transcript or "(nothing transcribed)",
        roster=[LineupRosterPlayer(**p) for p in sc.roster],
        expected_count=sc.expected_count,
        previous_lineup=sc.previous_lineup, current_selection=sc.current_selection,
    )
    prompt = _build_lineup_prompt(req)
    last_err: Optional[Exception] = None
    for _ in range(2):
        try:
            res = await _call_claude_lineup(os.environ["ANTHROPIC_API_KEY"], prompt)
            break
        except Exception as e:  # noqa: BLE001 — transient API errors get one retry
            last_err = e
    else:
        raise RuntimeError(f"lineup model call failed twice: {last_err}")
    players, ins, outs, cleared, dropped = _derive_players(res, req)
    fe = await asyncio.to_thread(frontend_match, players, sc.roster)
    matched = set(fe["m"])
    return {
        "matched": sorted(matched), "unmatched": fe["u"], "ins": ins, "outs": outs,
        "cleared": cleared, "passed": sc.passes(matched) and not fe["u"],
    }


# =============================================================================
# Runs
# =============================================================================

async def transcribe(model: str, audio_path: Path, sample_rate: int, roster, pace: float) -> str:
    return await stream_audio_for_transcription(
        audio_path, sample_rate=sample_rate, roster=roster,
        config=TranscriptionConfig(model=model, pace=pace, **MODEL_OVERRIDES.get(model, {})),
    )


async def _with_retry(coro_factory, retries: int = 1):
    last: Optional[Exception] = None
    for attempt in range(retries + 1):
        try:
            return await coro_factory()
        except RuntimeError as e:
            # A rejected configuration is deterministic — don't retry it.
            if "Realtime error" in str(e):
                raise
            last = e
        except Exception as e:  # noqa: BLE001
            last = e
        if attempt < retries:
            await asyncio.sleep(2.0)
    raise last  # type: ignore[misc]


async def probe_model(model: str, pace: float) -> Optional[str]:
    """Shortest event scenario through the session; returns the rejection
    message if the Realtime API won't run this model, else None."""
    s = Scenario.load(EVENT_SCENARIOS_DIR / "001_single_throw")
    try:
        await transcribe(model, s.audio_path, s.sample_rate, s.roster, pace)
        return None
    except RuntimeError as e:
        if "Realtime error" in str(e):
            return str(e)
        return f"transport: {e}"


async def run_event(model: str, scenario_dir: Path, run_idx: int, slow_pass: bool, pace: float) -> Dict[str, Any]:
    s = Scenario.load(scenario_dir)
    row: Dict[str, Any] = {"leg": "events", "model": model, "scenario": s.name, "run": run_idx}
    try:
        transcript = await _with_retry(lambda: transcribe(model, s.audio_path, s.sample_rate, s.roster, pace))
    except Exception as e:  # noqa: BLE001
        row["error"] = str(e)[:300]
        return row
    ns = name_recall(s.expected_transcript, transcript, s.roster)
    row.update({
        "transcript": transcript,
        "wer": word_error_rate(s.expected_transcript, transcript) if s.expected_transcript else None,
        "names_expected": ns.expected, "names_found": ns.found, "names_missing": ns.missing,
    })
    if slow_pass:
        try:
            resp = await asyncio.to_thread(call_finalize, transcript, s.roster, s.game_context, f"stt-{s.name}")
            sc = score_events(s.expected_events, resp.get("operations", []))
            row.update({"ev_matched": sc.matched, "ev_expected": sc.expected, "ev_actual": sc.actual,
                        "ev_missing": sc.missing, "ev_extra": sc.extra})
        except Exception as e:  # noqa: BLE001
            row["slow_pass_error"] = str(e)[:300]
    return row


async def run_lineup(model: str, sc: LineupScenario, run_idx: int, pace: float) -> Dict[str, Any]:
    row: Dict[str, Any] = {"leg": "lineups", "model": model, "scenario": sc.name, "noisy": sc.noisy, "run": run_idx}
    try:
        transcript = await _with_retry(lambda: transcribe(model, sc.audio_path, sc.sample_rate, sc.roster, pace))
    except Exception as e:  # noqa: BLE001
        row["error"] = str(e)[:300]
        return row
    ns = name_recall(sc.transcript, transcript, sc.roster)
    row.update({
        "transcript": transcript,
        "wer": word_error_rate(sc.transcript, transcript),
        "names_expected": ns.expected, "names_found": ns.found, "names_missing": ns.missing,
    })
    try:
        row["lineup"] = await resolve_lineup(sc, transcript)
    except Exception as e:  # noqa: BLE001
        row["lineup_error"] = str(e)[:300]
    return row


# =============================================================================
# Aggregation
# =============================================================================

def _mean(xs: List[float]) -> Optional[float]:
    xs = [x for x in xs if x is not None]
    return sum(xs) / len(xs) if xs else None


def aggregate(rows: List[Dict[str, Any]], models: List[str]) -> Dict[str, Dict[str, Any]]:
    out: Dict[str, Dict[str, Any]] = {}
    for m in models:
        ev = [r for r in rows if r["leg"] == "events" and r["model"] == m]
        ev_ok = [r for r in ev if "error" not in r]
        agg: Dict[str, Any] = {"events": None, "lineups": None}
        if ev:
            n_exp = sum(r["names_expected"] for r in ev_ok)
            n_found = sum(r["names_found"] for r in ev_ok)
            e: Dict[str, Any] = {
                "runs": len(ev), "errors": len(ev) - len(ev_ok),
                "wer_mean": _mean([r["wer"] for r in ev_ok]),
                "name_recall": (n_found / n_exp) if n_exp else None,
                "names_expected": n_exp,
            }
            scored = [r for r in ev_ok if "ev_matched" in r]
            if scored:
                mt = sum(r["ev_matched"] for r in scored)
                ex = sum(r["ev_expected"] for r in scored)
                ac = sum(r["ev_actual"] for r in scored)
                p = mt / ac if ac else 1.0
                rc = mt / ex if ex else 1.0
                e.update({"ev_precision": p, "ev_recall": rc,
                          "ev_f1": 2 * p * rc / (p + rc) if (p + rc) else 0.0})
            agg["events"] = e
        lu = [r for r in rows if r["leg"] == "lineups" and r["model"] == m]
        if lu:
            l: Dict[str, Any] = {}
            for label, subset in (("clean", [r for r in lu if not r["noisy"]]), ("noisy", [r for r in lu if r["noisy"]])):
                ok = [r for r in subset if "error" not in r]
                graded = [r for r in ok if "lineup" in r]
                n_exp = sum(r["names_expected"] for r in ok)
                n_found = sum(r["names_found"] for r in ok)
                l[label] = {
                    "runs": len(subset), "errors": len(subset) - len(ok),
                    "wer_mean": _mean([r["wer"] for r in ok]),
                    "name_recall": (n_found / n_exp) if n_exp else None,
                    "exact_rate": (sum(1 for r in graded if r["lineup"]["passed"]) / len(graded)) if graded else None,
                    "leaks": sum(len(r["lineup"]["unmatched"]) for r in graded),
                }
            agg["lineups"] = l
        agg["price_per_min"] = PRICE_PER_MIN.get(m)
        out[m] = agg
    return out


def _fmt(x: Optional[float], pct: bool = False) -> str:
    if x is None:
        return "   -  "
    return f"{100 * x:5.1f}%" if pct else f"{x:6.3f}"


def print_report(agg: Dict[str, Dict[str, Any]], rejected: Dict[str, str], rows: List[Dict[str, Any]], verbose: bool) -> None:
    print("\n==== STT MODEL COMPARISON ====")
    for m, why in rejected.items():
        print(f"REJECTED {m}: {why[:160]}")
    header = f"{'model':36s} {'$/min':>7s} | {'WER':>6s} {'names':>6s} {'ev-F1':>6s} | {'lineup clean':>12s} {'names':>6s} | {'lineup noisy':>12s} {'names':>6s} {'WER':>6s}"
    print(header)
    print("-" * len(header))
    for m, a in agg.items():
        e = a.get("events") or {}
        l = a.get("lineups") or {}
        c, n = l.get("clean", {}), l.get("noisy", {})
        price = f"{a['price_per_min']:.4f}" if a.get("price_per_min") else "   ?"
        print(
            f"{m:36s} {price:>7s} | {_fmt(e.get('wer_mean'))} {_fmt(e.get('name_recall'), True)} {_fmt(e.get('ev_f1'))} | "
            f"{_fmt(c.get('exact_rate'), True):>12s} {_fmt(c.get('name_recall'), True)} | "
            f"{_fmt(n.get('exact_rate'), True):>12s} {_fmt(n.get('name_recall'), True)} {_fmt(n.get('wer_mean'))}"
        )
        errs = (e.get("errors", 0) or 0) + (c.get("errors", 0) or 0) + (n.get("errors", 0) or 0)
        if errs:
            print(f"    ! {errs} run(s) errored")
    if verbose:
        print("\nPer-scenario name misses (events leg):")
        by: Dict[str, Dict[str, List[str]]] = {}
        for r in rows:
            if r["leg"] == "events" and r.get("names_missing"):
                by.setdefault(r["scenario"], {}).setdefault(r["model"], []).extend(r["names_missing"])
        for scn in sorted(by):
            print(f"  {scn}: " + "; ".join(f"{m}: {', '.join(v)}" for m, v in sorted(by[scn].items())))
        print("\nLineup failures (scenario → model: transcript):")
        for r in rows:
            if r["leg"] == "lineups" and r.get("lineup") and not r["lineup"]["passed"]:
                print(f"  {r['scenario']} run{r['run']} → {r['model']}: {r.get('transcript')!r} → {r['lineup']['matched']} (unmatched {r['lineup']['unmatched']})")


# =============================================================================
# Driver
# =============================================================================

async def run_eval(args: argparse.Namespace) -> Dict[str, Any]:
    models = [m.strip() for m in args.models.split(",") if m.strip()]
    sem = asyncio.Semaphore(args.concurrency)

    async def bounded(coro):
        async with sem:
            return await coro

    print(f"probing {len(models)} model(s) …")
    probes = await asyncio.gather(*(bounded(probe_model(m, args.pace)) for m in models))
    rejected = {m: why for m, why in zip(models, probes) if why}
    models = [m for m in models if m not in rejected]
    for m, why in rejected.items():
        print(f"  rejected {m}: {why[:160]}")
    print(f"accepted: {models}")

    tasks = []
    if not args.lineups_only:
        dirs = [d for d in list_scenarios(EVENT_SCENARIOS_DIR)
                if any((d / f).exists() for f in ("audio.flac", "audio.wav", "audio.pcm"))]
        if args.scenarios:
            dirs = [d for d in dirs if d.name in args.scenarios]
        print(f"events leg: {len(dirs)} scenarios x {len(models)} models x {args.runs} runs")
        tasks += [asyncio.create_task(bounded(run_event(m, d, k, args.slow_pass, args.pace)))
                  for m in models for d in dirs for k in range(1, args.runs + 1)]
    if not args.events_only:
        lus = load_lineup_scenarios(LINEUP_SCENARIOS_DIR)
        if args.scenarios:
            lus = [s for s in lus if s.name in args.scenarios]
        print(f"lineup leg: {len(lus)} scenarios x {len(models)} models x {args.runs} runs")
        tasks += [asyncio.create_task(bounded(run_lineup(m, s, k, args.pace)))
                  for m in models for s in lus for k in range(1, args.runs + 1)]

    rows: List[Dict[str, Any]] = []
    done = 0
    for t in asyncio.as_completed(tasks):
        rows.append(await t)
        done += 1
        if done % 25 == 0 or done == len(tasks):
            print(f"  … {done}/{len(tasks)}", flush=True)

    agg = aggregate(rows, models)
    print_report(agg, rejected, rows, args.verbose)
    report = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "config": {"runs": args.runs, "pace": args.pace, "slow_pass": args.slow_pass,
                   "session": dataclasses.asdict(TranscriptionConfig())},
        "rejected": rejected, "aggregate": agg, "rows": rows,
    }
    if args.json:
        Path(args.json).write_text(json.dumps(report, indent=2, default=str))
        print(f"wrote {args.json}")
    return report


def main(argv: List[str]) -> int:
    ap = argparse.ArgumentParser(description="Transcription-model comparison (see module docstring)")
    ap.add_argument("--models", default=",".join(DEFAULT_MODELS))
    ap.add_argument("--runs", type=int, default=1)
    ap.add_argument("--slow-pass", action="store_true", help="score events through /finalize on the events leg")
    ap.add_argument("--events-only", action="store_true")
    ap.add_argument("--lineups-only", action="store_true")
    ap.add_argument("--scenarios", nargs="*", default=None, help="restrict to these scenario names")
    ap.add_argument("--pace", type=float, default=0.5)
    ap.add_argument("--concurrency", type=int, default=4)
    ap.add_argument("--json", default=None)
    ap.add_argument("--verbose", action="store_true")
    args = ap.parse_args(argv[1:])
    asyncio.run(run_eval(args))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
