from __future__ import annotations

import uuid
from typing import Optional

from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from app.core.db import get_conn
from app.models.schemas import AnalyzeResponse, ContractChunk, ContractRecord, RunMode, RunTrace


def upsert_contract(
    record: ContractRecord,
    embeddings: list | None = None,
    metadata: dict | None = None,
) -> None:
    meta = metadata or {}
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO contracts(contract_id, filename, created_at,
                    contract_type, counterparty, agreement_date, status, risk_level)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (contract_id)
                DO UPDATE SET filename = EXCLUDED.filename,
                    contract_type = COALESCE(EXCLUDED.contract_type, contracts.contract_type),
                    counterparty = COALESCE(EXCLUDED.counterparty, contracts.counterparty),
                    agreement_date = COALESCE(EXCLUDED.agreement_date, contracts.agreement_date),
                    status = COALESCE(EXCLUDED.status, contracts.status),
                    risk_level = COALESCE(EXCLUDED.risk_level, contracts.risk_level)
                """,
                (
                    record.contract_id, record.filename, record.created_at,
                    meta.get("contract_type"), meta.get("counterparty"),
                    meta.get("agreement_date"), meta.get("status", "Under Review"),
                    meta.get("risk_level"),
                ),
            )
            cur.execute("DELETE FROM contract_chunks WHERE contract_id = %s", (record.contract_id,))
            for i, chunk in enumerate(record.chunks):
                embedding = embeddings[i] if embeddings and i < len(embeddings) else None
                if embedding is not None:
                    cur.execute(
                        """
                        INSERT INTO contract_chunks(contract_id, chunk_id, text, section, page, embedding)
                        VALUES (%s, %s, %s, %s, %s, %s::vector)
                        """,
                        (record.contract_id, chunk.chunk_id, chunk.text, chunk.section, chunk.page, str(embedding)),
                    )
                else:
                    cur.execute(
                        """
                        INSERT INTO contract_chunks(contract_id, chunk_id, text, section, page)
                        VALUES (%s, %s, %s, %s, %s)
                        """,
                        (record.contract_id, chunk.chunk_id, chunk.text, chunk.section, chunk.page),
                    )


def get_contract(contract_id: str) -> Optional[ContractRecord]:
    with get_conn() as conn:
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute("SELECT contract_id, filename, created_at FROM contracts WHERE contract_id = %s", (contract_id,))
            row = cur.fetchone()
            if not row:
                return None

            cur.execute(
                """
                SELECT chunk_id, text, section, page
                FROM contract_chunks
                WHERE contract_id = %s
                ORDER BY chunk_id
                """,
                (contract_id,),
            )
            chunk_rows = cur.fetchall()

    chunks = [
        ContractChunk(
            chunk_id=c["chunk_id"],
            text=c["text"],
            section=c["section"],
            page=c["page"],
        )
        for c in chunk_rows
    ]
    return ContractRecord(
        contract_id=row["contract_id"],
        filename=row["filename"],
        created_at=row["created_at"],
        chunks=chunks,
    )


def vector_search(contract_id: str, query_embedding: list[float], top_k: int = 8) -> list[ContractChunk]:
    """Find the most similar chunks using cosine distance on embeddings."""
    with get_conn() as conn:
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute(
                """
                SELECT chunk_id, text, section, page
                FROM contract_chunks
                WHERE contract_id = %s AND embedding IS NOT NULL
                ORDER BY embedding <=> %s::vector
                LIMIT %s
                """,
                (contract_id, str(query_embedding), top_k),
            )
            rows = cur.fetchall()
    return [ContractChunk(**row) for row in rows]


def save_run(response: AnalyzeResponse, trace_events: list[dict]) -> None:
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO runs(
                    run_id, contract_id, mode, summary, answer, answer_citations,
                    risks, requires_approval, approved, trace
                )
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (run_id) DO UPDATE SET
                    summary = EXCLUDED.summary,
                    answer = EXCLUDED.answer,
                    answer_citations = EXCLUDED.answer_citations,
                    risks = EXCLUDED.risks,
                    requires_approval = EXCLUDED.requires_approval,
                    approved = EXCLUDED.approved,
                    trace = EXCLUDED.trace
                """,
                (
                    response.run_id,
                    response.contract_id,
                    response.mode.value,
                    Jsonb(response.summary) if response.summary is not None else None,
                    response.answer,
                    Jsonb([c.model_dump(mode="json") for c in response.answer_citations]),
                    Jsonb([r.model_dump(mode="json") for r in response.risks]),
                    response.requires_approval,
                    not response.requires_approval,
                    Jsonb(trace_events),
                ),
            )


