"""Risk & Compliance Agent — keyword risk flags + LLM per-clause assessment against playbook."""
from __future__ import annotations

import json
import logging

from app.agents.base import (
    BaseAgent, ClauseAssessmentState, ContractState, RiskFlagState,
)
from app.services.model_gateway import gateway
from app.services.retrieval import keyword_retrieve, to_citations

logger = logging.getLogger(__name__)

CLAUSE_RISK_SYSTEM = (
    "You are a Contract Risk & Compliance Analyst specializing in per-clause risk evaluation. "
    "You compare vendor contract language against approved standard clauses to identify deviations, "
    "missing protections, and risk exposure.\n\n"
    "For each clause group provided, output a JSON array where each element has:\n"
    '{"clause_type": "<category>", "risk_level": "high|medium|low", "risk_score": <0-100>, '
    '"reason": "<2-3 sentence risk explanation>", '
    '"deviation": "<how it differs from standard>", '
    '"recommendation": "<specific action to mitigate>"}\n\n'
    "SCORING GUIDE:\n"
    "- 0-30 (low): Clause is present and substantially matches standard language\n"
    "- 31-60 (medium): Clause is present but has notable deviations or weaker protections\n"
    "- 61-100 (high): Clause is missing, one-sided, or creates significant exposure\n\n"
    "Return ONLY a valid JSON array. No markdown, no explanation."
)


