from __future__ import annotations

from pathlib import Path

from typing import Optional

from fastapi import APIRouter, File, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel

from app.models.schemas import (
    AnalyzeRequest,
    AnalyzeResponse,
    ApproveRequest,
    AskRequest,
    AskResponse,
    IngestResponse,
)
from app.services.analysis import run_analysis
from app.services.ingestion import UPLOADS_DIR, ingest_contract
from app.services.insights import build_clause_highlights, suggest_questions
from app.services.repository import (
    add_comment,
    create_agent_task,
    create_clause,
    create_doc_template,
    create_generated_doc,
    create_prompt_template,
    create_review_session,
    create_workflow,
    delete_clause,
    delete_prompt_template,
    get_agent_task,
    get_clause,
    get_contract,
    get_dashboard_insights,
    list_clause_assessments,
    save_clause_assessments,
    get_doc_template,
    get_prompt_template,
    get_review_session,
    get_run_summary,
    get_trace,
    get_workflow,
    list_activity,
    list_agent_tasks,
    list_clause_library,
    list_comments,
    list_contracts,
    list_doc_templates,
    list_generated_docs,
    list_prompt_templates,
    list_recent_run_ids,
    list_review_sessions,
    list_runs,
    list_workflows,
    log_activity,
    set_run_approval,
    update_agent_task,
    update_clause,
    update_review_session,
    update_workflow_step,
    delete_contract,
    delete_all_contracts,
    get_review_decision,
    save_review_decision,
    save_review_summary,
)
from app.services.retrieval import keyword_retrieve, to_citations

router = APIRouter()


@router.get("/contracts")
def contracts(
    contract_type: Optional[str] = Query(None),
    counterparty: Optional[str] = Query(None),
    status: Optional[str] = Query(None),
    risk_level: Optional[str] = Query(None),
    date_from: Optional[str] = Query(None),
    date_to: Optional[str] = Query(None),
    search: Optional[str] = Query(None),
):
    return {"contracts": list_contracts(
        contract_type=contract_type,
        counterparty=counterparty,
        status=status,
        risk_level=risk_level,
        date_from=date_from,
        date_to=date_to,
        search=search,
    )}


@router.delete("/contracts")
def contracts_delete_all():
    import shutil
    count = delete_all_contracts()
    uploads = Path(UPLOADS_DIR)
    if uploads.exists():
        for f in uploads.iterdir():
            if f.is_file():
                f.unlink(missing_ok=True)
    return {"deleted": count}


@router.delete("/contracts/{contract_id}")
def contracts_delete_one(contract_id: str):
    upload_file = Path(UPLOADS_DIR) / contract_id
    for ext in ("", ".pdf", ".docx", ".txt", ".html"):
        candidate = Path(UPLOADS_DIR) / f"{contract_id}{ext}"
        if candidate.exists():
            candidate.unlink(missing_ok=True)
    for child in Path(UPLOADS_DIR).iterdir():
        if child.name.startswith(contract_id):
            child.unlink(missing_ok=True)
    if not delete_contract(contract_id):
        raise HTTPException(status_code=404, detail="Contract not found")
    return {"deleted": True}


# ─── Review Decision & Summary ─────────────────────────


@router.get("/contracts/{contract_id}/review-decision")
def get_review(contract_id: str):
    row = get_review_decision(contract_id)
    if not row:
        return {"decision": "pending", "reviewer_notes": None, "ai_summary": None, "overall_score": None, "decided_at": None}
    return row


class ReviewDecisionBody(BaseModel):
    decision: str
    reviewer_notes: Optional[str] = None
    decided_by: str = "analyst"


@router.put("/contracts/{contract_id}/review-decision")
def put_review_decision(contract_id: str, body: ReviewDecisionBody):
    row = save_review_decision(
        contract_id=contract_id,
        decision=body.decision,
        reviewer_notes=body.reviewer_notes,
        decided_by=body.decided_by,
    )
    return row


