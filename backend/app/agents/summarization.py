"""Summarization Agent — extracts key commercial terms from contracts."""
from __future__ import annotations

import json

from app.agents.base import BaseAgent, ContractState, SummaryState
from app.services.model_gateway import gateway

SUMMARIZE_SYSTEM = (
    "You are a Contract Summarization Specialist. Your role is to extract and "
    "organize the key commercial terms from legal contracts.\n\n"
    "RULES:\n"
    "- Extract only facts present in the document. Never infer or assume.\n"
    "- Use exact dates, dollar amounts, and party names from the text.\n"
    "- If a field is not present in the contract, set its value to null.\n"
    "- Return ONLY valid JSON. No markdown, no explanation, no preamble.\n\n"
    "OUTPUT SCHEMA (strict JSON):\n"
    "{\n"
    '  "parties": {"buyer": "<name>", "supplier": "<name>"},\n'
    '  "effective_date": "<date or null>",\n'
    '  "term": "<duration description or null>",\n'
    '  "renewal_terms": "<renewal description or null>",\n'
    '  "termination_rights": "<termination description or null>",\n'
    '  "payment_terms": "<payment description or null>",\n'
    '  "liability": "<liability description or null>",\n'
    '  "indemnification": "<indemnification description or null>",\n'
    '  "confidentiality": "<confidentiality description or null>",\n'
    '  "governing_law": "<jurisdiction or null>",\n'
    '  "key_obligations": ["<obligation 1>", "<obligation 2>", ...]\n'
    "}"
)


class SummarizationAgent(BaseAgent):
    name = "SummarizationAgent"
    role = "Contract summarization specialist — extracts parties, dates, payment terms, renewal, termination rights, and key obligations"
    system_prompt = SUMMARIZE_SYSTEM
    tools = ["llm_generate"]

    def execute(self, state: ContractState) -> ContractState:
        trace = self._start_trace(state, ["chunks"])

        used_chunks = state.chunks[:10]
        source_chunk_ids = [c.chunk_id for c in used_chunks]
        text = "\n\n".join(c.text for c in used_chunks)
        prompt = f"Extract the key commercial terms from this contract.\n\nCONTRACT TEXT:\n{text}"

        resp = gateway.generate(prompt, system=self.system_prompt)
        raw = resp["content"]

        parsed = None
        try:
            clean = raw.strip()
            if clean.startswith("```"):
                clean = clean.split("\n", 1)[-1].rsplit("```", 1)[0]
            parsed = json.loads(clean)
        except (json.JSONDecodeError, IndexError):
            parsed = None

        state.summary = SummaryState(
            raw=raw,
            parsed=parsed,
            model=resp["model"],
            used_fallback=resp["used_fallback"],
            source_chunk_ids=source_chunk_ids,
        )

        self._complete_trace(trace, ["summary"], {
            "model": resp["model"],
            "used_fallback": resp["used_fallback"],
            "parsed_ok": parsed is not None,
            "source_chunk_ids": source_chunk_ids,
            "fields_extracted": list(parsed.keys()) if parsed else [],
        }, model=resp["model"])

        return state
