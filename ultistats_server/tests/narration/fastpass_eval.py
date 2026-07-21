"""
Fast-pass replay eval driver: conversation-mode event extraction vs the
production transcription+slow-pass path, on identical scenario audio.

This is the Phase 1 deliverable of docs/narration-fastpass-pilot-plan.md —
the offline answer to "does gpt-realtime-2.1 stop confabulating events on
our noise profile?". It replays scenario audio through
runner.stream_audio_for_events() (fast pass) and optionally through the
existing transcription + /api/narration/finalize path (slow-pass baseline),
then reports per-scenario and aggregate event precision / recall / F1,
confabulation counts, and the strict-schema answer.

Usage:
  python -m ultistats_server.tests.narration.fastpass_eval                 # all scenarios
  python -m ultistats_server.tests.narration.fastpass_eval 004b_name_correction_outdoor
  python -m ultistats_server.tests.narration.fastpass_eval --baseline --runs 3 023_noise_only_wind

Options:
  --model            Realtime model (default gpt-realtime-2.1; try -mini too)
  --noise-reduction  far_field (default) | near_field | off
  --eagerness        semantic VAD eagerness: low (default) | medium | high | auto
  --no-strict        skip the strict:true schema attempt
  --pace             chunk pacing multiplier (1.0 = real-time default, 0.5 = 2x)
  --runs N           repeat each scenario N times (noise probes want 3)
  --baseline         also run the transcription+slow-pass path per scenario
  --concurrency      parallel sessions (default 4)
  --json PATH        write the full results JSON
  --verbose          print transcripts and raw calls per run

Environment: OPENAI_API_KEY always; ANTHROPIC_API_KEY when --baseline.

Cost: fast pass ≈ $0.03-0.06 per audio-minute; a full-suite run is well
under a dollar. Iterate freely.
"""
from __future__ import annotations

import argparse
import asyncio
import dataclasses
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from .runner import (
    FastPassConfig,
    FastPassScenarioResult,
    Scenario,
    call_finalize,
    list_scenarios,
    run_scenario_fastpass,
    score_event_list,
    score_events,
    stream_audio_for_transcription,
    word_error_rate,
)

SCENARIOS_DIR = Path(__file__).parent / "scenarios"

# Confidence ordering for the precision-by-confidence-cut report.
_CONF_RANK = {"low": 0, "medium": 1, "high": 2}

# Scenario-name prefixes the pilot plan calls out for correction handling.
_CORRECTION_PREFIXES = ("004", "006", "008")


def _has_audio(d: Path) -> bool:
    return any((d / f).exists() for f in ("audio.flac", "audio.wav", "audio.pcm"))


def _resolve_scenarios(names: List[str]) -> List[Path]:
    if not names:
        dirs = list_scenarios(SCENARIOS_DIR)
    else:
        dirs = []
        for n in names:
            p = Path(n)
            if not p.is_dir():
                p = SCENARIOS_DIR / n
            if not p.is_dir():
                raise SystemExit(f"scenario not found: {n}")
            dirs.append(p)
    kept = []
    for d in dirs:
        if _has_audio(d):
            kept.append(d)
        else:
            print(f"skipping {d.name}: no audio file")
    return kept


def _score_at_confidence(result: FastPassScenarioResult, min_conf: str):
    """Re-score a fast-pass run keeping only net events at/above min_conf.
    Events with no confidence field (shouldn't happen — it's required) are kept."""
    floor = _CONF_RANK[min_conf]
    events = [
        ev
        for ev in result.scored_events
        if _CONF_RANK.get(str(ev.get("confidence", "high")), 2) >= floor
    ]
    return score_event_list(result.expected_events, events)


async def _baseline_run(scenario_dir: Path) -> Dict[str, Any]:
    """The production path (transcription session + slow-pass finalize) as an
    async-friendly run: mirrors runner.run_scenario but pushes the blocking
    finalize call to a thread so baselines can run concurrently."""
    s = Scenario.load(scenario_dir)
    transcript = await stream_audio_for_transcription(s.audio_path, sample_rate=s.sample_rate)
    finalize_response = await asyncio.to_thread(
        call_finalize, transcript, s.roster, s.game_context, f"test-{s.name}"
    )
    operations = finalize_response.get("operations", [])
    score = score_events(s.expected_events, operations)
    return {
        "name": s.name,
        "transcript": transcript,
        "wer": word_error_rate(s.expected_transcript, transcript) if s.expected_transcript else None,
        "operations": operations,
        "precision": score.precision,
        "recall": score.recall,
        "f1": score.f1,
        "matched": score.matched,
        "expected": score.expected,
        "actual": score.actual,
        "missing": score.missing,
        "extra": score.extra,
    }