@router.post("/contracts/{contract_id}/review-summary")
def generate_review_summary_endpoint(contract_id: str):
    from app.graph.workflow import generate_review_summary as gen_summary

    result = gen_summary(contract_id)
    if not result:
        raise HTTPException(status_code=400, detail="Unable to generate review summary — run risk assessment first.")
    row = save_review_summary(contract_id, result["ai_summary"], result["overall_score"])
    return row


@router.post("/contracts/ingest", response_model=IngestResponse)
async def ingest(file: UploadFile = File(...)) -> IngestResponse:
    content = await file.read()
    record = ingest_contract(file.filename or "unknown.txt", content)
    log_activity(record.contract_id, "contract_uploaded", f"Uploaded {file.filename}")
    return IngestResponse(contract_id=record.contract_id, status="indexed", chunks_indexed=len(record.chunks))


@router.post("/contracts/{contract_id}/analyze", response_model=AnalyzeResponse)
def analyze(contract_id: str, request: AnalyzeRequest) -> AnalyzeResponse:
    result = run_analysis(contract_id, request)
    log_activity(contract_id, "analysis_completed", f"Analysis run: {', '.join(t.value for t in request.tasks)}")
    return result


@router.post("/contracts/{contract_id}/ask")
def ask(contract_id: str, request: AskRequest):
    """LLM-orchestrated endpoint: classifies intent, routes to the right
    pipeline tasks, and returns a unified response."""
    from app.graph.workflow import classify_intent, workflow as wf

    record = get_contract(contract_id)
    if not record:
        raise HTTPException(status_code=404, detail="contract not found")

    intent = classify_intent(request.question)
    routed_tasks = intent["tasks"]

    task_enum_map = {"summary": "summary", "qa": "qa", "risk": "risk"}
    wf_tasks = [task_enum_map[t] for t in routed_tasks if t in task_enum_map]
    if not wf_tasks:
        wf_tasks = ["qa"]

    initial_state = {
        "mode": "agent",
        "tasks": wf_tasks,
        "contract_id": contract_id,
        "question": request.question,
        "chunks": [c.model_dump() for c in record.chunks],
    }
    result = wf.invoke(initial_state)

    from app.services.repository import save_run
    from app.models.schemas import AnalyzeResponse, RunMode
    response = AnalyzeResponse(
        run_id=result["run_id"],
        contract_id=contract_id,
        mode=RunMode.AGENT,
        summary=result.get("summary"),
        answer=result.get("answer"),
        answer_citations=result.get("answer_citations", []),
        risks=result.get("risks", []),
        requires_approval=result.get("requires_approval", False),
    )
    save_run(response, result.get("trace", []))
    log_activity(contract_id, "ai_ask", f"Q: {request.question[:80]} | Routed: {', '.join(routed_tasks)}")

    return {
        "run_id": result["run_id"],
        "contract_id": contract_id,
        "answer": result.get("answer", ""),
        "answer_citations": result.get("answer_citations", []),
        "summary": result.get("summary"),
        "risks": result.get("risks", []),
        "intent": intent,
    }


@router.get("/contracts/{contract_id}/risks")
def risks(contract_id: str):
    if not get_contract(contract_id):
        raise HTTPException(status_code=404, detail="contract not found")
    return {"contract_id": contract_id, "latest_runs": list_recent_run_ids(contract_id)}


@router.get("/contracts/{contract_id}/runs")
def contract_runs(contract_id: str):
    if not get_contract(contract_id):
        raise HTTPException(status_code=404, detail="contract not found")
    return {"contract_id": contract_id, "runs": list_runs(contract_id)}


@router.get("/contracts/{contract_id}/file")
def contract_file(contract_id: str):
    record = get_contract(contract_id)
    if not record:
        raise HTTPException(status_code=404, detail="contract not found")
    contract_dir = UPLOADS_DIR / contract_id
    if not contract_dir.exists():
        raise HTTPException(status_code=404, detail="file not found")
    files = list(contract_dir.iterdir())
    if not files:
        raise HTTPException(status_code=404, detail="file not found")
    file_path = files[0]
    ext = file_path.suffix.lower()
    media_types = {".pdf": "application/pdf", ".txt": "text/plain", ".md": "text/plain", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".html": "text/html"}
    return FileResponse(
        file_path,
        media_type=media_types.get(ext, "application/octet-stream"),
        filename=record.filename,
        content_disposition_type="inline"
    )


