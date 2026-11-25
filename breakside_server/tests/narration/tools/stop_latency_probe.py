"""
Stop-latency probe: does the browser's stop() capture the whole transcript?

narration/realtimeSession.js stop() sends input_audio_buffer.commit, then
waits for the FIRST conversation.item.input_audio_transcription.completed
event, capped at 4 s, and returns whatever has accumulated. This probe
streams a clip at real-time pace with the production session config, sends
the commit at t0 (the tap on stop), records every server event against t0,
drains until the stream has been quiet for a long time, and then replays
the event log through a model of stop() to compare what production would
have returned with the fully drained transcript. It also reports what an
item-tracking stop() would wait for: the manual commit acknowledged and
every committed item completed or failed.

Clip sets (--which):
  plain     lineup and event scenarios as they are
  race      a finished line call, a pause, a one-word add-on, stop at once;
            plus the same call followed by 1 / 3 / 6 s of silence
  racefine  the add-on case swept through the pauses where the first
            phrase's transcript lands right at the tap
  all       plain + race

Findings, 2026-11-25, gpt-4o-mini-transcribe and gpt-4o-transcribe
(written up in TODO.md, AI Narration):
  - commit to completed: median 0.4 / 0.5 s, max 0.8 / 1.5 s, so the 4 s
    cap never truncated either model;
  - every run that ended in a pause or in crowd noise (23 of 168) waited
    the full 4 s for a completion that was never coming, where the commit's
    acknowledgement arrived in about 0.15 s;
  - the add-on was lost in 7 of 64 (mini) and 10 of 64 (full) runs of the
    racefine sweep, 0 and 1 of 84 on the mixed set;
  - utterances are concatenated with no separator in every multi-utterance
    run (143 of 143: "...Dana in.Kris"); in 2 the earlier one ended without
    punctuation and the name was glued on ("inKris"). Once, in a later
    8-run smoke test, the second utterance's deltas arrived before the
    first one's completion and the first was appended twice.

Usage:
  python -m breakside_server.tests.narration.tools.stop_latency_probe \
      --which all --runs 3 --json out.json

Needs OPENAI_API_KEY; a few cents per run. On a python.org build without
system certificates, set SSL_CERT_FILE to certifi's bundle first:
  export SSL_CERT_FILE=$(python3 -c 'import certifi; print(certifi.where())')
"""
from __future__ import annotations

import argparse
import asyncio
import base64
import json
import os
import statistics
import sys
from pathlib import Path

import numpy as np
import soundfile as sf

from .. import runner

SR = 24000
PROD_CAP_S = 4.0
DRAIN_QUIET_S = 9.0
DRAIN_MAX_S = 40.0


def load_pcm(path: Path) -> np.ndarray:
    data, sr = sf.read(str(path), dtype="int16", always_2d=False)
    if data.ndim > 1:
        data = data[:, 0]
    assert sr == SR, f"{path}: {sr} Hz"
    return data


def composite(parts) -> np.ndarray:
    """parts: list of Path (clip) or float (seconds of silence)."""
    out = []
    for p in parts:
        if isinstance(p, (int, float)):
            out.append(np.zeros(int(SR * p), dtype=np.int16))
        else:
            out.append(load_pcm(p))
    return np.concatenate(out)


async def connect(headers):
    ws_mod = runner.websockets
    try:
        return await ws_mod.connect(runner.REALTIME_TRANSCRIPTION_URL, additional_headers=headers, max_size=2**24)
    except TypeError:
        return await ws_mod.connect(runner.REALTIME_TRANSCRIPTION_URL, extra_headers=headers, max_size=2**24)


