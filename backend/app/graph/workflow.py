"""LangGraph workflow — thin wrapper that delegates to the agent classes.

The WorkflowState dict is kept for backward compatibility with the existing
API layer. Internally, agents operate on the structured ContractState and
all mutations are traced via AgentTrace entries.
"""
from __future__ import annotations

import json
import uuid
from typing import Any, Optional, TypedDict

from langgraph.graph import END, StateGraph

from app.models.schemas import TaskType
from app.services.model_gateway import gateway

# ── Import agents ──────────────────────────────────────────────
from app.agents.base import ChunkState, ContractState
from app.agents.summarization import SummarizationAgent
from app.agents.qa import QAAgent
from app.agents.risk import RiskComplianceAgent
from app.agents.clause_extraction import ClauseExtractionAgent
from app.agents.orchestrator import OrchestratorAgent


# ── Legacy WorkflowState (kept for graph compatibility) ────────

class WorkflowState(TypedDict, total=False):
    run_id: str
    mode: str
    tasks: list[str]
    contract_id: str
    question: str
    chunks: list[dict[str, Any]]
    summary: dict[str, Any]
    answer: str
    answer_citations: list[dict[str, Any]]
    risks: list[dict[str, Any]]
    trace: list[dict[str, Any]]
    requires_approval: bool
    # internal: the structured state travels alongside the dict
    _contract_state: Any


def _build_contract_state(state: WorkflowState) -> ContractState:
    """Create a ContractState from the legacy dict."""
    cs = ContractState(
        run_id=state.get("run_id", f"run_{uuid.uuid4().hex[:10]}"),
        contract_id=state.get("contract_id", ""),
        mode=state.get("mode", "agent"),
        tasks=state.get("tasks", []),
        question=state.get("question"),
        chunks=[
            ChunkState(
                chunk_id=c.get("chunk_id", ""),
                text=c.get("text", ""),
                section=c.get("section"),
                page=c.get("page"),
            )
            for c in state.get("chunks", [])
        ],
    )
    return cs


def _get_cs(state: WorkflowState) -> ContractState:
    """Get the shared ContractState, reusing the existing one if available."""
    existing = state.get("_contract_state")
    if isinstance(existing, ContractState):
        return existing
    return _build_contract_state(state)


def _sync_back(state: WorkflowState, cs: ContractState) -> WorkflowState:
    """Write ContractState results back to the legacy dict.
    Agent traces are the single source of truth — no legacy _trace() duplication."""
    d = cs.to_workflow_dict()
    for k, v in d.items():
        state[k] = v  # type: ignore[literal-required]
    state["_contract_state"] = cs
    return state


# ── Graph nodes (delegate to agents) ──────────────────────────
# Each node retrieves the SAME ContractState via _get_cs(), runs the agent,
# and writes back via _sync_back(). The trace log is appended to by each
# agent's _start_trace / _complete_trace — no separate _trace() calls.


def initialize(state: WorkflowState) -> WorkflowState:
    state["run_id"] = state.get("run_id") or f"run_{uuid.uuid4().hex[:10]}"
    cs = _build_contract_state(state)
    from app.agents.base import AgentTrace
    cs.trace.append(AgentTrace(
        agent_name="WorkflowInit",
        agent_role="Initialize shared contract state and assign run_id",
        status="completed",
        details={"tasks": cs.tasks, "contract_id": cs.contract_id, "chunk_count": len(cs.chunks)},
        output_keys=["run_id", "contract_id", "chunks", "tasks"],
    ))
    state["_contract_state"] = cs
    state = _sync_back(state, cs)
    return state


def summarize(state: WorkflowState) -> WorkflowState:
    cs = _get_cs(state)
    cs = SummarizationAgent().execute(cs)
    return _sync_back(state, cs)


def answer_question(state: WorkflowState) -> WorkflowState:
    cs = _get_cs(state)
    cs = QAAgent().execute(cs)
    return _sync_back(state, cs)


def risk_scan(state: WorkflowState) -> WorkflowState:
    cs = _get_cs(state)
    if not cs.clause_highlights:
        cs = ClauseExtractionAgent().execute(cs)
    cs = RiskComplianceAgent().execute(cs)
    return _sync_back(state, cs)


def finalize(state: WorkflowState) -> WorkflowState:
    cs = _get_cs(state)
    cs.requires_approval = False
    from app.agents.base import AgentTrace
    cs.trace.append(AgentTrace(
        agent_name="WorkflowFinalize",
        agent_role="Mark workflow complete",
        status="completed",
        details={"status": "complete", "total_trace_entries": len(cs.trace)},
    ))
    return _sync_back(state, cs)


