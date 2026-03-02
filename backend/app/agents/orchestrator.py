"""Orchestrator Agent — interprets user intent and routes tasks to specialized agents."""
from __future__ import annotations

import json
import logging

from app.agents.base import BaseAgent, ContractState
from app.services.model_gateway import gateway

logger = logging.getLogger(__name__)

INTENT_ROUTER_SYSTEM = (
    "You are an intent classifier for a contract analysis platform. "
    "Given a user's question about a contract, determine which pipeline tasks to run.\n\n"
    "Available tasks:\n"
    "- summary: Extract key commercial terms (parties, dates, payment terms, renewal, termination rights)\n"
    "- qa: Answer a specific question using retrieved contract excerpts\n"
    "- risk: Scan for legal, financial, and compliance risks (keyword flags + AI clause assessment)\n"
    "- clause_extraction: Classify document sections into standard clause types\n"
    "- compare: Compare a clause against the internal playbook/standard language\n"
    "- explain: Explain a specific clause or section in plain language\n\n"
    "RULES:\n"
    "- Return ONLY a JSON object: {\"tasks\": [...], \"reasoning\": \"<one sentence>\"}\n"
    "- Choose the MINIMUM set of tasks needed. Don't run everything.\n"
    "- If the user asks a specific factual question, use [\"qa\"].\n"
    "- If the user asks for a summary or overview, use [\"summary\"].\n"
    "- If the user asks about risks, compliance, or red flags, use [\"risk\"].\n"
    "- If the user asks to compare/benchmark a clause, use [\"qa\", \"compare\"].\n"
    "- If the user asks to explain something, use [\"qa\", \"explain\"].\n"
    "- If the user asks a broad question like 'review this contract', use [\"summary\", \"risk\"].\n"
    "- If unclear, default to [\"qa\"].\n"
    "- Never include tasks not in the list above.\n"
    "- Return ONLY valid JSON. No markdown, no extra text."
)

VALID_TASKS = {"summary", "qa", "risk", "clause_extraction", "compare", "explain"}


class OrchestratorAgent(BaseAgent):
    name = "OrchestratorAgent"
    role = "Intent classification and task routing — interprets user questions and delegates to the right specialized agents"
    system_prompt = INTENT_ROUTER_SYSTEM
    tools = ["llm_classify", "SummarizationAgent", "QAAgent", "RiskComplianceAgent", "ClauseExtractionAgent"]

    def classify_intent(self, question: str, state: ContractState) -> dict:
        """Classify user intent and return task routing decision."""
        trace = self._start_trace(state, ["question"])

        resp = gateway.generate(f"User question: {question}", system=self.system_prompt)
        raw = resp.get("content", "").strip()

        try:
            clean = raw
            if clean.startswith("```"):
                clean = clean.split("\n", 1)[-1].rsplit("```", 1)[0]
            result = json.loads(clean)
            tasks = [t for t in result.get("tasks", ["qa"]) if t in VALID_TASKS]
            if not tasks:
                tasks = ["qa"]
            reasoning = result.get("reasoning", "")
        except (json.JSONDecodeError, KeyError, TypeError):
            tasks = ["qa"]
            reasoning = "Fallback: could not parse intent"

        self._complete_trace(trace, ["tasks"], {
            "question": question,
            "routed_tasks": tasks,
            "reasoning": reasoning,
            "model": resp.get("model", "unknown"),
        }, model=resp.get("model"))

        return {"tasks": tasks, "reasoning": reasoning, "model": resp.get("model", "unknown")}

    def execute(self, state: ContractState) -> ContractState:
        """Run the full orchestrated pipeline based on the tasks in state."""
        from app.agents.clause_extraction import ClauseExtractionAgent
        from app.agents.summarization import SummarizationAgent
        from app.agents.qa import QAAgent
        from app.agents.risk import RiskComplianceAgent

        trace = self._start_trace(state, ["tasks", "question"])

        tasks = set(state.tasks)
        agents_run: list[str] = []

        if "summary" in tasks:
            state = SummarizationAgent().execute(state)
            agents_run.append("SummarizationAgent")

        if "qa" in tasks or "explain" in tasks or "compare" in tasks:
            state = QAAgent().execute(state)
            agents_run.append("QAAgent")

        if "risk" in tasks:
            if not state.clause_highlights:
                state = ClauseExtractionAgent().execute(state)
                agents_run.append("ClauseExtractionAgent")
            state = RiskComplianceAgent().execute(state)
            agents_run.append("RiskComplianceAgent")

        if "clause_extraction" in tasks and "ClauseExtractionAgent" not in agents_run:
            state = ClauseExtractionAgent().execute(state)
            agents_run.append("ClauseExtractionAgent")

        self._complete_trace(trace, ["summary", "qa", "risk_flags", "clause_assessments"], {
            "tasks_requested": list(tasks),
            "agents_executed": agents_run,
        })

        return state
