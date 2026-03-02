"""Q&A Agent — answers user questions using retrieved contract excerpts."""
from __future__ import annotations

from app.agents.base import BaseAgent, ContractState, QACitation, QAState
from app.services.model_gateway import gateway
from app.services.retrieval import hybrid_retrieve, to_citations

QA_SYSTEM = (
    "You are a Contract Q&A Analyst. Your role is to answer questions about "
    "legal contracts using ONLY the provided context excerpts.\n\n"
    "RULES:\n"
    "- Base every claim on specific language from the context. Cite the relevant "
    "section or clause when possible (e.g., 'Per Section 3.1...').\n"
    "- If the context does not contain enough information, respond with: "
    "'INSUFFICIENT_EVIDENCE: The provided contract sections do not contain "
    "information to answer this question.'\n"
    "- Be concise and direct. Use plain business language, not legalese.\n"
    "- Structure longer answers with bullet points.\n"
    "- Never speculate beyond what the contract text states."
)


class QAAgent(BaseAgent):
    name = "QAAgent"
    role = "Contract Q&A specialist — answers specific questions using hybrid retrieval (semantic + keyword) over contract chunks"
    system_prompt = QA_SYSTEM
    tools = ["hybrid_retrieve", "keyword_retrieve", "llm_generate"]

    def execute(self, state: ContractState) -> ContractState:
        trace = self._start_trace(state, ["question", "chunks", "contract_id"])

        question = state.question or "What are key risks in this contract?"
        chunks_data = [c.model_dump() for c in state.chunks]

        retrieved = hybrid_retrieve(state.contract_id, chunks_data, question, top_k=10)
        citation_objs = to_citations(retrieved)
        context = "\n\n---\n\n".join(
            f"[Section: {c.section or 'Unknown'}]\n{c.text}" for c in retrieved
        )

        prompt = f"QUESTION: {question}\n\nCONTRACT EXCERPTS:\n{context}"
        resp = gateway.generate(prompt, system=self.system_prompt)

        retrieved_chunk_ids = [c.chunk_id for c in retrieved]
        qa_citations = [
            QACitation(chunk_id=c.chunk_id, section=c.section, page=c.page, text=c.excerpt or "")
            for c in citation_objs
        ]

        state.qa = QAState(
            question=question,
            answer=resp["content"],
            citations=qa_citations,
            citation_chunk_ids=[c.chunk_id for c in qa_citations],
            retrieved_chunk_ids=retrieved_chunk_ids,
            retrieved_count=len(retrieved),
            model=resp["model"],
        )

        self._complete_trace(trace, ["qa"], {
            "model": resp["model"],
            "question": question,
            "retrieved_chunk_ids": retrieved_chunk_ids,
            "citation_chunk_ids": [c.chunk_id for c in qa_citations],
            "retrieved_count": len(retrieved),
            "citation_count": len(qa_citations),
        }, model=resp["model"])

        return state
