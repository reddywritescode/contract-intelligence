# Contract Intelligence Platform — Panel Presentation

---

## SLIDE 1: About Me

### Kartik Reddy K

**Builder. Privacy advocate.**

| | |
|---|---|
| **Work** | Amazon (4+ yrs) — LLM Eval Platform, 1-Click Deployment Pipelines · Shipt (Target) — ML Engineering |
| **Education** | Master's |
| **Side projects** | [moveinmoveout.app](https://moveinmoveout.app) (selling) · local-brain (privacy-first AI) · claw-man (agent mission control) |
| **What I care about** | Privacy for everyone · Building products, not just models |

---
---

## SLIDE 2: The Product

### Contract Intelligence Platform

**One platform. Every contract. Full visibility.**

---

#### The Idea

An AI-native contract analysis platform built **on top of the PDF**. The document is the workspace. Intelligence is layered directly on the text — not in a separate view, not in a chatbot sidebar.

**Scenario**: A procurement analyst reviews a TSMC-like supplier MSA approaching renewal. The system uploads it, runs multi-agent analysis, and surfaces risks, clause deviations, and key terms — all visible on the PDF itself.

---

#### Features

| # | Feature | One-liner |
|---|---------|-----------|
| 1 | **Upload & Auto-Analysis** | Drop a PDF → parse, chunk, embed, classify, analyze — one click. |
| 2 | **PDF Risk Highlights** | Red/amber/green highlights ON the PDF per clause risk level. |
| 3 | **Clause Intelligence** | Per-clause risk score (0-100), deviation from playbook, recommendation. |
| 4 | **AI Chat + Citations** | Ask anything → cited answer linking to section and page. |
| 5 | **Compliance Gaps** | Which required clauses are missing or deviating from standard? |
| 6 | **Lifecycle Timeline** | Effective date → renewal window → expiration, alert banners. |
| 7 | **Portfolio Dashboard** | Risk distribution, counterparty breakdown, expiring contracts. |
| 8 | **Sentinel AI** | 8 configurable review templates for structured deep-dive. |
| 9 | **Doc Generation** | Natural language → contract draft from templates. |
| 10 | **Debug / Trace** | Full AI pipeline transparency — every step, every model call. |

---

#### Interactive Demo

**Live demo**: `[INSERT YOUR TUNNEL URL HERE]`

**What I'll walk through** (12-15 min):

1. Upload a contract → watch the auto-analysis pipeline
2. Click a clause → PDF scrolls with risk-colored highlights
3. Deep-dive a high-risk clause (Liability, score 78/100)
4. Chat: "What are the payment terms?" → cited answer
5. Compliance gap analysis + playbook comparison
6. Lifecycle timeline + renewal alert
7. Debug mode — what the AI did under the hood

---
---

## SLIDE 3: Under the Hood

### Diagram 1: Product Flow (What the User Experiences)

This maps directly to the product requirements — upload, index, agent analysis, chat, highlights on PDF, risk profiles.

```
  ┌──────────────────────────────────────────────────────────────┐
  │                    USER UPLOADS CONTRACT                      │
  │                     (PDF / DOCX / TXT)                       │
  └──────────────────────────┬───────────────────────────────────┘
                             │
                             ▼
  ┌──────────────────────────────────────────────────────────────┐
  │               UPLOAD & INDEX (automatic)                      │
  │                                                              │
  │   Parse document → Chunk by sections → Generate embeddings   │
  │                     → Classify clauses → Store in vector DB  │
  └──────────────────────────┬───────────────────────────────────┘
                             │
                             ▼
  ┌──────────────────────────────────────────────────────────────┐
  │              AGENTIC ANALYSIS (multi-agent)                   │
  │                                                              │
  │   ┌─────────────┐  ┌─────────────┐  ┌───────────────────┐   │
  │   │  Summary     │  │    Q&A      │  │  Risk & Compliance│   │
  │   │  Agent       │  │   Agent     │  │     Agent         │   │
  │   │             │  │             │  │                   │   │
  │   │ Extract key  │  │ Answer with │  │ Keyword scan      │   │
  │   │ terms into   │  │ source      │  │ + LLM per-clause  │   │
  │   │ structured   │  │ citations   │  │ assessment vs     │   │
  │   │ JSON         │  │             │  │ Clause Library     │   │
  │   └──────┬──────┘  └──────┬──────┘  └────────┬──────────┘   │
  │          │                │                   │              │
  │          └────────────────┼───────────────────┘              │
  │                           │                                  │
  │              Shared State (ContractState)                     │
  │              + Trace log (every agent audited)                │
  └──────────────────────────┬───────────────────────────────────┘
                             │
                             ▼
  ┌──────────────────────────────────────────────────────────────┐
  │              WHAT THE USER SEES                               │
  │                                                              │
  │  ┌──────────────────────────┐  ┌──────────────────────────┐  │
  │  │      PDF VIEWER           │  │    ANALYSIS PANEL        │  │
  │  │                          │  │                          │  │
  │  │  Risk-colored highlights │  │  Clause categories       │  │
  │  │  on actual PDF text      │  │  Risk badges (H/M/L)     │  │
  │  │                          │  │  Per-clause scores 0-100 │  │
  │  │  Red = high risk         │  │  Deviation from playbook │  │
  │  │  Amber = medium          │  │  Recommendations         │  │
  │  │  Green = low             │  │                          │  │
  │  │                          │  │  Compliance gap analysis  │  │
  │  │  Click clause → scrolls  │  │  Missing required clauses│  │
  │  │  Arrow keys to navigate  │  │                          │  │
  │  └──────────────────────────┘  └──────────────────────────┘  │
  │                                                              │
  │  ┌──────────────────────────┐  ┌──────────────────────────┐  │
  │  │    AI CHAT                │  │    LIFECYCLE TIMELINE    │  │
  │  │    (unified, like Google) │  │                          │  │
  │  │                          │  │  Effective → Renewal      │  │
  │  │  Suggested questions     │  │  → Expiration             │  │
  │  │  Cited answers           │  │  Risk profile over time   │  │
  │  │  Source links to PDF     │  │  Alert: "Renew in 45 days"│  │
  │  └──────────────────────────┘  └──────────────────────────┘  │
  └──────────────────────────────────────────────────────────────┘
```

---

### Diagram 2: Technical Deep-Dive (Agentic Communication + Full Stack)

```
  ┌───────────────────────────────────────────────────────────────────┐
  │  FRONTEND  │  Next.js 14 · React SPA · TypeScript                 │
  │            │  PDF Viewer (pdf.js iframe + postMessage)             │
  │            │  Recharts (bar charts, timelines — no pie charts)     │
  └─────┬─────────────────────────────────────────────────────────────┘
        │  REST API calls
        ▼
  ┌───────────────────────────────────────────────────────────────────┐
  │  API LAYER │  FastAPI · 30+ endpoints · Pydantic validation       │
  └─────┬─────────────────────────────────────────────────────────────┘
        │
        ▼
  ┌───────────────────────────────────────────────────────────────────┐
  │  INGESTION │  pdfplumber / python-docx                            │
  │  PIPELINE  │  Section-header chunking (1200 char max)             │
  │            │  Embedding: text-embedding-3-small (1536-dim)        │
  │            │  Clause classifier: 8 categories (regex)             │
  └─────┬─────────────────────────────────────────────────────────────┘
        │
        ▼
  ┌───────────────────────────────────────────────────────────────────┐
  │                                                                   │
  │  LANGGRAPH ORCHESTRATOR (Agentic Communication)                   │
  │                                                                   │
  │  ┌──────────────────────────────────────────────────────────┐     │
  │  │  ContractState (shared blackboard — all agents read/write)│     │
  │  │  ├── chunks[], clause_highlights{}                        │     │
  │  │  ├── summary{}, qa{answer, citations[]}                   │     │
  │  │  ├── risk_flags[], clause_assessments[]                   │     │
  │  │  └── trace[] (append-only audit log)                      │     │
  │  └──────────────────────────────────────────────────────────┘     │
  │       ▲            ▲              ▲              ▲                 │
  │       │            │              │              │                 │
  │  ┌────┴────┐  ┌────┴─────┐  ┌────┴───┐  ┌──────┴──────────┐     │
  │  │Orchestr.│  │Summarize │  │  Q&A   │  │ Risk+Compliance │     │
  │  │ Agent   │  │  Agent   │  │ Agent  │  │     Agent       │     │
  │  │         │  │          │  │        │  │                 │     │
  │  │ LLM     │  │ Top 10   │  │ Hybrid │  │ Layer 1:        │     │
  │  │ intent  │  │ chunks → │  │ search │  │  5 keyword rules│     │
  │  │ classify│  │ strict   │  │ (vec + │  │  (<10ms)        │     │
  │  │ → route │  │ JSON     │  │  kw) → │  │ Layer 2:        │     │
  │  │ to      │  │ extract  │  │ cited  │  │  LLM per-clause │     │
  │  │ agents  │  │          │  │ answer │  │  vs Clause       │     │
  │  │         │  │          │  │        │  │  Library (0-100) │     │
  │  └─────────┘  └──────────┘  └────────┘  └─────────────────┘     │
  │                                                                   │
  │  Routing: initialize → [conditional] → agents → finalize → END   │
  │  Each agent: reads state → does work → writes back → logs trace  │
  │                                                                   │
  └─────┬─────────────────────────────────────────────────────────────┘
        │
   ┌────┴──────────────────┐  ┌────────────────────────────────────┐
   │  LLM LAYER            │  │  STORAGE LAYER                     │
   │                       │  │                                    │
   │  Primary:             │  │  PostgreSQL + pgvector              │
   │   Claude 3.5 Sonnet   │  │  ├── contracts (metadata, summary) │
   │   (200K context)      │  │  ├── contract_chunks + embeddings  │
   │       │ fallback      │  │  ├── clause_risk_assessments       │
   │       ▼               │  │  ├── clause_library (20 standards) │
   │  GPT-4o Mini          │  │  └── runs, traces, activity        │
   │   (128K context)      │  │                                    │
   │                       │  │  Vector search: cosine (<=>)       │
   │  Embeddings:          │  │  with HNSW indexing                │
   │   text-embedding-3-   │  │                                    │
   │   small (1536-dim)    │  │  File storage:                     │
   │                       │  │  uploads/{contract_id}/            │
   │  via LiteLLM +        │  │                                    │
   │  OpenRouter            │  │                                    │
   └───────────────────────┘  └────────────────────────────────────┘
```

---

#### Key Design Decisions

| Decision | Why |
|----------|-----|
| **LangGraph** over LangChain agents | Explicit state, conditional routing, full traceability. Deterministic — agents can't skip steps. |
| **Blackboard pattern** for agent communication | Agents are decoupled. Adding a new agent = new state field, zero changes to existing agents. |
| **Two-layer risk** (keyword + LLM) | Keywords: instant, zero hallucination. LLM: nuanced, context-aware. Defense in depth. |
| **PostgreSQL + pgvector** over Pinecone | One DB for structured data AND vectors. Sufficient at this scale. |
| **Hybrid retrieval** (semantic + keyword) | Legal text has concepts ("liability cap") AND exact refs ("Section 3.2"). Need both. |
| **PDF-first UX** | The document is the workspace. Intelligence on the PDF, not beside it. |

---
