# Contract Intelligence Platform — High-Level Architecture

> **Purpose**: This diagram maps directly to the requirements discussed in the case study and hiring manager conversation. Each numbered block corresponds to a specific ask from the transcript.

---

## System Overview (Presenter Diagram)

```mermaid
flowchart LR
    subgraph USER["👤 User Experience"]
        direction TB
        U1["Upload Contract\n(PDF, DOCX, OCR)"]
        U2["Interactive PDF Review\n(Risk highlights, clause badges)"]
        U3["Ask AI — Natural Language Q&A\n(Citation-backed answers)"]
        U4["Repository Dashboard\n(KPIs, risk scores, renewals)"]
    end

    subgraph INGEST["📄 Document Ingestion Pipeline"]
        direction TB
        I1["Parse Document\n(PDF / DOCX / HTML / TXT)"]
        I2["OCR Fallback\n(pytesseract + pdf2image)"]
        I3["Hybrid Chunking\n(Semantic + Structural)"]
        I4["Clause Classification\n(8 procurement categories)"]
        I5["Embedding Generation\n(text-embedding-3-small)"]
    end

    subgraph ORCH["🤖 Multi-Agent Orchestrator (LangGraph)"]
        direction TB
        O0["Intent Router\n(LLM classifies user query)"]
        O1["Summarization Agent\n• Role: Contract Summarizer\n• Output: Structured JSON\n• Source chunk IDs tracked"]
        O2["Q&A Agent\n• Role: Contract Analyst\n• Output: Answer + Citations\n• Hybrid retrieval (semantic + keyword)"]
        O3["Risk & Compliance Agent\n• Role: Risk Analyst\n• Output: Per-clause assessments\n• Playbook comparison"]
        O4["Shared ContractState\n(JSON with traceable outputs)"]
    end

    subgraph MODELS["🧠 Foundation Models"]
        M1["Claude 3.5 Sonnet\n(Primary)"]
        M2["GPT-4o Mini\n(Fallback)"]
        M3["text-embedding-3-small\n(Embeddings)"]
    end

    subgraph STORE["💾 Storage"]
        S1["PostgreSQL + pgvector\n• contracts, chunks, embeddings\n• clause assessments\n• agent traces & runs"]
        S2["File Storage\n(Raw uploads)"]
    end

    U1 --> I1
    I1 --> I2
    I1 --> I3
    I3 --> I4
    I3 --> I5
    I5 --> S1
    I4 --> S1

    U3 --> O0
    O0 -->|summary task| O1
    O0 -->|question| O2
    O0 -->|risk/compliance| O3
    O1 & O2 & O3 --> O4

    O2 -->|retrieve chunks| S1
    O1 --> M1
    O2 --> M1
    O3 --> M1
    M1 -.->|fallback| M2
    I5 --> M3

    O4 -->|structured response| U2
    O4 -->|answer + citations| U3
    S1 -->|risk scores, KPIs| U4
    S2 -->|serve PDF| U2

    style USER fill:#eff6ff,stroke:#3b82f6,color:#1e3a5f
    style INGEST fill:#fefce8,stroke:#eab308,color:#713f12
    style ORCH fill:#f0fdf4,stroke:#22c55e,color:#14532d
    style MODELS fill:#f5f3ff,stroke:#8b5cf6,color:#3b0764
    style STORE fill:#fdf2f8,stroke:#ec4899,color:#831843
```

---

## How This Maps to What They Asked

| # | What the Hiring Manager / Case Study Asked | Where It Lives in the System |
|---|---|---|
| 1 | **Multi-agent orchestration with LangGraph** | `ORCH` — LangGraph StateGraph with conditional routing, shared `ContractState`, `AgentTrace` |
| 2 | **Specialized agents** (ingestion, clause extraction, summarization, Q&A, risk/compliance) | 5 agents: `IngestionAgent`, `ClauseExtractionAgent`, `SummarizationAgent`, `QAAgent`, `RiskComplianceAgent` |
| 3 | **Agents share structured contract state (JSON) with traceable outputs** | `ContractState` Pydantic model flows through every agent; `AgentTrace` logs every step |
| 4 | **Orchestrator agent to interpret user intent and route tasks** | `OrchestratorAgent` uses LLM-based intent classification → routes to correct agent |
| 5 | **Document ingestion (PDF, DOCX, OCR)** | `INGEST` pipeline — PDF parsing, DOCX extraction, OCR via pytesseract |
| 6 | **Clause extraction and normalization** | Hybrid chunking (semantic similarity + regex headers) → LLM clause classifier (8 categories) |
| 7 | **RAG-based Q&A with citations** | `QAAgent` — hybrid retrieval (pgvector cosine + keyword), `QACitation` objects with chunk IDs, page numbers, text |
| 8 | **Risk and compliance analysis** | `RiskComplianceAgent` — per-clause risk scoring (0-100), deviation detection, playbook comparison |
| 9 | **Prompting strategy: role-specific prompts, strict output schemas, citation-required** | Every agent has a role prompt, Pydantic-enforced JSON schema, and citation tracking |
| 10 | **PDF-first UI with highlights, risk badges, interactive review** | `USER` layer — pdf.js iframe, category-colored highlights, inline risk badges, pulse on click |
| 11 | **Compliance checklist with playbook comparison** | Clause Library + gap detection, inline side-by-side vendor vs. standard text, word-diff highlighting |
| 12 | **Repository with KPIs and risk overview** | Dashboard with metric tiles, risk donut scores, renewal countdowns, status badges |

---

