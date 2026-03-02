from __future__ import annotations

import logging
import re
from typing import Any

from app.models.schemas import Citation, ContractChunk

logger = logging.getLogger(__name__)


def _chunk_text(chunk: ContractChunk | dict[str, Any]) -> str:
    if isinstance(chunk, dict):
        return str(chunk.get("text", ""))
    return chunk.text


def _to_chunk_obj(chunk: ContractChunk | dict[str, Any]) -> ContractChunk:
    if isinstance(chunk, dict):
        return ContractChunk(**chunk)
    return chunk


def _normalize_terms(text: str) -> set[str]:
    raw = re.findall(r"[a-zA-Z]{3,}", text.lower())
    terms: set[str] = set()
    for token in raw:
        terms.add(token)
        if token.endswith("ing") and len(token) > 5:
            terms.add(token[:-3])
        if token.endswith("ed") and len(token) > 4:
            terms.add(token[:-2])
        if token.endswith("s") and len(token) > 4:
            terms.add(token[:-1])
    return terms


def keyword_retrieve(
    chunks: list[ContractChunk | dict[str, Any]], question: str, top_k: int = 8
) -> list[ContractChunk]:
    q_terms = _normalize_terms(question)
    scored: list[tuple[float, ContractChunk]] = []

    for chunk in chunks:
        c_obj = _to_chunk_obj(chunk)
        text = _chunk_text(c_obj).lower()
        score = 0.0
        for term in q_terms:
            if term in text:
                score += 1.0
            if f" {term} " in text:
                score += 0.5
        scored.append((score, c_obj))

    scored.sort(key=lambda item: item[0], reverse=True)
    winners = [chunk for score, chunk in scored[:top_k] if score > 0]
    if winners:
        return winners
    return [_to_chunk_obj(chunk) for chunk in chunks[:top_k]]


def to_citations(chunks: list[ContractChunk | dict[str, Any]]) -> list[Citation]:
    normalized = [_to_chunk_obj(c) for c in chunks]
    return [Citation(chunk_id=c.chunk_id, section=c.section, page=c.page, excerpt=c.text[:220]) for c in normalized]


def semantic_retrieve(contract_id: str, question: str, top_k: int = 8) -> list[ContractChunk]:
    """Semantic retrieval using embedding similarity. Falls back to keyword search on failure."""
    try:
        from app.services.embeddings import generate_embedding
        from app.services.repository import vector_search

        query_embedding = generate_embedding(question)
        if query_embedding is not None:
            results = vector_search(contract_id, query_embedding, top_k=top_k)
            if results:
                logger.info("Semantic search returned %d results for contract %s", len(results), contract_id)
                return results
    except Exception as exc:
        logger.warning("Semantic search failed, falling back to keyword: %s", exc)

    return []


def hybrid_retrieve(
    contract_id: str,
    chunks: list[ContractChunk | dict[str, Any]],
    question: str,
    top_k: int = 8,
) -> list[ContractChunk]:
    """Hybrid retrieval: try semantic search first, merge with keyword results."""
    semantic_results = semantic_retrieve(contract_id, question, top_k=top_k)
    keyword_results = keyword_retrieve(chunks, question, top_k=top_k)

    if not semantic_results:
        return keyword_results

    seen = set()
    merged: list[ContractChunk] = []
    for chunk in semantic_results:
        if chunk.chunk_id not in seen:
            seen.add(chunk.chunk_id)
            merged.append(chunk)
    for chunk in keyword_results:
        if chunk.chunk_id not in seen:
            seen.add(chunk.chunk_id)
            merged.append(chunk)

    return merged[:top_k]