async def run_once(name: str, pcm: np.ndarray, roster, model: str, eagerness: str, pace: float):
    api_key = os.environ["OPENAI_API_KEY"]
    transcription = {"model": model, "language": "en", "prompt": runner.build_vocabulary_prompt(roster)}
    input_cfg = {
        "format": {"type": "audio/pcm", "rate": SR},
        "transcription": transcription,
        "turn_detection": {"type": "semantic_vad", "eagerness": eagerness},
        "noise_reduction": {"type": "near_field"},
    }
    loop = asyncio.get_running_loop()
    events = []          # (t_abs, type, item_id, text)
    ready = asyncio.Event()
    err = {}
    t0 = [None]
    last_tx = [loop.time()]

    ws = await connect([("Authorization", f"Bearer {api_key}")])
    try:
        await ws.send(json.dumps({"type": "session.update",
                                  "session": {"type": "transcription", "audio": {"input": input_cfg}}}))

        async def reader():
            async for raw in ws:
                msg = json.loads(raw)
                t = msg.get("type", "")
                now = loop.time()
                if t == "session.updated":
                    ready.set()
                elif t in ("input_audio_buffer.committed", "input_audio_buffer.speech_started",
                           "input_audio_buffer.speech_stopped"):
                    events.append((now, t.split(".")[-1], msg.get("item_id"), ""))
                elif t == "conversation.item.input_audio_transcription.delta":
                    last_tx[0] = now
                    events.append((now, "delta", msg.get("item_id"), msg.get("delta") or ""))
                elif t == "conversation.item.input_audio_transcription.completed":
                    last_tx[0] = now
                    events.append((now, "completed", msg.get("item_id"), msg.get("transcript") or ""))
                elif t == "conversation.item.input_audio_transcription.failed":
                    last_tx[0] = now
                    events.append((now, "failed", msg.get("item_id"), json.dumps(msg.get("error"))[:120]))
                elif t == "error":
                    e = msg.get("error") or {}
                    m = str(e.get("message", ""))
                    if any(s in m for s in runner._BENIGN_ERROR_SNIPPETS):
                        events.append((now, "benign_error", None, m[:80]))
                        continue
                    err["error"] = e
                    ready.set()
                    return

        rt = asyncio.create_task(reader())
        try:
            await asyncio.wait_for(ready.wait(), timeout=15.0)
            if err:
                raise RuntimeError(f"session rejected: {err['error']}")
            raw = pcm.tobytes()
            step = int(SR * 0.1) * 2
            start = loop.time()
            sent = 0
            for i in range(0, len(raw), step):
                chunk = raw[i:i + step]
                await ws.send(json.dumps({"type": "input_audio_buffer.append",
                                          "audio": base64.b64encode(chunk).decode()}))
                sent += len(chunk) / (SR * 2)
                # Pace against the wall clock so jitter does not accumulate.
                delay = start + sent * pace - loop.time()
                if delay > 0:
                    await asyncio.sleep(delay)
            await ws.send(json.dumps({"type": "input_audio_buffer.commit"}))
            t0[0] = loop.time()
            last_tx[0] = max(last_tx[0], t0[0])
            deadline = t0[0] + DRAIN_MAX_S
            while loop.time() < deadline and (loop.time() - last_tx[0]) < DRAIN_QUIET_S and not err:
                await asyncio.sleep(0.2)
        finally:
            rt.cancel()
            try:
                await rt
            except (asyncio.CancelledError, Exception):
                pass
    finally:
        await ws.close()

    if err:
        raise RuntimeError(f"realtime error: {err['error']}")
    return analyse(name, model, events, t0[0])


def merge_completed(acc: str, utt: str) -> str:
    """realtimeSession.js mergeCompletedUtterance."""
    if not utt or acc.endswith(utt):
        return acc
    return acc + utt