class RiskComplianceAgent(BaseAgent):
    name = "RiskComplianceAgent"
    role = "Risk & compliance analyst — scans for keyword risk flags and runs LLM per-clause assessment against the Clause Library playbook"
    system_prompt = CLAUSE_RISK_SYSTEM
    tools = ["keyword_retrieve", "llm_generate", "clause_library"]

    def execute(self, state: ContractState) -> ContractState:
        trace = self._start_trace(state, ["chunks", "contract_id", "clause_highlights"])

        chunks_data = [c.model_dump() for c in state.chunks]

        # Phase 1: Keyword risk flags
        risk_flags = self._keyword_risk_scan(chunks_data)
        state.risk_flags = risk_flags

        # Phase 2: LLM per-clause assessment
        assessments: list[ClauseAssessmentState] = []
        model_used = None
        try:
            from app.services.repository import list_clause_library, save_clause_assessments
            clause_lib = list_clause_library()
            if clause_lib and state.contract_id:
                raw_assessments, model_used = self._assess_clauses(
                    state.contract_id, chunks_data, clause_lib, state.clause_highlights,
                )
                for a in raw_assessments:
                    assessments.append(ClauseAssessmentState(
                        clause_type=a["clause_type"],
                        risk_level=a.get("risk_level", "low"),
                        risk_score=a.get("risk_score", 0),
                        reason=a.get("reason", ""),
                        deviation=a.get("deviation"),
                        recommendation=a.get("recommendation"),
                        standard_clause=a.get("standard_clause"),
                        chunk_ids=a.get("chunk_ids", []),
                    ))
                save_clause_assessments(state.contract_id, raw_assessments)
        except Exception as exc:
            logger.warning("Clause risk assessment failed: %s", exc)

        state.clause_assessments = assessments

        self._complete_trace(trace, ["risk_flags", "clause_assessments"], {
            "keyword_risk_count": len(risk_flags),
            "clause_assessment_count": len(assessments),
            "high_risk_clauses": [a.clause_type for a in assessments if a.risk_level == "high"],
        }, model=model_used)

        return state

    # ── Phase 1: Keyword risk flags ──

    def _keyword_risk_scan(self, chunks: list[dict]) -> list[RiskFlagState]:
        text = " ".join(c.get("text", "") for c in chunks).lower()
        flags: list[RiskFlagState] = []

        has_cap = any(p in text for p in ["shall not exceed", "aggregate liability", "limited to"])
        if "unlimited liability" in text or (("liability" in text or "indemnif" in text) and not has_cap):
            flags.append(RiskFlagState(
                risk_id="R-001", risk_type="UNLIMITED_LIABILITY", severity="HIGH",
                reason="Detected unlimited or uncapped liability exposure.",
                policy_ref="PLAYBOOK-LIABILITY-01",
                citation_chunk_ids=[h.chunk_id for h in keyword_retrieve(chunks, "liability indemnif", top_k=2)],
            ))

        if any(p in text for p in ["auto-renew", "automatic renewal", "automatically renew", "auto renew"]):
            flags.append(RiskFlagState(
                risk_id="R-002", risk_type="AUTO_RENEWAL", severity="MEDIUM",
                reason="Contract contains automatic renewal provisions. Missed notice deadlines may lock in unfavorable terms.",
                policy_ref="PLAYBOOK-TERM-02",
                citation_chunk_ids=[h.chunk_id for h in keyword_retrieve(chunks, "renewal renew notice", top_k=2)],
            ))

        if not any(p in text for p in ["terminate for convenience", "termination for convenience", "for convenience"]):
            flags.append(RiskFlagState(
                risk_id="R-003", risk_type="TERMINATION_RIGIDITY", severity="MEDIUM",
                reason="No explicit termination-for-convenience language detected.",
                policy_ref="PLAYBOOK-TERM-03",
                citation_chunk_ids=[h.chunk_id for h in keyword_retrieve(chunks, "termination notice", top_k=2)],
            ))

        if not any(p in text for p in ["governing law", "jurisdiction", "governed by"]):
            flags.append(RiskFlagState(
                risk_id="R-004", risk_type="MISSING_GOVERNING_LAW", severity="LOW",
                reason="Could not find clear governing law or jurisdiction language.",
                policy_ref="PLAYBOOK-GOV-01",
                citation_chunk_ids=[h.chunk_id for h in keyword_retrieve(chunks, "governing law jurisdiction", top_k=2)],
            ))

        if any(p in text for p in ["net 60", "net 90", "ninety (90) days", "sixty (60) days", "90 days", "60 days"]):
            if "invoice" in text or "payment" in text:
                flags.append(RiskFlagState(
                    risk_id="R-005", risk_type="LONG_PAYMENT_CYCLE", severity="LOW",
                    reason="Detected extended payment terms (60+ days) that may impact supplier cash flow.",
                    policy_ref="PLAYBOOK-PAY-02",
                    citation_chunk_ids=[h.chunk_id for h in keyword_retrieve(chunks, "payment invoice days", top_k=2)],
                ))

        return flags

    # ── Phase 2: LLM per-clause assessment ──

    def _assess_clauses(
        self, contract_id: str, chunks: list[dict],
        clause_lib: list[dict], highlights: dict,
    ) -> tuple[list[dict], str | None]:
        from app.services.insights import _classify_chunks_keyword

        if not highlights:
            highlights = _classify_chunks_keyword(chunks)

        clause_map = {c["name"].lower(): c for c in clause_lib}
        batch: list[dict] = []

        for clause_key, items in highlights.items():
            clause_name = clause_key.replace("_", " ").title()
            lib_match = None
            for lib_name, lib_data in clause_map.items():
                if any(w in lib_name for w in clause_name.lower().split()):
                    lib_match = lib_data
                    break

            vendor_text = "\n".join(
                next((c["text"] for c in chunks if c["chunk_id"] == item.get("chunk_id")), "")
                for item in items[:3]
            )[:2000]

            batch.append({
                "clause_type": clause_key,
                "vendor_text": vendor_text,
                "standard_language": lib_match["standard_language"] if lib_match else None,
                "risk_notes": lib_match["risk_notes"] if lib_match else None,
                "clause_name": lib_match["name"] if lib_match else clause_name,
                "chunk_ids": [item.get("chunk_id", "") for item in items[:3]],
            })

        for lib_clause in clause_lib:
            if lib_clause.get("required"):
                found = any(
                    any(w in bi["clause_type"].lower() for w in lib_clause["name"].lower().split()[:2])
                    for bi in batch
                )
                if not found:
                    batch.append({
                        "clause_type": lib_clause["name"].lower().replace(" ", "_"),
                        "vendor_text": "",
                        "standard_language": lib_clause.get("standard_language"),
                        "risk_notes": lib_clause.get("risk_notes"),
                        "clause_name": lib_clause["name"],
                        "chunk_ids": [],
                    })

        if not batch:
            return [], None

        context_parts = []
        for bi in batch:
            part = f"CLAUSE: {bi['clause_name']} (key: {bi['clause_type']})\n"
            part += f"VENDOR TEXT: {bi['vendor_text'][:1000]}\n" if bi["vendor_text"] else "VENDOR TEXT: NOT FOUND IN CONTRACT\n"
            if bi["standard_language"]:
                part += f"STANDARD LANGUAGE: {bi['standard_language'][:500]}\n"
            if bi["risk_notes"]:
                part += f"RISK NOTES: {bi['risk_notes']}\n"
            context_parts.append(part)

        prompt = "Assess the risk of each clause group below. Compare vendor language against the standard.\n\n" + "\n---\n".join(context_parts)
        resp = gateway.generate(prompt, system=self.system_prompt)
        raw = resp.get("content", "[]")

        try:
            clean = raw.strip()
            if clean.startswith("```"):
                clean = clean.split("\n", 1)[-1].rsplit("```", 1)[0]
            parsed = json.loads(clean)
            if not isinstance(parsed, list):
                parsed = [parsed]
        except (json.JSONDecodeError, IndexError):
            parsed = []

        chunk_id_map = {bi["clause_type"]: bi["chunk_ids"] for bi in batch}
        results = []
        for item in parsed:
            ct = item.get("clause_type", "unknown")
            cids = chunk_id_map.get(ct, [])
            lib_match = next((bi for bi in batch if bi["clause_type"] == ct), None)
            results.append({
                "chunk_id": cids[0] if cids else "",
                "clause_type": ct,
                "risk_level": item.get("risk_level", "low"),
                "risk_score": max(0, min(100, int(item.get("risk_score", 0)))),
                "reason": item.get("reason", ""),
                "standard_clause": lib_match.get("standard_language") if lib_match else None,
                "deviation": item.get("deviation", ""),
                "recommendation": item.get("recommendation", ""),
                "citations": [{"chunk_id": cid} for cid in cids],
                "chunk_ids": cids,
            })

        return results, resp.get("model")