def list_recent_run_ids(contract_id: str, limit: int = 5) -> list[str]:
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT run_id
                FROM runs
                WHERE contract_id = %s
                ORDER BY created_at DESC
                LIMIT %s
                """,
                (contract_id, limit),
            )
            return [row[0] for row in cur.fetchall()]


def set_run_approval(run_id: str, approved: bool) -> bool:
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE runs
                SET approved = %s,
                    requires_approval = %s
                WHERE run_id = %s
                """,
                (approved, not approved, run_id),
            )
            return cur.rowcount > 0


def get_trace(run_id: str) -> Optional[RunTrace]:
    with get_conn() as conn:
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute(
                """
                SELECT run_id, contract_id, mode, trace
                FROM runs
                WHERE run_id = %s
                """,
                (run_id,),
            )
            row = cur.fetchone()
            if not row:
                return None

    return RunTrace(
        run_id=row["run_id"],
        contract_id=row["contract_id"],
        mode=RunMode(row["mode"]),
        events=row["trace"],
    )


def list_contracts(
    limit: int = 50,
    contract_type: str | None = None,
    counterparty: str | None = None,
    status: str | None = None,
    risk_level: str | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
    search: str | None = None,
) -> list[dict]:
    filters = []
    params: list = []

    if contract_type:
        filters.append("c.contract_type = %s")
        params.append(contract_type)
    if counterparty:
        filters.append("c.counterparty ILIKE %s")
        params.append(f"%{counterparty}%")
    if status:
        filters.append("c.status = %s")
        params.append(status)
    if risk_level:
        filters.append("c.risk_level = %s")
        params.append(risk_level)
    if date_from:
        filters.append("c.agreement_date >= %s")
        params.append(date_from)
    if date_to:
        filters.append("c.agreement_date <= %s")
        params.append(date_to)
    if search:
        filters.append("(c.filename ILIKE %s OR c.counterparty ILIKE %s)")
        params.extend([f"%{search}%", f"%{search}%"])

    where = ("WHERE " + " AND ".join(filters)) if filters else ""
    params.append(limit)

    with get_conn() as conn:
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute(
                f"""
                SELECT c.contract_id, c.filename, c.created_at,
                       c.contract_type, c.counterparty, c.agreement_date,
                       c.status, c.risk_level,
                       COUNT(ch.chunk_id) AS chunk_count
                FROM contracts c
                LEFT JOIN contract_chunks ch ON ch.contract_id = c.contract_id
                {where}
                GROUP BY c.contract_id, c.filename, c.created_at,
                         c.contract_type, c.counterparty, c.agreement_date,
                         c.status, c.risk_level
                ORDER BY c.created_at DESC
                LIMIT %s
                """,
                params,
            )
            rows = cur.fetchall()
    return [dict(row) for row in rows]


def update_contract_metadata(contract_id: str, metadata: dict) -> bool:
    sets = []
    params: list = []
    for key in ("contract_type", "counterparty", "agreement_date", "status", "risk_level"):
        if key in metadata and metadata[key] is not None:
            sets.append(f"{key} = %s")
            params.append(metadata[key])
    if not sets:
        return False
    params.append(contract_id)
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(f"UPDATE contracts SET {', '.join(sets)} WHERE contract_id = %s", params)
            return cur.rowcount > 0


def get_run_summary(run_id: str) -> Optional[dict]:
    with get_conn() as conn:
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute(
                """
                SELECT run_id, contract_id, mode, summary, answer, answer_citations, risks,
                       requires_approval, approved, created_at
                FROM runs
                WHERE run_id = %s
                """,
                (run_id,),
            )
            row = cur.fetchone()
    return dict(row) if row else None


def list_runs(contract_id: str, limit: int = 20) -> list[dict]:
    with get_conn() as conn:
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute(
                """
                SELECT run_id, contract_id, mode, requires_approval, approved, created_at
                FROM runs
                WHERE contract_id = %s
                ORDER BY created_at DESC
                LIMIT %s
                """,
                (contract_id, limit),
            )
            rows = cur.fetchall()
    return [dict(row) for row in rows]