def analyse(name, model, events, t0):
    rel = [(t - t0, typ, item, text) for (t, typ, item, text) in events]
    # Fully drained transcript, accumulated the way production accumulates.
    full = ""
    for t, typ, item, text in rel:
        if typ == "delta":
            full += text
        elif typ == "completed":
            full = merge_completed(full, text)

    # Model of stop(): first completed event after t0, capped at 4 s.
    first_completed_after = next((t for t, typ, _, _ in rel if typ == "completed" and t >= 0), None)
    t_prod = min(first_completed_after, PROD_CAP_S) if first_completed_after is not None else PROD_CAP_S
    prod = ""
    for t, typ, item, text in rel:
        if t > t_prod:
            break
        if typ == "delta":
            prod += text
        elif typ == "completed":
            prod = merge_completed(prod, text)

    # What an item-tracking stop() would wait for: the manual commit to be
    # acknowledged (committed or the benign buffer-too-small error) and every
    # committed item to have completed or failed.
    committed = {}   # item -> t committed
    done = {}        # item -> t completed/failed
    ack = None
    for t, typ, item, text in rel:
        if typ == "committed":
            committed[item] = t
            if t >= 0 and ack is None:
                ack = t
        elif typ == "benign_error" and t >= 0 and ack is None:
            ack = t
        elif typ in ("completed", "failed"):
            done[item] = t
    pending_at_stop = [i for i, tc in committed.items() if tc < 0 and done.get(i, 1e9) >= 0]
    all_done = None
    if ack is not None and all(i in done for i in committed):
        all_done = max([ack] + [done[i] for i in committed] + [0.0])
        all_done = max(all_done, 0.0)

    lat = [done[i] - committed[i] for i in committed if i in done]
    return {
        "clip": name, "model": model,
        "full": full, "prod": prod,
        "truncated": prod.strip() != full.strip(),
        "t_prod": round(t_prod, 2),
        "hit_cap": first_completed_after is None or first_completed_after > PROD_CAP_S,
        "first_completed_after_stop": None if first_completed_after is None else round(first_completed_after, 2),
        "manual_commit": ("committed" if any(typ == "committed" and t >= 0 for t, typ, _, _ in rel)
                          else ("benign_error" if any(typ == "benign_error" and t >= 0 for t, typ, _, _ in rel) else "none")),
        "ack_s": None if ack is None else round(ack, 2),
        "items": len(committed),
        "pending_at_stop": len(pending_at_stop),
        "all_done_s": None if all_done is None else round(all_done, 2),
        "commit_to_completed_s": [round(x, 2) for x in lat],
        "timeline": [(round(t, 2), typ, (item or "")[-4:], text[:40]) for t, typ, item, text in rel
                     if typ != "delta"] ,
        "n_deltas": sum(1 for _, typ, _, _ in rel if typ == "delta"),
    }