async def _fast_run(
    scenario_dir: Path, config: FastPassConfig, run_idx: int, retries: int = 1
) -> Dict[str, Any]:
    last_err: Optional[Exception] = None
    for attempt in range(retries + 1):
        try:
            r = await run_scenario_fastpass(scenario_dir, config)
            d = r.as_dict()
            d["run"] = run_idx
            d["precision_at_medium"] = _score_at_confidence(r, "medium").precision
            d["precision_at_high"] = _score_at_confidence(r, "high").precision
            return d
        except Exception as e:  # noqa: BLE001 — record and retry once
            last_err = e
            if attempt < retries:
                print(f"  ! {scenario_dir.name} run {run_idx}: {e} — retrying")
                await asyncio.sleep(2.0)
    return {"name": scenario_dir.name, "run": run_idx, "error": str(last_err)}


def _fmt_events(evs: List[Dict[str, Any]]) -> str:
    return json.dumps(evs, separators=(",", ":"))


def _print_fast(d: Dict[str, Any], verbose: bool) -> None:
    if "error" in d:
        print(f"=== {d['name']} (run {d['run']}) ===  ERROR: {d['error']}")
        return
    o = d["outcome"]
    confab = len(d["extra"])
    print(f"=== {d['name']} (run {d['run']}) ===")
    print(
        f"  fast: P={d['precision']:.2f} R={d['recall']:.2f} F1={d['f1']:.2f}"
        f"  events={len(d['scored_events'])} retractions={len(o['retractions'])}"
        f" confab={confab}  strict={o['strict_mode']} responses={o['responses']}"
    )
    if d["wer"] is not None:
        print(f"  WER={d['wer']:.3f}")
    if verbose:
        print(f"  transcript: {o['transcript']!r}")
        for c in o["calls"]:
            ridx = c.get("response_index")
            print(f"    call[r{ridx}]: {c['name']} {json.dumps(c['args'], separators=(',', ':'))}")
        if o.get("acks_sent"):
            print(f"  acks_sent: {o['acks_sent']}")
    if o["retractions"]:
        for r in o["retractions"]:
            print(f"  retraction: {json.dumps(r['args'], separators=(',', ':'))} -> removed {json.dumps(r['retracted_event'], separators=(',', ':'))}")
    if d["missing"]:
        print(f"  missing: {_fmt_events(d['missing'])}")
    if d["extra"]:
        print(f"  extra:   {_fmt_events(d['extra'])}")
    if d.get("dropped_unresolvable"):
        print(f"  dropped (unresolvable players): {_fmt_events(d['dropped_unresolvable'])}")
    if o["unexpected_texts"]:
        print(f"  ! model text output: {o['unexpected_texts']}")
    if o["errors"]:
        print(f"  ! errors: {o['errors']}")


def _print_baseline(d: Dict[str, Any]) -> None:
    print(
        f"  slow: P={d['precision']:.2f} R={d['recall']:.2f} F1={d['f1']:.2f}"
        f"  events={d['actual']}"
    )
    if d["missing"]:
        print(f"    missing: {_fmt_events(d['missing'])}")
    if d["extra"]:
        print(f"    extra:   {_fmt_events(d['extra'])}")


def _micro(rows: List[Dict[str, Any]]) -> Dict[str, float]:
    matched = sum(r["matched"] for r in rows)
    expected = sum(len(r["expected_events"]) if "expected_events" in r else r["expected"] for r in rows)
    actual = sum(len(r["scored_events"]) if "scored_events" in r else r["actual"] for r in rows)
    p = matched / actual if actual else 1.0
    rc = matched / expected if expected else 1.0
    f1 = 2 * p * rc / (p + rc) if (p + rc) else 0.0
    return {"precision": p, "recall": rc, "f1": f1, "matched": matched, "expected": expected, "actual": actual}