def add_comment(contract_id: str, text: str, chunk_id: str | None = None, author: str = "User") -> dict:
    comment_id = f"cmt_{uuid.uuid4().hex[:10]}"
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO contract_comments(comment_id, contract_id, chunk_id, text, author) VALUES (%s,%s,%s,%s,%s)",
                (comment_id, contract_id, chunk_id, text, author),
            )
    log_activity(contract_id, "comment_added", f"Comment by {author}: {text[:100]}", actor=author)
    return {"comment_id": comment_id, "contract_id": contract_id, "chunk_id": chunk_id, "text": text, "author": author}


def list_comments(contract_id: str) -> list[dict]:
    with get_conn() as conn:
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute(
                "SELECT comment_id, contract_id, chunk_id, text, author, created_at FROM contract_comments WHERE contract_id = %s ORDER BY created_at DESC",
                (contract_id,),
            )
            return [dict(r) for r in cur.fetchall()]


def log_activity(contract_id: str, action: str, details: str | None = None, actor: str = "System") -> None:
    activity_id = f"act_{uuid.uuid4().hex[:10]}"
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO contract_activity(activity_id, contract_id, action, details, actor) VALUES (%s,%s,%s,%s,%s)",
                (activity_id, contract_id, action, details, actor),
            )


def list_activity(contract_id: str, limit: int = 50) -> list[dict]:
    with get_conn() as conn:
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute(
                "SELECT activity_id, contract_id, action, details, actor, created_at FROM contract_activity WHERE contract_id = %s ORDER BY created_at DESC LIMIT %s",
                (contract_id, limit),
            )
            return [dict(r) for r in cur.fetchall()]


def list_prompt_templates(category: str | None = None) -> list[dict]:
    with get_conn() as conn:
        with conn.cursor(row_factory=dict_row) as cur:
            if category:
                cur.execute(
                    "SELECT prompt_id, name, description, prompt_text, category, author, created_at FROM prompt_templates WHERE category = %s ORDER BY name",
                    (category,),
                )
            else:
                cur.execute(
                    "SELECT prompt_id, name, description, prompt_text, category, author, created_at FROM prompt_templates ORDER BY category, name"
                )
            return [dict(r) for r in cur.fetchall()]


def get_prompt_template(prompt_id: str) -> dict | None:
    with get_conn() as conn:
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute(
                "SELECT prompt_id, name, description, prompt_text, category, author, created_at FROM prompt_templates WHERE prompt_id = %s",
                (prompt_id,),
            )
            row = cur.fetchone()
            return dict(row) if row else None


def create_prompt_template(name: str, description: str, prompt_text: str, category: str = "Custom", author: str = "User") -> dict:
    prompt_id = f"pt_{uuid.uuid4().hex[:10]}"
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO prompt_templates(prompt_id, name, description, prompt_text, category, author) VALUES (%s,%s,%s,%s,%s,%s)",
                (prompt_id, name, description, prompt_text, category, author),
            )
    return {"prompt_id": prompt_id, "name": name, "description": description, "prompt_text": prompt_text, "category": category, "author": author}


def delete_prompt_template(prompt_id: str) -> bool:
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM prompt_templates WHERE prompt_id = %s AND author != 'Sentinel'", (prompt_id,))
            return cur.rowcount > 0


def create_review_session(contract_id: str, prompt_id: str | None = None, custom_prompt: str | None = None) -> str:
    session_id = f"rs_{uuid.uuid4().hex[:10]}"
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO review_sessions(session_id, contract_id, prompt_id, custom_prompt, status) VALUES (%s,%s,%s,%s,'pending')",
                (session_id, contract_id, prompt_id, custom_prompt),
            )
    return session_id


def update_review_session(session_id: str, status: str, result: dict | None = None) -> None:
    with get_conn() as conn:
        with conn.cursor() as cur:
            if result is not None:
                cur.execute(
                    "UPDATE review_sessions SET status = %s, result = %s, completed_at = NOW() WHERE session_id = %s",
                    (status, Jsonb(result), session_id),
                )
            else:
                cur.execute(
                    "UPDATE review_sessions SET status = %s WHERE session_id = %s",
                    (status, session_id),
                )


