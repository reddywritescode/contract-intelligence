from __future__ import annotations

import json
import logging
from typing import Any

from app.services.model_gateway import gateway
from app.services.retrieval import keyword_retrieve

logger = logging.getLogger(__name__)

CLAUSE_CATEGORIES = [
    "term_and_renewal",
    "termination",
    "liability_and_indemnity",
    "payment",
    "governing_law",
    "confidentiality",
    "intellectual_property",
    "force_majeure",
]

CLASSIFY_SYSTEM = (
    "You are a Contract Clause Classifier. For each contract section provided, "
    "determine which clause category it belongs to.\n\n"
    "CATEGORIES:\n"
    "- term_and_renewal: Contract duration, effective dates, renewal, extension\n"
    "- termination: Termination rights, notice periods, cure periods, breach\n"
    "- liability_and_indemnity: Liability caps, indemnification, damages, insurance\n"
    "- payment: Payment terms, invoicing, fees, pricing, penalties\n"
    "- governing_law: Governing law, jurisdiction, dispute resolution, arbitration, venue\n"
    "- confidentiality: Confidentiality, non-disclosure, trade secrets\n"
    "- intellectual_property: IP ownership, licensing, work product\n"
    "- force_majeure: Force majeure, unforeseeable events, excused performance\n"
    "- none: Does not fit any specific category (general provisions, preamble, signatures)\n\n"
    "RULES:\n"
    "- Classify based on the PRIMARY topic of the section, not incidental mentions.\n"
    "- Return ONLY valid JSON. No markdown, no explanation.\n\n"
    "OUTPUT FORMAT:\n"
    '{\"classifications\": [{\"chunk_id\": \"<id>\", \"category\": \"<category>\"}]}'
)


def _classify_chunks_llm(chunks: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    """Use LLM to classify chunks into clause categories."""
    buckets: dict[str, list[dict[str, Any]]] = {cat: [] for cat in CLAUSE_CATEGORIES}

    sections_text = "\n\n".join(
        f"[chunk_id: {c.get('chunk_id', '')}] [section: {c.get('section', 'Unknown')}]\n{c.get('text', '')[:400]}"
        for c in chunks[:20]
    )

    prompt = f"Classify each contract section:\n\n{sections_text}"

    try:
        resp = gateway.generate(prompt, system=CLASSIFY_SYSTEM)
        raw = resp["content"].strip()
        if raw.startswith("```"):
            raw = raw.split("\n", 1)[-1].rsplit("```", 1)[0]
        data = json.loads(raw)
        classifications = data.get("classifications", [])

        chunk_map = {c.get("chunk_id", ""): c for c in chunks}

        for item in classifications:
            cid = item.get("chunk_id", "")
            cat = item.get("category", "none")
            if cat == "none" or cat not in buckets:
                continue
            chunk = chunk_map.get(cid)
            if chunk:
                buckets[cat].append({
                    "chunk_id": cid,
                    "section": chunk.get("section"),
                    "page": chunk.get("page"),
                    "excerpt": chunk.get("text", "")[:320],
                })

        total = sum(len(v) for v in buckets.values())
        if total > 0:
            logger.info("LLM classified %d chunks across %d categories", total, sum(1 for v in buckets.values() if v))
            return {k: v for k, v in buckets.items() if v}

    except Exception as exc:
        logger.warning("LLM clause classification failed: %s", exc)

    return {}


def _classify_chunks_keyword(chunks: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    """Keyword-based fallback classifier."""
    buckets: dict[str, list[dict[str, Any]]] = {
        "term_and_renewal": [],
        "termination": [],
        "liability_and_indemnity": [],
        "payment": [],
        "governing_law": [],
    }
    rules = {
        "term_and_renewal": ["term", "renew", "extension", "auto-renew"],
        "termination": ["terminate", "termination", "cure", "notice period"],
        "liability_and_indemnity": ["liability", "indemn", "damages", "cap"],
        "payment": ["payment", "fees", "rent", "salary", "invoice", "interest"],
        "governing_law": ["governing law", "jurisdiction", "venue", "arbitration"],
    }

    for key, terms in rules.items():
        hits = keyword_retrieve(chunks, " ".join(terms), top_k=4)
        buckets[key] = [
            {
                "chunk_id": h.chunk_id,
                "section": h.section,
                "page": h.page,
                "excerpt": h.text[:320],
            }
            for h in hits
        ]
    return buckets


def build_clause_highlights(chunks: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    """Classify chunks into clause categories. Uses LLM with keyword fallback."""
    result = _classify_chunks_llm(chunks)
    if result:
        return result
    return _classify_chunks_keyword(chunks)


def suggest_questions(chunks: list[dict[str, Any]]) -> list[str]:
    context = "\n\n".join([c.get("text", "")[:400] for c in chunks[:8]])
    prompt = (
        "Generate exactly 5 practical questions a business user should ask about this contract. "
        "Return strict JSON: {\"questions\":[\"...\",\"...\",\"...\",\"...\",\"...\"]}."
        f"\nContext:\n{context}"
    )
    resp = gateway.generate(prompt)
    text = resp["content"]

    try:
        data = json.loads(text)
        qs = data.get("questions", [])
        if isinstance(qs, list) and len(qs) >= 5:
            return [str(q).strip() for q in qs[:5]]
    except Exception:
        pass

    return [
        "What are the termination rights and notice periods?",
        "Does this contract auto-renew, and how can renewal be prevented?",
        "What are the liability caps and indemnification obligations?",
        "What payment obligations, due dates, and penalties apply?",
        "What governing law, jurisdiction, and dispute process apply?",
    ]