def build_clips(base: Path, which: str):
    L = base / "lineup_scenarios"
    E = base / "scenarios"

    def roster_of(d: Path):
        r = json.loads((d / "roster.json").read_text())
        return r.get("roster", r if isinstance(r, list) else [])

    clips = []
    if which in ("all", "plain"):
        for n in ["A1-single-bare-add-partial", "A2-two-adds-filler-partial", "A5-recite-over-partial-unions",
                  "C1-voiced-wholesale-then-ins", "C3-all-off-then-two-in", "M1-numbered-recite-from-empty",
                  "S1-messy-corrections", "S4-recite-over-full-sel-unions", "S5-corrected-sub-hammer",
                  "S5-corrected-sub-hammer-noisy", "M1-numbered-recite-from-empty-noisy"]:
            d = L / n
            clips.append((n, load_pcm(d / "audio.flac"), roster_of(d)))
        for n in ["002_multi_throw_possession", "008_yoyo_possession", "015_coach_commentary",
                  "018_long_form_multi_possession", "026_delayed_correction"]:
            d = E / n
            clips.append((n, load_pcm(d / "audio.flac"), roster_of(d)))
    if which == "racefine":
        # Fine sweep around the gap where the first phrase's transcript lands
        # near the tap on stop.
        first = L / "C3-all-off-then-two-in"
        add = L / "A1-single-bare-add-partial"
        for gap in (0.9, 1.0, 1.1, 1.2, 1.3, 1.4, 1.5, 1.7):
            clips.append((f"race C3+{gap}s+Kris", composite([first / "audio.flac", gap, add / "audio.flac"]),
                          roster_of(first)))
    if which in ("all", "race"):
        # A finished sentence, a short pause, a short add-on, then stop at once.
        first = L / "C3-all-off-then-two-in"      # "All players come off. Priya and Dana in."
        add = L / "A1-single-bare-add-partial"    # "Kris"
        add2 = L / "A4-sub-partial-sel"           # "Kris in for Wes"
        for gap in (0.4, 0.8, 1.2, 1.8, 2.5, 3.5):
            clips.append((f"race C3+{gap}s+Kris", composite([first / "audio.flac", gap, add / "audio.flac"]),
                          roster_of(first)))
        for gap in (0.8, 1.5, 2.5):
            clips.append((f"race M1+{gap}s+KrisForWes",
                          composite([L / "M1-numbered-recite-from-empty" / "audio.flac", gap, add2 / "audio.flac"]),
                          roster_of(L / "M1-numbered-recite-from-empty")))
        # Speech, then the coach waits before tapping stop (nothing new to commit).
        for tail in (1.0, 3.0, 6.0):
            clips.append((f"tail C3+{tail}s silence", composite([first / "audio.flac", tail]), roster_of(first)))
    return clips


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default=str(Path(__file__).resolve().parents[1]),
                    help="directory holding scenarios/ and lineup_scenarios/")
    ap.add_argument("--models", default="gpt-4o-mini-transcribe,gpt-4o-transcribe")
    ap.add_argument("--runs", type=int, default=3)
    ap.add_argument("--which", default="all")
    ap.add_argument("--eagerness", default="medium")
    ap.add_argument("--pace", type=float, default=1.0)
    ap.add_argument("--concurrency", type=int, default=10)
    ap.add_argument("--json", default=None)
    a = ap.parse_args()

    clips = build_clips(Path(a.base), a.which)
    sem = asyncio.Semaphore(a.concurrency)
    results = []

    async def job(name, pcm, roster, model, run):
        async with sem:
            for attempt in range(2):
                try:
                    r = await run_once(name, pcm, roster, model, a.eagerness, a.pace)
                    r["run"] = run
                    results.append(r)
                    return
                except Exception as e:  # noqa
                    if attempt == 1:
                        results.append({"clip": name, "model": model, "run": run, "error": str(e)[:200]})

    await asyncio.gather(*[job(n, p, r, m, k) for (n, p, r) in clips
                           for m in a.models.split(",") for k in range(a.runs)])

    if a.json:
        Path(a.json).write_text(json.dumps(results, indent=1))

    for model in a.models.split(","):
        rs = [r for r in results if r["model"] == model and "error" not in r]
        errs = [r for r in results if r["model"] == model and "error" in r]
        print(f"\n=== {model}: {len(rs)} runs, {len(errs)} errors")
        if not rs:
            for e in errs[:3]:
                print("   ", e["error"])
            continue
        trunc = [r for r in rs if r["truncated"]]
        cap = [r for r in rs if r["hit_cap"]]
        lat = [x for r in rs for x in r["commit_to_completed_s"]]
        alld = [r["all_done_s"] for r in rs if r["all_done_s"] is not None]
        tprod = [r["t_prod"] for r in rs]
        q = lambda xs, p: sorted(xs)[min(len(xs) - 1, int(p * len(xs)))] if xs else None
        print(f"  production stop() lost text in {len(trunc)}/{len(rs)} runs; waited the full 4 s cap in {len(cap)}/{len(rs)}")
        print(f"  commit->completed per item: median {statistics.median(lat):.2f}s  p90 {q(lat, .9):.2f}s  max {max(lat):.2f}s  (n={len(lat)})")
        print(f"  production wait after stop: median {statistics.median(tprod):.2f}s  max {max(tprod):.2f}s")
        print(f"  item-tracking wait:         median {statistics.median(alld):.2f}s  p90 {q(alld, .9):.2f}s  max {max(alld):.2f}s  (unresolved {len(rs) - len(alld)})")
        by = {}
        for r in rs:
            by.setdefault(r["clip"], []).append(r)
        for clip, rr in by.items():
            flags = "".join("T" if r["truncated"] else ("c" if r["hit_cap"] else ".") for r in rr)
            print(f"    {clip:38s} {flags}  t_prod={[r['t_prod'] for r in rr]}  all_done={[r['all_done_s'] for r in rr]}  pending@stop={[r['pending_at_stop'] for r in rr]}")
        for r in trunc[:8]:
            print(f"    LOST [{r['clip']}] prod={r['prod']!r}\n         full={r['full']!r}")


if __name__ == "__main__":
    asyncio.run(main())