@router.get("/contracts/{contract_id}/chunks")
def chunks(contract_id: str):
    record = get_contract(contract_id)
    if not record:
        raise HTTPException(status_code=404, detail="contract not found")
    return {
        "contract_id": contract_id,
        "chunks": [
            {"chunk_id": c.chunk_id, "text": c.text, "section": c.section, "page": c.page}
            for c in record.chunks
        ],
    }


@router.get("/contracts/{contract_id}/highlights")
def highlights(contract_id: str):
    record = get_contract(contract_id)
    if not record:
        raise HTTPException(status_code=404, detail="contract not found")
    chunks = [c.model_dump() for c in record.chunks]
    return {"contract_id": contract_id, "highlights": build_clause_highlights(chunks)}


@router.get("/contracts/{contract_id}/suggested-questions")
def suggested_questions(contract_id: str):
    record = get_contract(contract_id)
    if not record:
        raise HTTPException(status_code=404, detail="contract not found")
    chunks = [c.model_dump() for c in record.chunks]
    return {"contract_id": contract_id, "questions": suggest_questions(chunks)}


@router.post("/runs/{run_id}/approve")
def approve(run_id: str, request: ApproveRequest):
    updated = set_run_approval(run_id, request.approved)
    if not updated:
        raise HTTPException(status_code=404, detail="run not found")
    return {"run_id": run_id, "approved": request.approved}


@router.get("/runs/{run_id}/trace")
def trace(run_id: str):
    trace_data = get_trace(run_id)
    if not trace_data:
        raise HTTPException(status_code=404, detail="run not found")
    return trace_data


@router.get("/runs/{run_id}")
def run_details(run_id: str):
    run = get_run_summary(run_id)
    if not run:
        raise HTTPException(status_code=404, detail="run not found")
    return run


@router.get("/contracts/{contract_id}/comments")
def get_comments(contract_id: str):
    if not get_contract(contract_id):
        raise HTTPException(status_code=404, detail="contract not found")
    return {"contract_id": contract_id, "comments": list_comments(contract_id)}