def list_review_sessions(contract_id: str | None = None, limit: int = 30) -> list[dict]:
    with get_conn() as conn:
        with conn.cursor(row_factory=dict_row) as cur:
            if contract_id:
                cur.execute(
                    """SELECT rs.session_id, rs.contract_id, rs.prompt_id, rs.custom_prompt, rs.status,
                              rs.result, rs.created_at, rs.completed_at,
                              c.filename, pt.name AS prompt_name
                       FROM review_sessions rs
                       LEFT JOIN contracts c ON c.contract_id = rs.contract_id
                       LEFT JOIN prompt_templates pt ON pt.prompt_id = rs.prompt_id
                       WHERE rs.contract_id = %s ORDER BY rs.created_at DESC LIMIT %s""",
                    (contract_id, limit),
                )
            else:
                cur.execute(
                    """SELECT rs.session_id, rs.contract_id, rs.prompt_id, rs.custom_prompt, rs.status,
                              rs.result, rs.created_at, rs.completed_at,
                              c.filename, pt.name AS prompt_name
                       FROM review_sessions rs
                       LEFT JOIN contracts c ON c.contract_id = rs.contract_id
                       LEFT JOIN prompt_templates pt ON pt.prompt_id = rs.prompt_id
                       ORDER BY rs.created_at DESC LIMIT %s""",
                    (limit,),
                )
            return [dict(r) for r in cur.fetchall()]


def get_review_session(session_id: str) -> dict | None:
    with get_conn() as conn:
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute(
                """SELECT rs.session_id, rs.contract_id, rs.prompt_id, rs.custom_prompt, rs.status,
                          rs.result, rs.created_at, rs.completed_at,
                          c.filename, pt.name AS prompt_name, pt.prompt_text
                   FROM review_sessions rs
                   LEFT JOIN contracts c ON c.contract_id = rs.contract_id
                   LEFT JOIN prompt_templates pt ON pt.prompt_id = rs.prompt_id
                   WHERE rs.session_id = %s""",
                (session_id,),
            )
            row = cur.fetchone()
            return dict(row) if row else None


def get_dashboard_insights() -> dict:
    """Aggregate analytics across all contracts for the Insights dashboard."""
    with get_conn() as conn:
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute("SELECT COUNT(*) AS total FROM contracts")
            total = cur.fetchone()["total"]  # type: ignore[index]

            cur.execute(
                "SELECT contract_type, COUNT(*) AS count FROM contracts WHERE contract_type IS NOT NULL GROUP BY contract_type ORDER BY count DESC"
            )
            type_dist = [dict(r) for r in cur.fetchall()]

            cur.execute(
                "SELECT status, COUNT(*) AS count FROM contracts WHERE status IS NOT NULL GROUP BY status ORDER BY count DESC"
            )
            status_dist = [dict(r) for r in cur.fetchall()]

            cur.execute(
                "SELECT risk_level, COUNT(*) AS count FROM contracts WHERE risk_level IS NOT NULL GROUP BY risk_level ORDER BY count DESC"
            )
            risk_dist = [dict(r) for r in cur.fetchall()]

            cur.execute(
                "SELECT counterparty, COUNT(*) AS count FROM contracts WHERE counterparty IS NOT NULL GROUP BY counterparty ORDER BY count DESC LIMIT 10"
            )
            counterparty_dist = [dict(r) for r in cur.fetchall()]

            cur.execute(
                "SELECT TO_CHAR(created_at, 'YYYY-MM') AS month, COUNT(*) AS count FROM contracts GROUP BY month ORDER BY month"
            )
            timeline = [dict(r) for r in cur.fetchall()]

            cur.execute(
                "SELECT r.mode, COUNT(*) AS count FROM runs r GROUP BY r.mode"
            )
            analysis_modes = [dict(r) for r in cur.fetchall()]

            cur.execute(
                """SELECT c.contract_id, c.filename, c.contract_type, c.counterparty,
                          c.status, c.risk_level, c.agreement_date, c.created_at
                   FROM contracts c ORDER BY c.created_at DESC LIMIT 5"""
            )
            recent = [dict(r) for r in cur.fetchall()]

            cur.execute(
                """SELECT a.action, COUNT(*) AS count
                   FROM contract_activity a GROUP BY a.action ORDER BY count DESC"""
            )
            activity_summary = [dict(r) for r in cur.fetchall()]

    # Aggregate clause gaps using fast keyword classifier (no LLM calls)
    CLAUSE_KEYS = [
        "term_and_renewal", "termination", "liability_and_indemnity", "payment",
        "governing_law",
    ]
    CLAUSE_NAMES = {
        "term_and_renewal": "Term & Renewal", "termination": "Termination",
        "liability_and_indemnity": "Liability", "payment": "Payment Terms",
        "governing_law": "Governing Law",
    }
    missing_counts: dict[str, int] = {k: 0 for k in CLAUSE_KEYS}

    with get_conn() as conn2:
        with conn2.cursor(row_factory=dict_row) as cur2:
            cur2.execute("SELECT contract_id FROM contracts")
            all_ids = [r["contract_id"] for r in cur2.fetchall()]

            for cid in all_ids:
                cur2.execute(
                    "SELECT chunk_id, section, text FROM contract_chunks WHERE contract_id = %s", (cid,)
                )
                chunk_rows = [dict(r) for r in cur2.fetchall()]
                if not chunk_rows:
                    for key in CLAUSE_KEYS:
                        missing_counts[key] += 1
                    continue

                from app.services.insights import _classify_chunks_keyword
                hl = _classify_chunks_keyword(chunk_rows)
                for key in CLAUSE_KEYS:
                    if not hl.get(key):
                        missing_counts[key] += 1

    missing_terms = [
        {"clause": CLAUSE_NAMES.get(k, k), "missing_count": v}
        for k, v in missing_counts.items() if v > 0
    ]
    missing_terms.sort(key=lambda x: x["missing_count"], reverse=True)

    return {
        "total_contracts": total,
        "type_distribution": type_dist,
        "status_distribution": status_dist,
        "risk_distribution": risk_dist,
        "counterparty_distribution": counterparty_dist,
        "contracts_over_time": timeline,
        "analysis_modes": analysis_modes,
        "recent_contracts": recent,
        "activity_summary": activity_summary,
        "missing_terms": missing_terms,
    }


