# Contract Intelligence Platform - Technical Design (Current State + Next Decisions)

## 1. Purpose

This document captures:

1. What has been implemented so far.
2. Architectural decisions made.
3. Explicit assumptions and non-goals.
4. Open questions and decisions needed before hardening for production.
5. Recommended next implementation steps.

Scope is aligned to the case-study goals:

- Clause summarization
- Natural-language Q&A
- Risk/expiry/non-compliance flagging
- Agentic orchestration with traceability and citations

## 2. Current Repository Structure

- `backend/` - FastAPI API service + LangGraph orchestration
- `frontend/` - Next.js web app (review mode / agent mode)
- `docker-compose.yml` - local multi-service stack (frontend, backend, postgres)
- `docs/` - project documentation

## 3. Implemented So Far

### 3.1 Backend (FastAPI + LangGraph)

Implemented APIs:

1. `POST /api/v1/contracts/ingest`
2. `POST /api/v1/contracts/{contract_id}/analyze`
3. `POST /api/v1/contracts/{contract_id}/ask`
4. `GET /api/v1/contracts/{contract_id}/risks`
5. `POST /api/v1/runs/{run_id}/approve`
6. `GET /api/v1/runs/{run_id}/trace`

Implemented orchestration flow:

1. `initialize`
2. `summarize` (optional by task selection)
3. `qa` (optional)
4. `risk` (optional)
5. `review_gate` (requires approval when mode=`review`)

Implemented model routing:

- Primary model via OpenRouter (`PRIMARY_MODEL`)
- Fallback model via OpenRouter (`FALLBACK_MODEL`)
- Automatic fallback on primary failure

Implemented traceability:

- Each node appends run events (`step`, timestamp, details)
- Trace available by run id via `/runs/{run_id}/trace`

Implemented schema discipline:

- Typed request/response models in Pydantic
- Structured objects for citations, risks, run trace events

### 3.2 Retrieval + Citation Baseline

Implemented now:

- Basic chunking at ingestion
- Keyword retrieval (`top_k`) from in-memory chunks
- Citation objects attached to Q&A and risk findings

Not implemented yet:

- Embedding generation
- Vector DB retrieval
- Reranking
- Retrieval quality evaluation harness

### 3.3 Frontend (Next.js)

Implemented UI capabilities:

1. Upload contract
2. Capture generated `contract_id`
3. Select mode (`review`/`agent`)
4. Select tasks (`summary`, `qa`, `risk`)
5. Trigger analyze run
6. Approve/reject run for review mode
7. Fetch/display full trace

### 3.4 Infra / Local Deployment

Implemented:

- Backend Dockerfile
- Frontend Dockerfile
- Compose stack with pgvector-ready Postgres container
- Env templates and local run instructions

Note: current persistence is still in-memory in backend service.

## 4. Architecture Decisions Made

### 4.1 Orchestration: LangGraph

Decision:

- Use LangGraph as control plane for orchestrator + specialist nodes.

Reason:

- Fits explicit requirement for agentic workflow and traceable state transitions.
- Supports clean branching for `review` vs `agent` mode.
- Supports model fallback/escalation per node.

### 4.2 API Layer: FastAPI

Decision:

- FastAPI as backend contract/API surface.

Reason:

- Strong typed contracts, async-ready, production ecosystem support.

### 4.3 Model Access: OpenRouter via LiteLLM

Decision:

- Use OpenRouter key and route model calls through LiteLLM.

Reason:

- Multi-model portability and future model routing flexibility.

### 4.4 Data Layer (Current)

Decision:

- In-memory store for bootstrapping speed.

Reason:

- Fast initial implementation to validate end-to-end flow and UI.

Tradeoff:

- Non-persistent; not safe for multi-user/restart scenarios.

## 5. What Is Intentionally Deferred Right Now

Deferred per current instruction (avoid OCR complexity initially):

1. OCR provider integration (Azure/AWS)
2. OCR fallback for scanned pages
3. OCR quality controls and cost optimization

Other deferred items:

1. AuthN/AuthZ and tenant isolation
2. Database persistence layer
3. True vector retrieval
4. Queue/worker for long jobs
5. Observability instrumentation in code paths (LangSmith env is configured, explicit tracing integration pending)

## 6. Assumptions

Current assumptions in implementation:

1. Contracts are currently ingestible as text-like inputs (no OCR dependency for v1 baseline).
2. Single-tenant/local usage for now.
3. One user can manually run upload/analyze from UI without auth.
4. In-memory state loss on restart is acceptable at this phase.
5. Retrieval quality is acceptable for bootstrapping, not for final production accuracy.

Product assumptions pending validation:

1. `review` mode requires explicit approval gate before outcomes are considered final.
2. `agent` mode can proceed autonomously with policy checks.
3. Risk rules can start with deterministic heuristics and later evolve to playbook-driven + model-assisted checks.

