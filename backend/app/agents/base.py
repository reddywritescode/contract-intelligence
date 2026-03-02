"""Base agent class and shared contract state schema.

Every specialized agent inherits from BaseAgent, operates on a shared
ContractState (JSON-serializable), and appends structured AgentTrace
entries so every decision is auditable end-to-end.
"""
from __future__ import annotations

import uuid
from abc import ABC, abstractmethod
from datetime import datetime
from typing import Any, Optional

from pydantic import BaseModel, Field


# ── Shared Contract State ────────────────────────────────────────
# All agents read from and write to this single structure.
# It is JSON-serializable and persisted alongside each run.


class ChunkState(BaseModel):
    chunk_id: str
    text: str
    section: Optional[str] = None
    page: Optional[int] = None
    embedding_generated: bool = False


class ClauseClassification(BaseModel):
    chunk_id: str
    clause_type: str
    confidence: Optional[float] = None
    method: str = "keyword"  # "keyword" | "llm"


class ClauseAssessmentState(BaseModel):
    clause_type: str
    risk_level: str = "low"
    risk_score: int = 0
    reason: str = ""
    deviation: Optional[str] = None
    recommendation: Optional[str] = None
    standard_clause: Optional[str] = None
    chunk_ids: list[str] = Field(default_factory=list)


class RiskFlagState(BaseModel):
    risk_id: str
    risk_type: str
    severity: str
    reason: str
    policy_ref: Optional[str] = None
    citation_chunk_ids: list[str] = Field(default_factory=list)


class SummaryState(BaseModel):
    raw: str = ""
    parsed: Optional[dict[str, Any]] = None
    model: str = ""
    used_fallback: bool = False
    source_chunk_ids: list[str] = Field(default_factory=list)


class QACitation(BaseModel):
    chunk_id: str
    section: Optional[str] = None
    page: Optional[int] = None
    text: str = ""


class QAState(BaseModel):
    question: str = ""
    answer: str = ""
    citations: list[QACitation] = Field(default_factory=list)
    citation_chunk_ids: list[str] = Field(default_factory=list)
    retrieved_chunk_ids: list[str] = Field(default_factory=list)
    retrieved_count: int = 0
    model: str = ""


class AgentTrace(BaseModel):
    """One trace entry per agent invocation — fully auditable."""
    trace_id: str = Field(default_factory=lambda: f"tr_{uuid.uuid4().hex[:8]}")
    agent_name: str
    agent_role: str
    started_at: datetime = Field(default_factory=datetime.utcnow)
    completed_at: Optional[datetime] = None
    duration_ms: Optional[int] = None
    status: str = "running"  # running | completed | failed
    model_used: Optional[str] = None
    input_keys: list[str] = Field(default_factory=list)
    output_keys: list[str] = Field(default_factory=list)
    details: dict[str, Any] = Field(default_factory=dict)
    error: Optional[str] = None


class ContractState(BaseModel):
    """Shared structured state passed between all agents.

    This is the single source of truth for a contract analysis run.
    Agents read the fields they need and write their outputs here.
    Every mutation is recorded in the `trace` list.
    """
    run_id: str = Field(default_factory=lambda: f"run_{uuid.uuid4().hex[:10]}")
    contract_id: str = ""
    filename: str = ""
    mode: str = "agent"

    # Ingestion Agent outputs
    raw_text: str = ""
    chunks: list[ChunkState] = Field(default_factory=list)
    extraction_method: str = ""  # "pdf" | "docx" | "ocr" | "html" | "txt"
    ocr_used: bool = False
    metadata: dict[str, Any] = Field(default_factory=dict)

    # Clause Extraction Agent outputs
    clause_classifications: list[ClauseClassification] = Field(default_factory=list)
    clause_highlights: dict[str, list[dict[str, Any]]] = Field(default_factory=dict)
    classification_method: str = ""  # "llm" | "keyword"

    # Summarization Agent outputs
    summary: Optional[SummaryState] = None

    # Q&A Agent outputs
    qa: Optional[QAState] = None

    # Risk & Compliance Agent outputs
    risk_flags: list[RiskFlagState] = Field(default_factory=list)
    clause_assessments: list[ClauseAssessmentState] = Field(default_factory=list)

    # Orchestrator
    tasks: list[str] = Field(default_factory=list)
    question: Optional[str] = None
    requires_approval: bool = False

    # Trace log — append-only, every agent adds entries here
    trace: list[AgentTrace] = Field(default_factory=list)

    def to_workflow_dict(self) -> dict[str, Any]:
        """Convert to the legacy WorkflowState dict for backward compatibility.

        Every output includes source chunk references so the full data lineage
        is traceable: input chunks → agent → output + citations.
        """
        d: dict[str, Any] = {
            "run_id": self.run_id,
            "contract_id": self.contract_id,
            "mode": self.mode,
            "tasks": self.tasks,
            "question": self.question or "",
            "chunks": [c.model_dump() for c in self.chunks],
            "requires_approval": self.requires_approval,
            "trace": [t.model_dump(mode="json") for t in self.trace],
        }
        if self.summary:
            d["summary"] = {
                "raw": self.summary.raw,
                "parsed": self.summary.parsed,
                "model": self.summary.model,
                "used_fallback": self.summary.used_fallback,
                "source_chunk_ids": self.summary.source_chunk_ids,
            }
        if self.qa:
            d["answer"] = self.qa.answer
            d["answer_citations"] = [
                {"chunk_id": c.chunk_id, "text": c.text, "page": c.page, "section": c.section}
                for c in self.qa.citations
            ]
            d["answer_retrieved_chunk_ids"] = self.qa.retrieved_chunk_ids
        d["risks"] = [rf.model_dump() for rf in self.risk_flags] if self.risk_flags else []
        d["clause_assessments_state"] = [ca.model_dump() for ca in self.clause_assessments]
        return d


# ── Base Agent ───────────────────────────────────────────────────


class BaseAgent(ABC):
    """Abstract base class for all specialized agents."""

    name: str = "BaseAgent"
    role: str = "Base agent"
    system_prompt: str = "You are a helpful assistant."
    tools: list[str] = []  # descriptive list of tools this agent can use

    def _start_trace(self, state: ContractState, input_keys: list[str]) -> AgentTrace:
        trace = AgentTrace(
            agent_name=self.name,
            agent_role=self.role,
            input_keys=input_keys,
        )
        state.trace.append(trace)
        return trace

    def _complete_trace(self, trace: AgentTrace, output_keys: list[str],
                        details: Optional[dict[str, Any]] = None,
                        model: Optional[str] = None) -> None:
        trace.completed_at = datetime.utcnow()
        trace.duration_ms = int((trace.completed_at - trace.started_at).total_seconds() * 1000)
        trace.status = "completed"
        trace.output_keys = output_keys
        trace.model_used = model
        if details:
            trace.details.update(details)

    def _fail_trace(self, trace: AgentTrace, error: str) -> None:
        trace.completed_at = datetime.utcnow()
        trace.duration_ms = int((trace.completed_at - trace.started_at).total_seconds() * 1000)
        trace.status = "failed"
        trace.error = error

    @abstractmethod
    def execute(self, state: ContractState) -> ContractState:
        """Run this agent's logic, mutating and returning the shared state."""
        ...