# ─── Autopilot Agent Tasks ────────────────────────

def create_agent_task(
    title: str,
    description: str,
    task_type: str = "custom",
    scope: str = "all",
    contract_id: str | None = None,
) -> str:
    task_id = f"tsk_{uuid.uuid4().hex[:10]}"
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """INSERT INTO agent_tasks(task_id, title, description, task_type, scope, contract_id, status)
                   VALUES (%s, %s, %s, %s, %s, %s, 'queued')""",
                (task_id, title, description, task_type, scope, contract_id),
            )
    return task_id


def update_agent_task(
    task_id: str,
    status: str | None = None,
    progress: int | None = None,
    step: dict | None = None,
    result: dict | None = None,
) -> None:
    with get_conn() as conn:
        with conn.cursor() as cur:
            if status:
                extras = ""
                params: list = [status]
                if status == "running":
                    extras = ", started_at = NOW()"
                elif status in ("completed", "failed"):
                    extras = ", completed_at = NOW()"
                params.append(task_id)
                cur.execute(f"UPDATE agent_tasks SET status = %s{extras} WHERE task_id = %s", params)
            if progress is not None:
                cur.execute("UPDATE agent_tasks SET progress = %s WHERE task_id = %s", (progress, task_id))
            if step:
                cur.execute(
                    "UPDATE agent_tasks SET steps = steps || %s::jsonb WHERE task_id = %s",
                    (Jsonb([step]), task_id),
                )
            if result is not None:
                cur.execute(
                    "UPDATE agent_tasks SET result = %s WHERE task_id = %s",
                    (Jsonb(result), task_id),
                )


def list_agent_tasks(status: str | None = None, limit: int = 30) -> list[dict]:
    with get_conn() as conn:
        with conn.cursor(row_factory=dict_row) as cur:
            if status:
                cur.execute(
                    """SELECT t.task_id, t.title, t.description, t.task_type, t.scope,
                              t.contract_id, t.status, t.progress, t.steps, t.result,
                              t.created_at, t.started_at, t.completed_at,
                              c.filename
                       FROM agent_tasks t
                       LEFT JOIN contracts c ON c.contract_id = t.contract_id
                       WHERE t.status = %s ORDER BY t.created_at DESC LIMIT %s""",
                    (status, limit),
                )
            else:
                cur.execute(
                    """SELECT t.task_id, t.title, t.description, t.task_type, t.scope,
                              t.contract_id, t.status, t.progress, t.steps, t.result,
                              t.created_at, t.started_at, t.completed_at,
                              c.filename
                       FROM agent_tasks t
                       LEFT JOIN contracts c ON c.contract_id = t.contract_id
                       ORDER BY t.created_at DESC LIMIT %s""",
                    (limit,),
                )
            return [dict(r) for r in cur.fetchall()]


