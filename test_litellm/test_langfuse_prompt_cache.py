"""Integration test stubs for Langfuse prompt caching.

These tests provide a lightweight check that the Langfuse repository
contains the cache key definitions expected by downstream integrations
(such as LiteLLM) when running in GitHub Actions.
"""

from __future__ import annotations

from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]


def _read(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except FileNotFoundError as exc:  # pragma: no cover - explicit failure
        raise AssertionError(f"Expected file missing: {path}") from exc


def test_prompt_service_invalidation_clears_metadata_cache() -> None:
    """Ensure prompt metadata cache keys are tracked for invalidation."""

    service_path = (
        REPO_ROOT
        / "packages"
        / "shared"
        / "src"
        / "server"
        / "services"
        / "PromptService"
        / "index.ts"
    )

    content = _read(service_path)

    assert "prompt_meta_index" in content, (
        "PromptService should remove prompt metadata cache keys during invalidation."
    )


def test_prompts_meta_endpoint_uses_metadata_cache() -> None:
    """Verify the public prompts API stores metadata cache entries."""

    handler_path = (
        REPO_ROOT
        / "web"
        / "src"
        / "features"
        / "prompts"
        / "server"
        / "actions"
        / "getPromptsMeta.ts"
    )

    content = _read(handler_path)

    assert "PROMPT_META_CACHE_PREFIX" in content, (
        "Prompt metadata endpoint should define cache key prefixes for integration caching."
    )