@router.post("/contracts/{contract_id}/comments")
def post_comment(contract_id: str, body: dict):
    if not get_contract(contract_id):
        raise HTTPException(status_code=404, detail="contract not found")
    text = body.get("text", "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="text is required")
    chunk_id = body.get("chunk_id")
    author = body.get("author", "User")
    comment = add_comment(contract_id, text, chunk_id=chunk_id, author=author)
    return comment


@router.get("/contracts/{contract_id}/activity")
def get_activity(contract_id: str):
    if not get_contract(contract_id):
        raise HTTPException(status_code=404, detail="contract not found")
    return {"contract_id": contract_id, "activity": list_activity(contract_id)}


@router.get("/contracts/{contract_id}/clause-gaps")
def clause_gaps(contract_id: str):
    """Compare detected clauses against standard clause library and report gaps."""
    record = get_contract(contract_id)
    if not record:
        raise HTTPException(status_code=404, detail="contract not found")
    chunks = [c.model_dump() for c in record.chunks]
    hl = build_clause_highlights(chunks)

    CLAUSE_LIBRARY = {
        "term_and_renewal": {"name": "Term & Renewal", "description": "Contract duration, effective dates, renewal terms, extension options", "required": True},
        "termination": {"name": "Termination", "description": "Termination rights, notice periods, cure periods, breach conditions", "required": True},
        "liability_and_indemnity": {"name": "Liability & Indemnification", "description": "Liability caps, indemnification obligations, damages limitations, insurance", "required": True},
        "payment": {"name": "Payment Terms", "description": "Payment schedule, invoicing, fees, pricing, late penalties", "required": True},
        "governing_law": {"name": "Governing Law & Disputes", "description": "Jurisdiction, venue, arbitration, dispute resolution process", "required": True},
        "confidentiality": {"name": "Confidentiality", "description": "NDA obligations, confidential information definition, duration, exceptions", "required": True},
        "intellectual_property": {"name": "Intellectual Property", "description": "IP ownership, work product, licensing rights, pre-existing IP", "required": True},
        "force_majeure": {"name": "Force Majeure", "description": "Excused performance for events beyond control, notification requirements", "required": False},
        "data_protection": {"name": "Data Protection", "description": "Data privacy, GDPR/CCPA compliance, data processing agreements", "required": False},
        "non_solicitation": {"name": "Non-Solicitation", "description": "Non-solicitation of employees, non-compete restrictions", "required": False},
        "assignment": {"name": "Assignment", "description": "Rights to assign or transfer contract obligations", "required": False},
        "warranties": {"name": "Warranties & Representations", "description": "Representations, warranties, disclaimers", "required": False},
        "insurance": {"name": "Insurance", "description": "Insurance coverage requirements, certificates of insurance", "required": False},
        "audit_rights": {"name": "Audit Rights", "description": "Right to audit supplier/vendor compliance and records", "required": False},
    }

    results = []
    for key, lib in CLAUSE_LIBRARY.items():
        detected_items = hl.get(key, [])
        if detected_items:
            status = "detected"
            excerpts = [item.get("excerpt", "")[:200] for item in detected_items[:2]]
        else:
            status = "missing"
            excerpts = []
        results.append({
            "clause_key": key,
            "name": lib["name"],
            "description": lib["description"],
            "required": lib["required"],
            "status": status,
            "review_status": "needs_review",
            "count": len(detected_items),
            "excerpts": excerpts,
        })

    results.sort(key=lambda x: (
        0 if x["required"] and x["status"] == "missing" else
        1 if x["required"] and x["status"] == "detected" else
        2 if not x["required"] and x["status"] == "detected" else 3
    ))

    return {"contract_id": contract_id, "clause_library": results}


@router.get("/contracts/{contract_id}/clause-assessments")
def get_clause_assessments(contract_id: str):
    if not get_contract(contract_id):
        raise HTTPException(status_code=404, detail="contract not found")
    return {"contract_id": contract_id, "assessments": list_clause_assessments(contract_id)}


@router.post("/contracts/{contract_id}/clause-assessments/run")
def run_clause_assessments(contract_id: str):
    """Run LLM-powered per-clause risk assessment against the Clause Library."""
    record = get_contract(contract_id)
    if not record:
        raise HTTPException(status_code=404, detail="contract not found")

    from app.graph.workflow import assess_clause_risks
    chunks = [c.model_dump() for c in record.chunks]
    clauses = list_clause_library()
    assessments = assess_clause_risks(contract_id, chunks, clauses)
    save_clause_assessments(contract_id, assessments)
    log_activity(contract_id, "clause_risk_assessment", f"AI assessed {len(assessments)} clause risks")
    return {"contract_id": contract_id, "assessments": assessments}


@router.get("/dashboard/insights")
def dashboard_insights():
    """Aggregate analytics across all contracts."""
    return get_dashboard_insights()


@router.post("/contracts/{contract_id}/explain")
def explain_clause(contract_id: str, body: dict):
    """Use AI to explain a clause excerpt."""
    record = get_contract(contract_id)
    if not record:
        raise HTTPException(status_code=404, detail="contract not found")
    text = body.get("text", "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="text is required")

    from app.services.model_gateway import gateway
    prompt = (
        "You are a contract analysis expert. Explain the following contract clause in plain business language. "
        "Identify: 1) What it means in practice, 2) Key obligations for each party, 3) Any risks or concerns. "
        "Keep explanation concise (3-5 sentences).\n\n"
        f"Clause text:\n{text[:2000]}"
    )
    resp = gateway.generate(prompt)

    log_activity(contract_id, "ai_explain", f"AI explained clause: {text[:80]}...")
    return {"contract_id": contract_id, "explanation": resp.get("content", "Unable to generate explanation.")}


# ─── Sentinel AI Assistant Endpoints ──────────────────

@router.get("/sentinel/prompts")
def sentinel_prompts(category: Optional[str] = Query(None)):
    return {"prompts": list_prompt_templates(category=category)}


@router.get("/sentinel/prompts/{prompt_id}")
def sentinel_prompt_detail(prompt_id: str):
    p = get_prompt_template(prompt_id)
    if not p:
        raise HTTPException(status_code=404, detail="prompt not found")
    return p


@router.post("/sentinel/prompts")
def sentinel_create_prompt(body: dict):
    name = body.get("name", "").strip()
    prompt_text = body.get("prompt_text", "").strip()
    if not name or not prompt_text:
        raise HTTPException(status_code=400, detail="name and prompt_text are required")
    return create_prompt_template(
        name=name,
        description=body.get("description", ""),
        prompt_text=prompt_text,
        category=body.get("category", "Custom"),
        author=body.get("author", "User"),
    )


@router.delete("/sentinel/prompts/{prompt_id}")
def sentinel_delete_prompt(prompt_id: str):
    if not delete_prompt_template(prompt_id):
        raise HTTPException(status_code=404, detail="prompt not found or is a system prompt")
    return {"deleted": True}


@router.post("/sentinel/review")
def sentinel_review(body: dict):
    """Run a Sentinel AI review: takes a contract + prompt and generates a structured review."""
    contract_id = body.get("contract_id")
    prompt_id = body.get("prompt_id")
    custom_prompt = body.get("custom_prompt", "").strip()

    if not contract_id:
        raise HTTPException(status_code=400, detail="contract_id is required")

    record = get_contract(contract_id)
    if not record:
        raise HTTPException(status_code=404, detail="contract not found")

    if not prompt_id and not custom_prompt:
        raise HTTPException(status_code=400, detail="prompt_id or custom_prompt is required")

    prompt_text = custom_prompt
    prompt_name = "Custom Prompt"
    if prompt_id:
        tmpl = get_prompt_template(prompt_id)
        if not tmpl:
            raise HTTPException(status_code=404, detail="prompt template not found")
        prompt_text = tmpl["prompt_text"]
        prompt_name = tmpl["name"]

    session_id = create_review_session(contract_id, prompt_id=prompt_id, custom_prompt=custom_prompt or None)

    # Build contract context from chunks
    contract_text = "\n\n".join(
        f"[Section: {c.section or 'Unknown'}]\n{c.text}" for c in record.chunks
    )
    if len(contract_text) > 15000:
        contract_text = contract_text[:15000] + "\n\n[... truncated for length ...]"

    from app.services.model_gateway import gateway

    full_prompt = (
        f"{prompt_text}\n\n"
        f"--- CONTRACT: {record.filename} ---\n\n"
        f"{contract_text}"
    )

    try:
        resp = gateway.generate(full_prompt)
        content = resp.get("content", "")
        result = {
            "review_text": content,
            "prompt_name": prompt_name,
            "contract_filename": record.filename,
            "chunk_count": len(record.chunks),
        }
        update_review_session(session_id, status="completed", result=result)
        log_activity(contract_id, "sentinel_review", f"Sentinel reviewed with: {prompt_name}")
    except Exception as e:
        update_review_session(session_id, status="failed", result={"error": str(e)})
        raise HTTPException(status_code=500, detail=f"Review failed: {str(e)}")

    return {
        "session_id": session_id,
        "contract_id": contract_id,
        "status": "completed",
        "result": result,
    }


@router.get("/sentinel/sessions")
def sentinel_sessions(contract_id: Optional[str] = Query(None)):
    return {"sessions": list_review_sessions(contract_id=contract_id)}


@router.get("/sentinel/sessions/{session_id}")
def sentinel_session_detail(session_id: str):
    s = get_review_session(session_id)
    if not s:
        raise HTTPException(status_code=404, detail="session not found")
    return s


# ─── Autopilot Agent Endpoints ────────────────────

TASK_TEMPLATES = [
    {"key": "expiry_report", "title": "Expiring Contracts Report", "description": "Find all contracts expiring within the next 90 days and generate an action report.", "task_type": "report", "icon": "calendar"},
    {"key": "risk_audit", "title": "Portfolio Risk Audit", "description": "Run risk analysis across all contracts and compile a risk heat-map summary.", "task_type": "report", "icon": "shield"},
    {"key": "missing_clauses", "title": "Missing Clauses Scan", "description": "Scan all contracts for missing standard clauses and generate a compliance gap report.", "task_type": "compliance", "icon": "search"},
    {"key": "spend_summary", "title": "Vendor Spend Summary", "description": "Aggregate contract values by vendor/counterparty and produce a spend breakdown.", "task_type": "data_pull", "icon": "dollar"},
    {"key": "renewal_tracker", "title": "Auto-Renewal Tracker", "description": "Identify all contracts with auto-renewal provisions and opt-out deadlines.", "task_type": "data_pull", "icon": "refresh"},
    {"key": "compliance_check", "title": "Data Privacy Compliance Check", "description": "Check all contracts for GDPR/CCPA compliance gaps and generate findings.", "task_type": "compliance", "icon": "lock"},
    {"key": "executive_brief", "title": "Executive Portfolio Brief", "description": "Generate a C-level summary of the entire contract portfolio — types, risks, obligations.", "task_type": "report", "icon": "briefcase"},
    {"key": "counterparty_intel", "title": "Counterparty Intelligence", "description": "Compile a dossier on all counterparties with contract history and risk profiles.", "task_type": "data_pull", "icon": "users"},
]


@router.get("/autopilot/templates")
def autopilot_templates():
    return {"templates": TASK_TEMPLATES}


@router.get("/autopilot/tasks")
def autopilot_tasks(status: Optional[str] = Query(None)):
    return {"tasks": list_agent_tasks(status=status)}


@router.get("/autopilot/tasks/{task_id}")
def autopilot_task_detail(task_id: str):
    t = get_agent_task(task_id)
    if not t:
        raise HTTPException(status_code=404, detail="task not found")
    return t


@router.post("/autopilot/tasks")
def autopilot_create_task(body: dict):
    title = body.get("title", "").strip()
    description = body.get("description", "").strip()
    task_type = body.get("task_type", "custom")
    scope = body.get("scope", "all")
    contract_id = body.get("contract_id")

    if not title or not description:
        raise HTTPException(status_code=400, detail="title and description are required")

    task_id = create_agent_task(
        title=title, description=description,
        task_type=task_type, scope=scope, contract_id=contract_id,
    )
    return {"task_id": task_id, "status": "queued"}


@router.post("/autopilot/tasks/{task_id}/execute")
def autopilot_execute(task_id: str):
    """Self-serve agent: executes the task autonomously with step-by-step progress."""
    task = get_agent_task(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="task not found")
    if task["status"] not in ("queued", "failed"):
        raise HTTPException(status_code=400, detail="task already running or completed")

    update_agent_task(task_id, status="running", progress=0)
    update_agent_task(task_id, step={"step": "started", "message": f"Agent started: {task['title']}", "ts": _now()})

    try:
        _run_agent_task(task_id, task)
    except Exception as e:
        update_agent_task(task_id, status="failed", step={"step": "error", "message": str(e), "ts": _now()})
        raise HTTPException(status_code=500, detail=str(e))

    final = get_agent_task(task_id)
    return final


def _now() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat()


def _run_agent_task(task_id: str, task: dict) -> None:
    """Execute the actual agent work based on task type."""
    from app.services.model_gateway import gateway

    all_contracts = list_contracts(limit=100)
    update_agent_task(task_id, progress=10, step={
        "step": "gathering_data",
        "message": f"Found {len(all_contracts)} contracts in repository.",
        "ts": _now(),
    })

    # Build context from contracts
    contract_summaries = []
    for c in all_contracts:
        summary = f"- {c['filename']} | Type: {c.get('contract_type', 'Unknown')} | Counterparty: {c.get('counterparty', 'Unknown')} | Status: {c.get('status', 'N/A')} | Risk: {c.get('risk_level', 'N/A')} | Date: {c.get('agreement_date', 'N/A')}"
        contract_summaries.append(summary)

    portfolio_context = "\n".join(contract_summaries) if contract_summaries else "No contracts in repository."

    update_agent_task(task_id, progress=25, step={
        "step": "building_context",
        "message": "Built portfolio context from contract metadata.",
        "ts": _now(),
    })

    # If task targets a specific contract, get its chunks for deeper analysis
    deep_context = ""
    if task.get("contract_id"):
        record = get_contract(task["contract_id"])
        if record:
            deep_context = "\n\n--- DETAILED CONTRACT CONTENT ---\n"
            for chunk in record.chunks[:20]:
                deep_context += f"\n[{chunk.section or 'Section'}]\n{chunk.text}\n"
            if len(deep_context) > 10000:
                deep_context = deep_context[:10000] + "\n[...truncated...]"

    update_agent_task(task_id, progress=40, step={
        "step": "analyzing",
        "message": "Sending to AI for analysis...",
        "ts": _now(),
    })

    task_type = task.get("task_type", "custom")
    task_desc = task["description"]

    system_prompt = (
        "You are an autonomous AI agent for contract portfolio management at a large enterprise. "
        "You have been given a task to complete. Execute it thoroughly and provide a detailed, "
        "well-structured report in markdown format. Include tables where appropriate.\n\n"
        f"TASK: {task['title']}\n"
        f"DESCRIPTION: {task_desc}\n"
        f"TYPE: {task_type}\n\n"
        f"CONTRACT PORTFOLIO:\n{portfolio_context}\n"
    )

    if deep_context:
        system_prompt += f"\n{deep_context}\n"

    system_prompt += (
        "\nProvide a comprehensive, actionable report. "
        "Use markdown formatting with headers, tables, and bullet points. "
        "Include specific recommendations and next steps."
    )

    update_agent_task(task_id, progress=60, step={
        "step": "generating_report",
        "message": "AI agent is generating report...",
        "ts": _now(),
    })

    resp = gateway.generate(system_prompt)
    content = resp.get("content", "")

    if not content:
        update_agent_task(task_id, status="failed", step={
            "step": "error",
            "message": "AI did not return any content.",
            "ts": _now(),
        })
        return

    update_agent_task(task_id, progress=90, step={
        "step": "saving_results",
        "message": "Saving results and finalizing...",
        "ts": _now(),
    })

    result = {
        "report": content,
        "contracts_analyzed": len(all_contracts),
        "task_type": task_type,
    }

    update_agent_task(task_id, status="completed", progress=100, result=result, step={
        "step": "completed",
        "message": f"Task completed successfully. Analyzed {len(all_contracts)} contracts.",
        "ts": _now(),
    })


# ─── CLAUSE LIBRARY ──────────────────────────────────

@router.get("/clause-library")
def clause_library_list(category: Optional[str] = Query(None)):
    return {"clauses": list_clause_library(category=category)}


@router.get("/clause-library/{clause_id}")
def clause_library_get(clause_id: str):
    c = get_clause(clause_id)
    if not c:
        raise HTTPException(status_code=404, detail="Clause not found")
    return c


@router.post("/clause-library")
def clause_library_create(data: dict):
    if not data.get("name") or not data.get("description"):
        raise HTTPException(status_code=400, detail="name and description are required")
    return create_clause(data)


@router.put("/clause-library/{clause_id}")
def clause_library_update(clause_id: str, data: dict):
    updated = update_clause(clause_id, data)
    if not updated:
        raise HTTPException(status_code=404, detail="Clause not found")
    return updated


@router.delete("/clause-library/{clause_id}")
def clause_library_delete(clause_id: str):
    if not delete_clause(clause_id):
        raise HTTPException(status_code=404, detail="Clause not found")
    return {"ok": True}


# ─── WORKFLOWS ────────────────────────────────────────

@router.get("/workflows")
def workflows_list(
    contract_id: Optional[str] = Query(None),
    status: Optional[str] = Query(None),
):
    return {"workflows": list_workflows(contract_id=contract_id, status=status)}


@router.post("/workflows")
def workflows_create(data: dict):
    if not data.get("name"):
        raise HTTPException(status_code=400, detail="name is required")
    return create_workflow(data)


@router.get("/workflows/{workflow_id}")
def workflows_get(workflow_id: str):
    wf = get_workflow(workflow_id)
    if not wf:
        raise HTTPException(status_code=404, detail="Workflow not found")
    return wf


@router.patch("/workflows/{workflow_id}/steps/{step_id}")
def workflows_update_step(workflow_id: str, step_id: str, data: dict):
    updated = update_workflow_step(step_id, data)
    if not updated:
        raise HTTPException(status_code=404, detail="Step not found")
    return updated


# ─── DOC TEMPLATES & GENERATION ───────────────────────

@router.get("/templates")
def templates_list():
    return {"templates": list_doc_templates()}


@router.get("/templates/{template_id}")
def templates_get(template_id: str):
    t = get_doc_template(template_id)
    if not t:
        raise HTTPException(status_code=404, detail="Template not found")
    return t


@router.post("/templates")
def templates_create(data: dict):
    if not data.get("name") or not data.get("template_body"):
        raise HTTPException(status_code=400, detail="name and template_body are required")
    return create_doc_template(data)


@router.post("/templates/{template_id}/generate")
def templates_generate(template_id: str, data: dict):
    tpl = get_doc_template(template_id)
    if not tpl:
        raise HTTPException(status_code=404, detail="Template not found")

    instructions = data.get("instructions", "")
    variables = data.get("variables", {})

    body = tpl["template_body"]
    for k, v in variables.items():
        body = body.replace("{{" + k + "}}", str(v))

    if instructions.strip():
        from app.services.model_gateway import gateway
        prompt = (
            "You are a legal document drafting assistant. Given the following contract template "
            "with some variables already filled in, and the user's natural language instructions, "
            "produce a complete, professional contract document. Fill in any remaining placeholders "
            "with appropriate content based on the instructions. Do not include any explanation, "
            "just output the final document text.\n\n"
            f"TEMPLATE:\n{body}\n\n"
            f"USER INSTRUCTIONS:\n{instructions}\n\n"
            "OUTPUT THE COMPLETE DOCUMENT:"
        )
        resp = gateway.generate(prompt)
        generated = resp.get("content", body)
    else:
        generated = body

    title = data.get("title", f"{tpl['name']} - Generated")
    doc = create_generated_doc({
        "template_id": template_id,
        "title": title,
        "instructions": instructions,
        "variables_filled": variables,
        "generated_text": generated,
        "status": "complete",
    })
    return doc


@router.get("/generated-docs")
def generated_docs_list():
    return {"docs": list_generated_docs()}


# ─── PLAYBOOK COMPARE ────────────────────────────────

@router.post("/contracts/{contract_id}/playbook-compare")
def playbook_compare(contract_id: str, data: dict):
    clause_key = data.get("clause_key", "")
    vendor_text = data.get("vendor_text", "")

    library_clause = get_clause(clause_key)
    playbook_text = library_clause["standard_language"] if library_clause else ""

    if not vendor_text or not playbook_text:
        return {"vendor_clause": vendor_text, "playbook_clause": playbook_text, "deviations": [], "summary": "Insufficient data for comparison."}

    from app.services.model_gateway import gateway
    prompt = (
        "Compare the following two contract clauses. The first is from the vendor's contract, "
        "the second is the approved standard language from our playbook.\n\n"
        f"VENDOR CLAUSE:\n{vendor_text}\n\n"
        f"PLAYBOOK CLAUSE:\n{playbook_text}\n\n"
        "Provide a JSON response with:\n"
        '{"deviations": [{"type": "expanded|missing|changed", "description": "..."}], '
        '"risk_level": "low|medium|high", "summary": "one-paragraph summary"}\n'
        "Return ONLY the JSON."
    )
    resp = gateway.generate(prompt)
    content = resp.get("content", "")

    import json as _json
    try:
        parsed = _json.loads(content)
    except Exception:
        parsed = {"deviations": [], "summary": content[:500], "risk_level": "medium"}

    return {
        "vendor_clause": vendor_text,
        "playbook_clause": playbook_text,
        "deviations": parsed.get("deviations", []),
        "risk_level": parsed.get("risk_level", "medium"),
        "summary": parsed.get("summary", ""),
    }
