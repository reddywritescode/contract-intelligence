"""Clause Extraction Agent — classifies document chunks into normalized clause types."""
from __future__ import annotations

import json
import logging
from typing import Any

from app.agents.base import BaseAgent, ClauseClassification, ContractState
from app.services.model_gateway import gateway

logger = logging.getLogger(__name__)

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
    '{\"classifications\": [{\"chunk_id\": \"<id>\", \"category\": \"<category>\", \"confidence\": 0.0-1.0}]}'
)

VALID_CATEGORIES = {
    "term_and_renewal", "termination", "liability_and_indemnity",
    "payment", "governing_law", "confidentiality",
    "intellectual_property", "force_majeure",
}

KEYWORD_RULES = {
    "term_and_renewal": ["term", "renew", "extension", "auto-renew"],
    "termination": ["terminate", "termination", "cure", "notice period"],
    "liability_and_indemnity": ["liability", "indemn", "damages", "cap"],
    "payment": ["payment", "fees", "rent", "salary", "invoice", "interest"],
    "governing_law": ["governing law", "jurisdiction", "venue", "arbitration"],
    "confidentiality": ["confidential", "non-disclosure", "nda", "trade secret"],
    "intellectual_property": ["intellectual property", "ip", "work product", "license"],
    "force_majeure": ["force majeure", "act of god", "unforeseeable"],
}


class ClauseExtractionAgent(BaseAgent):
    name = "ClauseExtractionAgent"
    role = "Clause extraction and normalization specialist — classifies contract sections into standard clause types using LLM with keyword fallback"
    system_prompt = CLASSIFY_SYSTEM
    tools = ["llm_classifier", "keyword_matcher"]

    def execute(self, state: ContractState) -> ContractState:
        trace = self._start_trace(state, ["chunks"])

        chunks_data = [c.model_dump() for c in state.chunks]
        method = "llm"
        classifications: list[ClauseClassification] = []
        highlights: dict[str, list[dict[str, Any]]] = {}

        # Try LLM classification first
        try:
            llm_result = self._classify_llm(chunks_data)
            if llm_result:
                for item in llm_result:
                    classifications.append(ClauseClassification(
                        chunk_id=item["chunk_id"],
                        clause_type=item["category"],
                        confidence=item.get("confidence"),
                        method="llm",
                    ))
                highlights = self._build_highlights(llm_result, chunks_data)
            else:
                raise ValueError("LLM returned empty classification")
        except Exception as exc:
            logger.warning("LLM classification failed (%s), falling back to keywords", exc)
            method = "keyword"
            kw_result = self._classify_keyword(chunks_data)
            for cat, items in kw_result.items():
                for item in items:
                    classifications.append(ClauseClassification(
                        chunk_id=item["chunk_id"],
                        clause_type=cat,
                        method="keyword",
                    ))
            highlights = kw_result

        state.clause_classifications = classifications
        state.clause_highlights = highlights
        state.classification_method = method

        self._complete_trace(trace, ["clause_classifications", "clause_highlights", "classification_method"], {
            "method": method,
            "total_classified": len(classifications),
            "categories_found": list({c.clause_type for c in classifications}),
        })
        return state

    def _classify_llm(self, chunks: list[dict]) -> list[dict]:
        sections_text = "\n\n".join(
            f"[chunk_id: {c.get('chunk_id', '')}] [section: {c.get('section', 'Unknown')}]\n{c.get('text', '')[:400]}"
            for c in chunks[:20]
        )
        prompt = f"Classify each contract section:\n\n{sections_text}"
        resp = gateway.generate(prompt, system=self.system_prompt)
        raw = resp["content"].strip()
        if raw.startswith("```"):
            raw = raw.split("\n", 1)[-1].rsplit("```", 1)[0]
        data = json.loads(raw)
        items = data.get("classifications", [])
        return [i for i in items if i.get("category", "none") in VALID_CATEGORIES]

    def _classify_keyword(self, chunks: list[dict]) -> dict[str, list[dict]]:
        from app.services.retrieval import keyword_retrieve
        buckets: dict[str, list[dict]] = {}
        for key, terms in KEYWORD_RULES.items():
            hits = keyword_retrieve(chunks, " ".join(terms), top_k=4)
            buckets[key] = [
                {"chunk_id": h.chunk_id, "section": h.section, "page": h.page, "excerpt": h.text[:320]}
                for h in hits
            ]
        return {k: v for k, v in buckets.items() if v}

    @staticmethod
    def _build_highlights(classifications: list[dict], chunks: list[dict]) -> dict[str, list[dict]]:
        chunk_map = {c.get("chunk_id", ""): c for c in chunks}
        highlights: dict[str, list[dict]] = {}
        for item in classifications:
            cat = item["category"]
            cid = item["chunk_id"]
            chunk = chunk_map.get(cid)
            if not chunk:
                continue
            highlights.setdefault(cat, []).append({
                "chunk_id": cid,
                "section": chunk.get("section"),
                "page": chunk.get("page"),
                "excerpt": chunk.get("text", "")[:320],
            })
        return highlights
