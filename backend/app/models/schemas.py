from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Any, Optional

from pydantic import BaseModel, Field


class RunMode(str, Enum):
    REVIEW = "review"
    AGENT = "agent"


class TaskType(str, Enum):
    SUMMARY = "summary"
    QA = "qa"
    RISK = "risk"


class ContractChunk(BaseModel):
    chunk_id: str
    text: str
    section: Optional[str] = None
    page: Optional[int] = None


class Citation(BaseModel):
    chunk_id: str
    section: Optional[str] = None
    page: Optional[int] = None
    excerpt: Optional[str] = None


class RiskFinding(BaseModel):
    risk_id: str
    risk_type: str
    severity: str
    reason: str
    policy_ref: str
    citations: list[Citation] = Field(default_factory=list)


class ContractRecord(BaseModel):
    contract_id: str
    filename: str
    created_at: datetime = Field(default_factory=datetime.utcnow)
    chunks: list[ContractChunk] = Field(default_factory=list)


class IngestResponse(BaseModel):
    contract_id: str
    status: str
    chunks_indexed: int


class AnalyzeRequest(BaseModel):
    mode: RunMode
    tasks: list[TaskType]
    question: Optional[str] = None


class AnalyzeResponse(BaseModel):
    run_id: str
    contract_id: str
    mode: RunMode
    summary: Optional[dict[str, Any]] = None
    answer: Optional[str] = None
    answer_citations: list[Citation] = Field(default_factory=list)
    risks: list[RiskFinding] = Field(default_factory=list)
    requires_approval: bool = False


class AskRequest(BaseModel):
    question: str


class AskResponse(BaseModel):
    contract_id: str
    answer: str
    confidence: float
    citations: list[Citation]


class ApproveRequest(BaseModel):
    approved: bool


class TraceEvent(BaseModel):
    ts: datetime = Field(default_factory=datetime.utcnow)
    step: str
    details: dict[str, Any] = Field(default_factory=dict)


class RunTrace(BaseModel):
    run_id: str
    contract_id: str
    mode: RunMode
    events: list[TraceEvent]