## 7. Open Questions (Need Decisions)

### 7.1 Product / Workflow

1. Which contract types are in v1 scope (NDA/MSA/SOW/etc.)?
2. Which risk taxonomy is required for v1 (top 10 must-catch risks)?
3. What are acceptance KPIs for v1 (precision/recall targets, review time reduction)?
4. What should happen in review mode when user rejects a run (retry route, edit route, escalate)?

### 7.2 Model Strategy

1. Final primary/fallback model pair on OpenRouter?
2. Node-level model routing policy (e.g., cheaper model for extraction, stronger model for risk reasoning)?
3. Confidence thresholds that trigger fallback or human handoff?

### 7.3 Data / Persistence

1. Preferred DB schema and migration tool (SQLAlchemy + Alembic?)
2. Persist raw documents in DB vs filesystem/object storage?
3. How long to retain run traces and artifacts?

### 7.4 Security / Compliance

1. Which auth provider (Clerk/Auth0/custom JWT)?
2. Any PII/PHI constraints requiring encryption-at-rest and key management?
3. Audit logging requirements for user actions and model decisions?

### 7.5 Deployment

1. Target first deployment platform (Render/Railway/Fly/ECS/Kubernetes)?
2. Expected concurrency and file volume for initial rollout?
3. SLA expectations and error-budget policy?

## 8. Gaps vs Full Production Readiness

Critical gaps:

1. Replace in-memory store with persistent relational DB.
2. Implement embeddings + pgvector retrieval with metadata filtering.
3. Add authentication, authorization, and session/user scoping.
4. Add async workers and job tracking for ingestion/analysis.
5. Add robust prompt/schema validation and retry policies.
6. Add evaluation suite and regression checks.

High-priority hardening:

1. Idempotency keys for ingest/analyze APIs.
2. Request validation limits (file size/type limits, payload constraints).
3. Structured logs + distributed tracing.
4. Rate limiting and abuse protection.

## 9. Recommended Next Build Plan

### Phase 1 - Persistence + Retrieval Foundation

1. Add Postgres repositories for contracts, chunks, runs, traces.
2. Add embedding generation pipeline and pgvector index.
3. Replace keyword retrieval with vector + hybrid retrieval.
4. Add DB-backed citation objects with stable references.

### Phase 2 - Security + Multi-User

1. Add auth middleware and user identity propagation.
2. Add RBAC and project/workspace scoping.
3. Add tenant-safe query filters for all APIs.

### Phase 3 - Reliability + Scale

1. Move ingestion/analyze to async jobs (Celery/Temporal).
2. Add run status endpoints and UI progress updates.
3. Add retries, backoff, and circuit-breaker on model calls.

### Phase 4 - Quality Controls

1. Add evaluation datasets and automated metrics pipeline.
2. Add citation completeness checks and contradiction checks.
3. Add policy-driven risk rule engine and playbook configs.

## 10. Current Environment Configuration

Currently configured locally:

- `OPENROUTER_API_KEY`
- `LANGSMITH_TRACING`
- `LANGSMITH_ENDPOINT`
- `LANGSMITH_API_KEY`
- `LANGSMITH_PROJECT`

Not required yet for local baseline:

- OCR provider keys (explicitly deferred)
- Cloud storage keys (local only phase)
- Managed DB secrets (until non-local deployment)

## 11. Known Limitations Right Now

1. Ingestion parser is placeholder for non-text formats.
2. Risk detection is heuristic baseline, not full policy engine.
3. Current `/contracts/{id}/risks` endpoint returns latest-run references, not a fully normalized risk repository.
4. No auth and no tenant boundaries.
5. No formal tests yet beyond syntax-level checks.

## 12. Definition of Done for “Production-Ready v1”

A practical v1 exit bar:

1. Persistent storage and recoverability across restarts.
2. Embedding-based retrieval with measurable accuracy.
3. Auth + role-based access and auditability.
4. Stable review-mode and agent-mode workflows with traceability.
5. API and UI reliability at agreed load target.
6. Basic security controls, logging, and on-call observability.

## 13. Scale TODOs

1. TODO: Re-evaluate moving from `pgvector` to a separate vector database (e.g., Pinecone) when scale thresholds are reached.
2. Trigger conditions for migration:
   - Sustained high QPS with retrieval latency SLO misses.
   - Vector corpus growth beyond practical Postgres performance envelope.
   - Multi-tenant workload isolation requirements that exceed current DB strategy.
3. Until those triggers are hit, continue with `Postgres + pgvector` as default.

---

If desired, next document can be a strict **Architecture Decision Record (ADR) set** with one ADR per major decision:

1. Orchestration framework choice
2. Model routing strategy
3. Data persistence design
4. Security and tenancy design
5. Job execution model
