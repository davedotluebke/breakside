"""
Offline unit tests for the narration harness's metrics and session shaping
(no API keys, no audio, run by the default pytest suite).
"""
from __future__ import annotations

from .runner import (
    NameScore, TranscriptionConfig, build_vocabulary_prompt, name_recall,
    score_event_list, word_error_rate,
)

ROSTER = [
    {"name": "Morgan Vale", "nickname": "HB", "number": "8"},
    {"name": "Cyrus", "nickname": None, "number": "4"},
    {"name": "Sam", "nickname": None, "number": "3"},
    {"name": "Jamal 23", "nickname": None, "number": None},
]


def test_name_recall_counts_mentions_and_exact_tokens():
    ref = "Morgan Vale to Sam, HB again, then Cyrus scores"
    hyp = "Morgan Vale to Sam, HB again, then Sirius scores"
    s = name_recall(ref, hyp, ROSTER)
    assert (s.expected, s.found, s.missing) == (4, 3, ["cyrus"])
    assert s.recall == 0.75


def test_name_recall_longest_form_consumed_first():
    # "Morgan Vale" must not also count as a "Morgan" mention.
    s = name_recall("Morgan Vale throws", "Morgan Vale throws", ROSTER)
    assert (s.expected, s.found) == (1, 1)
    # A bare first name still counts, via the first-word form.
    s = name_recall("Morgan throws", "Morgan throws", ROSTER)
    assert (s.expected, s.found) == (1, 1)


def test_name_recall_handles_digits_in_names_and_no_mentions():
    s = name_recall("Jamal 23 goes in", "Jamal twenty three goes in", ROSTER)
    assert (s.expected, s.found) == (1, 0)
    assert name_recall("nothing here", "", ROSTER) == NameScore()
    assert name_recall("", "", None).recall == 1.0


def test_vocabulary_prompt_mirrors_production_template():
    p = build_vocabulary_prompt(ROSTER)
    assert p.startswith("Ultimate frisbee game. Likely names and terms: Morgan Vale, HB, Cyrus, Sam, Jamal 23, ")
    assert "huck" in p and "Callahan" in p


def test_transcription_config_defaults_are_production():
    c = TranscriptionConfig()
    assert (c.model, c.turn_detection, c.vad_eagerness, c.noise_reduction, c.language, c.vocabulary_hint) == (
        "gpt-4o-mini-transcribe", "semantic_vad", "medium", "near_field", "en", True
    )


def test_wer_and_event_scoring_still_agree():
    assert word_error_rate("alice throws to bob", "alice throws to bob") == 0.0
    assert word_error_rate("alice throws to bob", "alice throws to rob") == 0.25
    sc = score_event_list(
        [{"kind": "throw", "thrower": "Alice", "receiver": "Bob"}],
        [{"kind": "throw", "thrower": "Alice", "receiver": "Bob", "huck": False}],
    )
    assert sc.f1 == 1.0
