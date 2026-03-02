from __future__ import annotations

import logging
from typing import Optional

import httpx

from app.core.config import settings

logger = logging.getLogger(__name__)

EMBEDDING_DIMENSION = 1536


def _call_openrouter_embedding(texts: list[str]) -> list[list[float]] | None:
    """Call OpenRouter's embedding endpoint directly via HTTP."""
    api_key = settings.openrouter_api_key
    if not api_key:
        return None

    try:
        resp = httpx.post(
            "https://openrouter.ai/api/v1/embeddings",
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            json={
                "model": f"openai/{settings.embedding_model}",
                "input": texts,
            },
            timeout=30.0,
        )
        resp.raise_for_status()
        data = resp.json()
        embeddings = [None] * len(texts)
        for item in data.get("data", []):
            embeddings[item["index"]] = item["embedding"]
        return embeddings
    except Exception as exc:
        logger.warning("OpenRouter embedding call failed: %s", exc)
        return None


def _call_openai_embedding(texts: list[str]) -> list[list[float]] | None:
    """Call OpenAI's embedding endpoint directly."""
    api_key = settings.openai_api_key
    if not api_key:
        return None

    try:
        resp = httpx.post(
            "https://api.openai.com/v1/embeddings",
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            json={
                "model": settings.embedding_model,
                "input": texts,
            },
            timeout=30.0,
        )
        resp.raise_for_status()
        data = resp.json()
        embeddings = [None] * len(texts)
        for item in data.get("data", []):
            embeddings[item["index"]] = item["embedding"]
        return embeddings
    except Exception as exc:
        logger.warning("OpenAI embedding call failed: %s", exc)
        return None


def generate_embedding(text: str) -> Optional[list[float]]:
    """Generate an embedding vector for the given text.

    Tries OpenAI key first, then OpenRouter. Returns None on failure.
    """
    truncated = [text[:8000]]

    if settings.openai_api_key:
        result = _call_openai_embedding(truncated)
        if result and result[0]:
            return result[0]

    result = _call_openrouter_embedding(truncated)
    if result and result[0]:
        return result[0]

    return None


def generate_embeddings_batch(texts: list[str]) -> list[Optional[list[float]]]:
    """Generate embeddings for a batch of texts. Returns None for any that fail."""
    if not texts:
        return []

    truncated = [t[:8000] for t in texts]

    if settings.openai_api_key:
        result = _call_openai_embedding(truncated)
        if result and any(r is not None for r in result):
            return result

    result = _call_openrouter_embedding(truncated)
    if result and any(r is not None for r in result):
        return result

    logger.info("No embedding API available, chunks will use keyword search only")
    return [None] * len(texts)