## Data Flow (The Story to Tell)

```
                    ┌─────────────────────────────────────────────────────┐
                    │                   USER UPLOADS PDF                   │
                    └─────────────────────┬───────────────────────────────┘
                                          │
                                          ▼
                    ┌─────────────────────────────────────────────────────┐
                    │              DOCUMENT INGESTION PIPELINE             │
                    │                                                     │
                    │  PDF/DOCX → Text Extraction (+ OCR if scanned)     │
                    │  → [[PAGE:N]] markers inserted                      │
                    │  → Hybrid Chunking (semantic + structural)          │
                    │  → LLM Clause Classification (8 categories)         │
                    │  → Embedding (text-embedding-3-small, 1536-dim)     │
                    │  → Store chunks + vectors in PostgreSQL/pgvector    │
                    └─────────────────────┬───────────────────────────────┘
                                          │
                                          ▼
                    ┌─────────────────────────────────────────────────────┐
                    │            USER CLICKS "ANALYZE" or "ASK AI"        │
                    └─────────────────────┬───────────────────────────────┘
                                          │
                                          ▼
              ┌───────────────────────────────────────────────────────────────┐
              │                   LANGGRAPH ORCHESTRATOR                      │
              │                                                               │
              │   ┌──────────┐    ┌──────────────────────────────────────┐   │
              │   │ INTENT   │───▶│  Conditional Routing                 │   │
              │   │ ROUTER   │    │  • "Summarize this" → Summarization  │   │
              │   │ (LLM)    │    │  • "What is the term?" → Q&A         │   │
              │   └──────────┘    │  • "Analyze risks" → Risk Agent      │   │
              │                    │  • "Full analysis" → All agents      │   │
              │                    └──────────┬───────────────────────────┘   │
              │                               │                               │
              │         ┌─────────────────────┼─────────────────────┐         │
              │         ▼                     ▼                     ▼         │
              │  ┌──────────────┐   ┌──────────────┐   ┌──────────────────┐  │
              │  │ Summarization│   │   Q&A Agent   │   │ Risk/Compliance  │  │
              │  │    Agent     │   │               │   │     Agent        │  │
              │  │              │   │ Hybrid RAG:   │   │                  │  │
              │  │ • Structured │   │ • Vector sim  │   │ • Per-clause     │  │
              │  │   summary    │   │ • Keyword     │   │   scoring (0-100)│  │
              │  │ • Source IDs │   │ • Citations   │   │ • Deviation flags│  │
              │  │   tracked    │   │   with pages  │   │ • Recommendations│  │
              │  └──────┬───────┘   └──────┬───────┘   └──────┬───────────┘  │
              │         └─────────────────┬┘───────────────────┘              │
              │                           ▼                                   │
              │              ┌────────────────────────┐                       │
              │              │  Shared ContractState   │                       │
              │              │  (JSON + AgentTrace)    │                       │
              │              └────────────┬───────────┘                       │
              └───────────────────────────┼───────────────────────────────────┘
                                          │
                                          ▼
              ┌───────────────────────────────────────────────────────────────┐
              │                    FRONTEND RENDERS RESULTS                    │
              │                                                               │
              │  ┌─────────────┐  ┌──────────────┐  ┌─────────────────────┐  │
              │  │  PDF Viewer  │  │  Review Panel │  │   Ask AI Chat       │  │
              │  │             │  │              │  │                     │  │
              │  │ • Category- │  │ • AI Summary │  │ • Citation-backed   │  │
              │  │   colored   │  │ • Clause     │  │   answers           │  │
              │  │   highlights│  │   risk list  │  │ • Source cards with  │  │
              │  │ • Risk      │  │ • Missing    │  │   page + section    │  │
              │  │   badges    │  │   clause     │  │ • Highlights synced  │  │
              │  │ • Pulse on  │  │   warnings   │  │   to PDF             │  │
              │  │   click     │  │ • Compliance │  │                     │  │
              │  │             │  │   checklist  │  │                     │  │
              │  └─────────────┘  └──────────────┘  └─────────────────────┘  │
              └───────────────────────────────────────────────────────────────┘
```

---

## Key Design Decisions (Talking Points)

| Decision | What We Chose | Why |
|----------|---------------|-----|
| Orchestration | **LangGraph** (not LangChain agents) | Explicit state control, conditional routing, full traceability |
| Vector store | **pgvector** (not Pinecone) | Single DB for structured + vector data; sufficient at procurement scale |
| Chunking | **Hybrid** (semantic + structural) | Pure semantic misses section headers; pure structural misses context |
| Retrieval | **Hybrid RAG** (cosine similarity + keyword) | Semantic alone misses exact terms ("Net 90"); keyword alone misses meaning |
| LLM routing | **LiteLLM + OpenRouter** | Model-agnostic; primary Claude 3.5 + GPT-4o fallback without code changes |
| PDF rendering | **pdf.js in iframe** | Performance isolation, security sandboxing, direct canvas highlighting |
| Risk assessment | **Per-clause scoring (0-100)** | Granular, not binary; maps to visual donut/badge in UI |
| Prompting | **Role + Schema + Citation** per agent | Reduces hallucination, enforces structure, enables traceability |

---

## One Sentence to Open the Presentation

> "We built a multi-agent RAG system on LangGraph that ingests any contract document, breaks it into semantically meaningful clauses, runs specialized AI agents for summarization, Q&A, and risk scoring — all sharing a traceable JSON state — and renders the results as an interactive PDF review experience with inline highlights, risk badges, and citation-backed answers."