async def run_eval(args: argparse.Namespace) -> Dict[str, Any]:
    scenario_dirs = _resolve_scenarios(args.scenarios)
    if not scenario_dirs:
        raise SystemExit("no scenarios with audio to run")

    config = FastPassConfig(
        model=args.model,
        noise_reduction=None if args.noise_reduction == "off" else args.noise_reduction,
        vad_eagerness=args.eagerness,
        try_strict=not args.no_strict,
        pace=args.pace,
        ack_function_calls=args.ack,
    )
    print(f"config: {config}")
    print(f"scenarios: {[d.name for d in scenario_dirs]}  runs={args.runs} baseline={args.baseline}")

    sem = asyncio.Semaphore(args.concurrency)

    async def bounded(coro):
        async with sem:
            return await coro

    fast_tasks = [
        asyncio.create_task(bounded(_fast_run(d, config, run_idx)))
        for d in scenario_dirs
        for run_idx in range(1, args.runs + 1)
    ]
    baseline_tasks = (
        {d.name: asyncio.create_task(bounded(_baseline_run(d))) for d in scenario_dirs}
        if args.baseline
        else {}
    )

    fast_results = [await t for t in fast_tasks]
    baseline_results: Dict[str, Dict[str, Any]] = {}
    for name, t in baseline_tasks.items():
        try:
            baseline_results[name] = await t
        except Exception as e:  # noqa: BLE001
            baseline_results[name] = {"name": name, "error": str(e)}

    # ---- per-scenario printout ------------------------------------------
    for d in fast_results:
        _print_fast(d, args.verbose)
        b = baseline_results.get(d.get("name", ""))
        if b and d.get("run") == 1:
            if "error" in b:
                print(f"  slow: ERROR {b['error']}")
            else:
                _print_baseline(b)

    # ---- aggregates ------------------------------------------------------
    ok = [d for d in fast_results if "error" not in d]
    failed = [d for d in fast_results if "error" in d]
    noise = [d for d in ok if not d["expected_events"]]
    eventful = [d for d in ok if d["expected_events"]]

    print("\n==== AGGREGATE ====")
    agg: Dict[str, Any] = {"config": dataclasses.asdict(config), "runs": args.runs}
    if eventful:
        m = _micro(eventful)
        agg["fast_micro"] = m
        print(
            f"fast pass, event scenarios ({len({d['name'] for d in eventful})} scenarios x {args.runs} run(s)): "
            f"P={m['precision']:.3f} R={m['recall']:.3f} F1={m['f1']:.3f} "
            f"(matched {m['matched']}/{m['expected']} expected, {m['actual']} emitted)"
        )
        confabs = sum(len(d["extra"]) for d in eventful)
        agg["fast_confabulations_eventful"] = confabs
        print(f"  confabulated events (extra, matching nothing): {confabs}")
        pm = [d["precision_at_medium"] for d in eventful]
        ph = [d["precision_at_high"] for d in eventful]
        print(
            f"  precision at confidence>=medium: {sum(pm)/len(pm):.3f}   >=high: {sum(ph)/len(ph):.3f} (macro)"
        )
    if noise:
        total_noise_events = sum(len(d["scored_events"]) for d in noise)
        agg["noise_confabulations"] = total_noise_events
        print(f"noise-only scenarios: {total_noise_events} event(s) emitted across all runs")
        for d in noise:
            evs = d["scored_events"]
            flag = f"  << CONFABULATION: {_fmt_events(evs)}" if evs else ""
            dropped = f" (+{len(d['dropped_unresolvable'])} dropped-unresolvable)" if d["dropped_unresolvable"] else ""
            print(f"  {d['name']} run {d['run']}: {len(evs)} event(s){dropped}{flag}")
    if args.baseline and baseline_results:
        brows = [b for b in baseline_results.values() if "error" not in b and b["expected"]]
        if brows:
            m = _micro(brows)
            agg["baseline_micro"] = m
            print(
                f"slow-pass baseline, event scenarios: P={m['precision']:.3f} R={m['recall']:.3f} F1={m['f1']:.3f}"
            )
        bnoise = [b for b in baseline_results.values() if "error" not in b and not b["expected"]]
        if bnoise:
            n = sum(b["actual"] for b in bnoise)
            agg["baseline_noise_confabulations"] = n
            print(f"slow-pass baseline, noise-only: {n} event(s) emitted")

    corrections = [d for d in ok if d["name"].startswith(_CORRECTION_PREFIXES)]
    if corrections:
        print("correction scenarios:")
        for d in corrections:
            o = d["outcome"]
            print(
                f"  {d['name']} run {d['run']}: P={d['precision']:.2f} R={d['recall']:.2f} "
                f"retractions={len(o['retractions'])} (unmatched {o['unmatched_retractions']})"
            )
    strict_modes = {d["outcome"]["strict_mode"] for d in ok}
    agg["strict_modes"] = sorted(strict_modes)
    print(f"strict-schema answer: {', '.join(sorted(strict_modes)) or 'n/a'}")
    if failed:
        print(f"FAILED runs: {[(d['name'], d['run']) for d in failed]}")

    report = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "config": dataclasses.asdict(config),
        "runs": args.runs,
        "fast": fast_results,
        "baseline": baseline_results,
        "aggregate": agg,
    }
    if args.json:
        Path(args.json).write_text(json.dumps(report, indent=2, default=str))
        print(f"wrote {args.json}")
    return report


def main(argv: List[str]) -> int:
    ap = argparse.ArgumentParser(description="Fast-pass replay eval (see module docstring)")
    ap.add_argument("scenarios", nargs="*", help="scenario names or paths (default: all)")
    ap.add_argument("--model", default="gpt-realtime-2.1")
    ap.add_argument("--noise-reduction", default="far_field", choices=["far_field", "near_field", "off"])
    ap.add_argument("--eagerness", default="low", choices=["low", "medium", "high", "auto"])
    ap.add_argument("--no-strict", action="store_true")
    ap.add_argument("--ack", action="store_true", help="send function_call_output acks after each response")
    ap.add_argument("--pace", type=float, default=1.0)
    ap.add_argument("--runs", type=int, default=1)
    ap.add_argument("--baseline", action="store_true")
    ap.add_argument("--concurrency", type=int, default=4)
    ap.add_argument("--json", default=None)
    ap.add_argument("--verbose", action="store_true")
    args = ap.parse_args(argv[1:])
    asyncio.run(run_eval(args))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