def get_agent_task(task_id: str) -> dict | None:
    with get_conn() as conn:
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute(
                """SELECT t.task_id, t.title, t.description, t.task_type, t.scope,
                          t.contract_id, t.status, t.progress, t.steps, t.result,
                          t.created_at, t.started_at, t.completed_at,
                          c.filename
                   FROM agent_tasks t
                   LEFT JOIN contracts c ON c.contract_id = t.contract_id
                   WHERE t.task_id = %s""",
                (task_id,),
            )
            row = cur.fetchone()
            return dict(row) if row else None


# ── Clause Risk Assessments ───────────────────────────

def save_clause_assessments(contract_id: str, assessments: list[dict]) -> None:
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM clause_risk_assessments WHERE contract_id = %s", (contract_id,))
            for a in assessments:
                aid = f"cra_{uuid.uuid4().hex[:12]}"
                cur.execute(
                    """INSERT INTO clause_risk_assessments
                       (assessment_id, contract_id, chunk_id, clause_type, risk_level,
                        risk_score, reason, standard_clause, deviation, recommendation, citations)
                       VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
                    (aid, contract_id, a.get("chunk_id", ""),
                     a["clause_type"], a.get("risk_level", "low"),
                     a.get("risk_score", 0), a.get("reason", ""),
                     a.get("standard_clause"), a.get("deviation"),
                     a.get("recommendation"),
                     Jsonb(a.get("citations", []))),
                )


def list_clause_assessments(contract_id: str) -> list[dict]:
    with get_conn() as conn:
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute(
                """SELECT assessment_id, contract_id, chunk_id, clause_type,
                          risk_level, risk_score, reason, standard_clause,
                          deviation, recommendation, citations, created_at
                   FROM clause_risk_assessments
                   WHERE contract_id = %s
                   ORDER BY risk_score DESC, clause_type""",
                (contract_id,),
            )
            return [dict(r) for r in cur.fetchall()]


# ── Clause Library ────────────────────────────────────

def list_clause_library(category: Optional[str] = None) -> list[dict]:
    with get_conn() as conn:
        with conn.cursor(row_factory=dict_row) as cur:
            if category:
                cur.execute("SELECT * FROM clause_library WHERE category = %s ORDER BY name", (category,))
            else:
                cur.execute("SELECT * FROM clause_library ORDER BY category, name")
            return [dict(r) for r in cur.fetchall()]


def get_clause(clause_id: str) -> dict | None:
    with get_conn() as conn:
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute("SELECT * FROM clause_library WHERE clause_id = %s", (clause_id,))
            row = cur.fetchone()
            return dict(row) if row else None


def create_clause(data: dict) -> dict:
    cid = f"cl_{uuid.uuid4().hex[:12]}"
    with get_conn() as conn:
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute(
                """INSERT INTO clause_library (clause_id, name, category, description, standard_language, risk_notes, required)
                   VALUES (%s, %s, %s, %s, %s, %s, %s) RETURNING *""",
                (cid, data["name"], data.get("category", "General"), data["description"],
                 data.get("standard_language"), data.get("risk_notes"), data.get("required", False)),
            )
            return dict(cur.fetchone())  # type: ignore[arg-type]


def update_clause(clause_id: str, data: dict) -> dict | None:
    with get_conn() as conn:
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute(
                """UPDATE clause_library SET name = COALESCE(%s, name), category = COALESCE(%s, category),
                   description = COALESCE(%s, description), standard_language = COALESCE(%s, standard_language),
                   risk_notes = COALESCE(%s, risk_notes), required = COALESCE(%s, required),
                   updated_at = NOW()
                   WHERE clause_id = %s RETURNING *""",
                (data.get("name"), data.get("category"), data.get("description"),
                 data.get("standard_language"), data.get("risk_notes"), data.get("required"), clause_id),
            )
            row = cur.fetchone()
            return dict(row) if row else None


def delete_clause(clause_id: str) -> bool:
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM clause_library WHERE clause_id = %s", (clause_id,))
            return cur.rowcount > 0


# ── Workflows ─────────────────────────────────────────

def create_workflow(data: dict) -> dict:
    wid = f"wf_{uuid.uuid4().hex[:12]}"
    with get_conn() as conn:
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute(
                """INSERT INTO workflows (workflow_id, contract_id, name, status, created_by)
                   VALUES (%s, %s, %s, %s, %s) RETURNING *""",
                (wid, data.get("contract_id"), data["name"], data.get("status", "active"),
                 data.get("created_by", "User")),
            )
            wf = dict(cur.fetchone())  # type: ignore[arg-type]
            for i, step in enumerate(data.get("steps", [])):
                sid = f"ws_{uuid.uuid4().hex[:12]}"
                cur.execute(
                    """INSERT INTO workflow_steps (step_id, workflow_id, title, description, assignee, step_type, status, due_date, step_order)
                       VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)""",
                    (sid, wid, step["title"], step.get("description"), step.get("assignee"),
                     step.get("step_type", "review"), "in_progress" if i == 0 else "pending",
                     step.get("due_date"), i),
                )
            return wf


def list_workflows(contract_id: Optional[str] = None, status: Optional[str] = None) -> list[dict]:
    with get_conn() as conn:
        with conn.cursor(row_factory=dict_row) as cur:
            q = """SELECT w.*, c.filename, (SELECT COUNT(*) FROM workflow_steps s WHERE s.workflow_id = w.workflow_id) AS total_steps,
                   (SELECT COUNT(*) FROM workflow_steps s WHERE s.workflow_id = w.workflow_id AND s.status = 'completed') AS completed_steps
                   FROM workflows w LEFT JOIN contracts c ON c.contract_id = w.contract_id WHERE 1=1"""
            params: list = []
            if contract_id:
                q += " AND w.contract_id = %s"
                params.append(contract_id)
            if status:
                q += " AND w.status = %s"
                params.append(status)
            q += " ORDER BY w.created_at DESC"
            cur.execute(q, params)
            return [dict(r) for r in cur.fetchall()]


def get_workflow(workflow_id: str) -> dict | None:
    with get_conn() as conn:
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute(
                """SELECT w.*, c.filename FROM workflows w
                   LEFT JOIN contracts c ON c.contract_id = w.contract_id
                   WHERE w.workflow_id = %s""",
                (workflow_id,),
            )
            wf = cur.fetchone()
            if not wf:
                return None
            wf = dict(wf)
            cur.execute(
                "SELECT * FROM workflow_steps WHERE workflow_id = %s ORDER BY step_order",
                (workflow_id,),
            )
            wf["steps"] = [dict(r) for r in cur.fetchall()]
            return wf


def update_workflow_step(step_id: str, data: dict) -> dict | None:
    with get_conn() as conn:
        with conn.cursor(row_factory=dict_row) as cur:
            sets = []
            params: list = []
            for key in ("status", "assignee", "due_date"):
                if key in data:
                    sets.append(f"{key} = %s")
                    params.append(data[key])
            if data.get("status") == "completed":
                sets.append("completed_at = NOW()")
            if not sets:
                return None
            params.append(step_id)
            cur.execute(f"UPDATE workflow_steps SET {', '.join(sets)} WHERE step_id = %s RETURNING *", params)
            row = cur.fetchone()
            if row:
                row = dict(row)
                wfid = row["workflow_id"]
                cur.execute("SELECT COUNT(*) FROM workflow_steps WHERE workflow_id = %s AND status != 'completed'", (wfid,))
                remaining = cur.fetchone()[0]  # type: ignore[index]
                if remaining == 0:
                    cur.execute("UPDATE workflows SET status = 'completed' WHERE workflow_id = %s", (wfid,))
                # Auto-advance next step
                if data.get("status") == "completed":
                    cur.execute(
                        """UPDATE workflow_steps SET status = 'in_progress'
                           WHERE workflow_id = %s AND status = 'pending'
                           AND step_order = (SELECT MIN(step_order) FROM workflow_steps WHERE workflow_id = %s AND status = 'pending')""",
                        (wfid, wfid),
                    )
            return row


# ── Doc Templates & Generation ────────────────────────

def list_doc_templates() -> list[dict]:
    with get_conn() as conn:
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute("SELECT * FROM doc_templates ORDER BY name")
            return [dict(r) for r in cur.fetchall()]


def get_doc_template(template_id: str) -> dict | None:
    with get_conn() as conn:
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute("SELECT * FROM doc_templates WHERE template_id = %s", (template_id,))
            row = cur.fetchone()
            return dict(row) if row else None


def create_doc_template(data: dict) -> dict:
    tid = f"tpl_{uuid.uuid4().hex[:12]}"
    with get_conn() as conn:
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute(
                """INSERT INTO doc_templates (template_id, name, description, doc_type, template_body, variables)
                   VALUES (%s, %s, %s, %s, %s, %s::jsonb) RETURNING *""",
                (tid, data["name"], data.get("description"), data.get("doc_type", "MSA"),
                 data["template_body"], Jsonb(data.get("variables", []))),
            )
            return dict(cur.fetchone())  # type: ignore[arg-type]


def create_generated_doc(data: dict) -> dict:
    did = f"gd_{uuid.uuid4().hex[:12]}"
    with get_conn() as conn:
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute(
                """INSERT INTO generated_docs (doc_id, template_id, title, instructions, variables_filled, generated_text, status)
                   VALUES (%s, %s, %s, %s, %s, %s, %s) RETURNING *""",
                (did, data.get("template_id"), data["title"], data.get("instructions"),
                 Jsonb(data.get("variables_filled", {})), data.get("generated_text"), data.get("status", "complete")),
            )
            return dict(cur.fetchone())  # type: ignore[arg-type]


def list_generated_docs(limit: int = 50) -> list[dict]:
    with get_conn() as conn:
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute(
                """SELECT g.*, t.name AS template_name FROM generated_docs g
                   LEFT JOIN doc_templates t ON t.template_id = g.template_id
                   ORDER BY g.created_at DESC LIMIT %s""",
                (limit,),
            )
            return [dict(r) for r in cur.fetchall()]


# ─── Contract Deletion ────────────────────────────────


# ─── Contract Reviews ─────────────────────────────────


def get_review_decision(contract_id: str) -> dict | None:
    with get_conn() as conn:
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute(
                "SELECT * FROM contract_reviews WHERE contract_id = %s",
                (contract_id,),
            )
            row = cur.fetchone()
            return dict(row) if row else None


def save_review_decision(
    contract_id: str,
    decision: str,
    reviewer_notes: str | None = None,
    ai_summary: str | None = None,
    overall_score: int | None = None,
    decided_by: str = "analyst",
) -> dict:
    review_id = f"rev_{uuid.uuid4().hex[:12]}"
    with get_conn() as conn:
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute(
                """INSERT INTO contract_reviews
                   (review_id, contract_id, decision, reviewer_notes, ai_summary,
                    overall_score, decided_by, decided_at, updated_at)
                   VALUES (%s, %s, %s, %s, %s, %s, %s, NOW(), NOW())
                   ON CONFLICT (contract_id) DO UPDATE SET
                    decision = EXCLUDED.decision,
                    reviewer_notes = COALESCE(EXCLUDED.reviewer_notes, contract_reviews.reviewer_notes),
                    ai_summary = COALESCE(EXCLUDED.ai_summary, contract_reviews.ai_summary),
                    overall_score = COALESCE(EXCLUDED.overall_score, contract_reviews.overall_score),
                    decided_by = EXCLUDED.decided_by,
                    decided_at = NOW(),
                    updated_at = NOW()
                   RETURNING *""",
                (review_id, contract_id, decision, reviewer_notes, ai_summary,
                 overall_score, decided_by),
            )
            return dict(cur.fetchone())


def save_review_summary(contract_id: str, ai_summary: str, overall_score: int) -> dict:
    review_id = f"rev_{uuid.uuid4().hex[:12]}"
    with get_conn() as conn:
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute(
                """INSERT INTO contract_reviews
                   (review_id, contract_id, decision, ai_summary, overall_score, updated_at)
                   VALUES (%s, %s, 'pending', %s, %s, NOW())
                   ON CONFLICT (contract_id) DO UPDATE SET
                    ai_summary = EXCLUDED.ai_summary,
                    overall_score = EXCLUDED.overall_score,
                    updated_at = NOW()
                   RETURNING *""",
                (review_id, contract_id, ai_summary, overall_score),
            )
            return dict(cur.fetchone())


# ─── Contract Deletion ────────────────────────────────


def delete_contract(contract_id: str) -> bool:
    """Delete a contract and all related data (CASCADE handles child tables)."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM contracts WHERE contract_id = %s", (contract_id,))
            return cur.rowcount > 0


def delete_all_contracts() -> int:
    """Delete all contracts and related data. Returns count of deleted contracts."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT COUNT(*) FROM contracts")
            count = cur.fetchone()[0]
            cur.execute("TRUNCATE contracts CASCADE")
            return count
