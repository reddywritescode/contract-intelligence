from __future__ import annotations

from fastapi import HTTPException

from app.graph.workflow import workflow
from app.models.schemas import AnalyzeRequest, AnalyzeResponse
from app.services.repository import get_contract, save_run


def run_analysis(contract_id: str, request: AnalyzeRequest) -> AnalyzeResponse:
    record = get_contract(contract_id)
    if not record:
        raise HTTPException(status_code=404, detail="contract not found")

    initial_state = {
        "mode": request.mode.value,
        "tasks": [t.value for t in request.tasks],
        "contract_id": contract_id,
        "question": request.question,
        "chunks": [c.model_dump() for c in record.chunks],
    }
    result = workflow.invoke(initial_state)

    response = AnalyzeResponse(
        run_id=result["run_id"],
        contract_id=contract_id,
        mode=request.mode,
        summary=result.get("summary"),
        answer=result.get("answer"),
        answer_citations=result.get("answer_citations", []),
        risks=result.get("risks", []),
        requires_approval=result.get("requires_approval", False),
    )
    save_run(response, result.get("trace", []))
    return response
