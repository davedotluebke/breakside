"""Shared pytest configuration for the backend test suite."""


def pytest_configure(config):
    config.addinivalue_line(
        "markers",
        "live_llm: calls live LLM APIs (slow, non-deterministic, costs money). "
        "Skipped by default; opt in with NARRATION_LIVE_TESTS=1.",
    )
