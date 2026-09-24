"""Unit tests for the Mica Code Harbor adapter.

Run with the Harbor environment::

    /tmp/harbor-env/bin/python -m pytest benchmarks/app/agents/test_mica_code.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

from mica_code import MicaCode  # noqa: E402


def _event(**usage: int) -> str:
    return json.dumps({"type": "turn.completed", "usage": usage})


def test_parse_usage_sums_turns_and_includes_cache_in_input() -> None:
    output = "\n".join(
        [
            json.dumps({"type": "thread.started", "thread_id": "t"}),
            json.dumps({"type": "turn.started"}),
            _event(
                input_tokens=100,
                cached_input_tokens=40,
                output_tokens=10,
                cache_write_input_tokens=0,
                reasoning_output_tokens=3,
            ),
            _event(
                input_tokens=200,
                cached_input_tokens=150,
                output_tokens=20,
                cache_write_input_tokens=0,
                reasoning_output_tokens=5,
            ),
        ]
    )

    assert MicaCode.parse_usage(output) == (300 + 190, 190, 30)


def test_parse_usage_ignores_non_json_and_malformed_lines() -> None:
    output = "\n".join(
        [
            "[mica] warning: model metadata unavailable",
            "{not json",
            _event(input_tokens=5, cached_input_tokens=0, output_tokens=1),
            "",
        ]
    )

    assert MicaCode.parse_usage(output) == (5, 0, 1)


def test_parse_usage_returns_none_without_completed_turn() -> None:
    output = json.dumps({"type": "error", "message": "boom"})

    assert MicaCode.parse_usage(output) is None


def test_parse_usage_returns_none_when_usage_missing() -> None:
    output = json.dumps({"type": "turn.completed"})

    assert MicaCode.parse_usage(output) is None


def test_parse_usage_treats_missing_fields_as_zero() -> None:
    output = _event(input_tokens=7)

    assert MicaCode.parse_usage(output) == (7, 0, 0)


@pytest.mark.parametrize(
    ("model_name", "expected"),
    [
        ("openai/gpt-5.5", "openai/gpt-5.5"),
        ("gpt-5.5", "openai/gpt-5.5"),
        # mica has its own provider ids (its built-in defaults include a
        # credential-less ``deepseek``), so Harbor's prefix must not leak
        # through - only the bare model is kept.
        ("deepseek/deepseek-flash", "openai/deepseek-flash"),
        ("anything/deepseek-flash", "openai/deepseek-flash"),
    ],
)
def test_resolve_model_qualifies_bare_names(
    model_name: str, expected: str, tmp_path: Path
) -> None:
    agent = MicaCode(logs_dir=tmp_path, model_name=model_name)

    assert agent._resolve_model() == expected


def test_resolve_model_honors_explicit_provider(tmp_path: Path) -> None:
    agent = MicaCode(
        logs_dir=tmp_path, model_name="deepseek/deepseek-flash", provider="proxy"
    )

    assert agent._resolve_model() == "proxy/deepseek-flash"


def test_resolve_model_returns_none_without_a_model(tmp_path: Path) -> None:
    assert MicaCode(logs_dir=tmp_path)._resolve_model() is None


def test_runtime_env_pins_mica_home_under_logs(tmp_path: Path) -> None:
    agent = MicaCode(logs_dir=tmp_path, model_name="openai/gpt-5.5")

    env = agent._runtime_env()

    assert env["MICA_HOME"] == "/logs/agent/mica-home"
    assert "NO_COLOR" in env