# ── Intent classification (used by /ask endpoint) ─────────────


def classify_intent(question: str) -> dict:
    """LLM-powered intent classification for the orchestrator."""
    cs = ContractState()
    result = OrchestratorAgent().classify_intent(question, cs)
    return result


# ── Review Summary (used by /review-summary endpoint) ──────────


REVIEW_SUMMARY_SYSTEM = (
    "You are a Contract Review Analyst. Synthesise all clause assessments, "
    "missing-clause gaps, and keyword risk flags into a concise executive summary "
    "for a human reviewer.\n\n"
    "RULES:\n"
    "- Write 2-3 sentences that highlight the most important risk findings.\n"
    "- Mention specific clause types, scores, and gaps by name.\n"
    "- State the overall risk posture (HIGH / MEDIUM / LOW) at the start.\n"
    "- Do NOT repeat every clause — focus on what matters for a go/no-go decision.\n"
    "- Return ONLY the summary paragraph. No JSON, no markdown.\n"
)


def generate_review_summary(contract_id: str) -> dict | None:
    from app.services.repository import list_clause_assessments, list_clause_library

    assessments = list_clause_assessments(contract_id)
    if not assessments:
        return None

    library = list_clause_library()
    required_names = {c["name"].lower() for c in library if c.get("required")}
    detected = {a["clause_type"].replace("_", " ").lower() for a in assessments}
    missing = required_names - detected

    high_count = sum(1 for a in assessments if a.get("risk_level") == "high")
    med_count = sum(1 for a in assessments if a.get("risk_level") == "medium")
    low_count = sum(1 for a in assessments if a.get("risk_level") == "low")
    scores = [a.get("risk_score", 0) for a in assessments]
    overall = round(sum(scores) / len(scores)) if scores else 0

    details = [
        f"- {a['clause_type']}: {a['risk_level']} (score {a.get('risk_score', '?')}). {a.get('reason', '')}"
        for a in assessments
    ]

    prompt = (
        f"Contract clause assessments:\n" + "\n".join(details) + "\n\n"
        f"Missing required clauses: {', '.join(missing) if missing else 'None'}\n"
        f"Counts — High: {high_count}, Medium: {med_count}, Low: {low_count}\n"
        f"Average risk score: {overall}/100\n\n"
        "Write a 2-3 sentence executive summary for the human reviewer."
    )

    resp = gateway.generate(prompt, system=REVIEW_SUMMARY_SYSTEM)
    ai_summary = resp.get("content", "").strip()
    if not ai_summary:
        ai_summary = (
            f"This contract has {high_count} high-risk, {med_count} medium-risk, "
            f"and {low_count} low-risk clauses with an overall score of {overall}/100."
        )
    return {"ai_summary": ai_summary, "overall_score": overall}


# ── Routing Logic ──────────────────────────────────


def route_after_init(state: WorkflowState) -> str:
    tasks = set(state.get("tasks", []))
    if TaskType.SUMMARY.value in tasks:
        return "summarize"
    if TaskType.QA.value in tasks:
        return "qa"
    if TaskType.RISK.value in tasks:
        return "risk"
    return "finalize"


def route_after_summary(state: WorkflowState) -> str:
    tasks = set(state.get("tasks", []))
    if TaskType.QA.value in tasks:
        return "qa"
    if TaskType.RISK.value in tasks:
        return "risk"
    return "finalize"


def route_after_qa(state: WorkflowState) -> str:
    tasks = set(state.get("tasks", []))
    if TaskType.RISK.value in tasks:
        return "risk"
    return "finalize"


# ── Graph Construction ─────────────────────────────


def build_graph():
    graph = StateGraph(WorkflowState)
    graph.add_node("initialize", initialize)
    graph.add_node("summarize", summarize)
    graph.add_node("qa", answer_question)
    graph.add_node("risk", risk_scan)
    graph.add_node("finalize", finalize)

    graph.set_entry_point("initialize")
    graph.add_conditional_edges("initialize", route_after_init)
    graph.add_conditional_edges("summarize", route_after_summary)
    graph.add_conditional_edges("qa", route_after_qa)
    graph.add_edge("risk", "finalize")
    graph.add_edge("finalize", END)

    return graph.compile()


workflow = build_graph()
