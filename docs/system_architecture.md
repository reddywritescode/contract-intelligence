# Contract Intelligence Platform — System Architecture

## 1. High-Level Architecture

End-to-end flow from document upload to user-facing insights.

```mermaid
flowchart TB
    subgraph UserLayer["User Layer"]
        Upload["Upload Contract\n(PDF/DOCX/TXT)"]
        UI["Next.js Frontend\n(React SPA)"]
    end

    subgraph APILayer["API Layer"]
        FastAPI["FastAPI Server\n/api/v1/*"]
    end

    subgraph ProcessingLayer["Processing Pipeline"]
        Ingest["Ingestion Service\nParse + Chunk"]
        Embed["Embedding Service\ntext-embedding-3-small"]
        Classify["Clause Classifier\nKeyword-based"]
        Workflow["LangGraph Workflow\nOrchestrator"]
    end

    subgraph LLMLayer["LLM Layer"]
        Gateway["Model Gateway\nLiteLLM + OpenRouter"]
        Primary["Primary: Claude 3.5 Sonnet"]
        Fallback["Fallback: GPT-4o Mini"]
    end

    subgraph StorageLayer["Storage Layer"]
        PG["PostgreSQL\nContracts, Runs, Activity"]
        PGV["pgvector\nEmbeddings + Similarity"]
        Files["File Storage\nuploads/{contract_id}/"]
    end

    Upload --> FastAPI
    FastAPI --> Ingest
    Ingest --> Embed
    Ingest --> Files
    Embed --> PGV
    Ingest --> PG
    FastAPI --> Workflow
    Workflow --> Gateway
    Gateway --> Primary
    Gateway --> Fallback
    Workflow --> PG
    Classify --> PG
    FastAPI --> UI
    PG --> UI
    PGV --> Workflow
```

## 2. LangGraph Workflow

The orchestration engine that routes tasks through specialized agents.

```mermaid
flowchart LR
    Init["initialize\n- set run_id\n- record trace"] --> RouteInit{Route}

    RouteInit -->|summary in tasks| Summarize["summarize\n- Top 10 chunks\n- Extract JSON terms\n- Model + fallback"]
    RouteInit -->|qa in tasks| QA
    RouteInit -->|risk in tasks| Risk
    RouteInit -->|none| Finalize

    Summarize --> RouteSumm{Route}
    RouteSumm -->|qa in tasks| QA["answer_question\n- Hybrid retrieval\n- top_k=10\n- Cited answer"]
    RouteSumm -->|risk in tasks| Risk
    RouteSumm -->|none| Finalize

    QA --> RouteQA{Route}
    RouteQA -->|risk in tasks| Risk["risk_scan\n- 5 keyword rules\n- LLM clause assess\n- vs Clause Library"]
    RouteQA -->|none| Finalize

    Risk --> Finalize["finalize\n- Set approval\n- Record trace\n- Save run"]
    Finalize --> Done["END"]
```

## 3. Data Flow

How a PDF moves from upload through to displayed insights.

```mermaid
flowchart TB
    subgraph Ingestion["Document Ingestion"]
        PDF["PDF File"] --> Parse["Parse\n(pdf.js / python-docx)"]
        Parse --> Chunk["Semantic Chunking\n1200 char max\n100 char min"]
        Chunk --> Meta["Extract Metadata\ntype, counterparty, date"]
    end

    subgraph Embedding["Embedding Pipeline"]
        Chunk --> EmbedGen["Generate Embeddings\n1536 dimensions"]
        EmbedGen --> VecStore["Store in pgvector\ncontract_chunks table"]
    end

    subgraph Retrieval["Retrieval at Query Time"]
        UserQuery["User Question"] --> HybridSearch["Hybrid Search"]
        HybridSearch --> Semantic["Semantic Search\ncosine similarity"]
        HybridSearch --> Keyword["Keyword Search\ntoken scoring"]
        Semantic --> Merge["Merge + Deduplicate"]
        Keyword --> Merge
    end

    subgraph Analysis["LLM Analysis"]
        Merge --> Context["Build Context\ntop-k chunks"]
        Context --> LLM["LLM Generation\nRole-specific prompt"]
        LLM --> Output["Structured JSON Output\ncitations included"]
    end

    subgraph Display["Frontend Display"]
        Output --> PDFView["PDF Viewer\nRisk-colored highlights"]
        Output --> Findings["Findings Panel\nClause risk badges"]
        Output --> Chat["AI Chat\nSource citations"]
        Output --> Intel["Clause Intelligence\nDeep-dive panel"]
    end

    VecStore --> Semantic
    Meta --> VecStore
```

## 4. Frontend Component Architecture

How the Next.js SPA is structured.

```mermaid
flowchart TB
    subgraph TopNav["Top Navigation"]
        NavDocs["Documents"]
        NavCL["Clause Library"]
        NavWF["Workflows"]
        NavTools["Tools"]
        NavDash["Dashboard"]
        NavAI["Ask AI Button"]
    end

    subgraph DetailView["Contract Detail View"]
        Header["Header + Meta Grid"]
        TabBar["Tab Bar: Overview | Contents | Lifecycle | Analytics | Comments | Activity"]
        DebugBtn["Debug Button"]
    end

    subgraph ContentsTab["Contents Tab (Split Panel)"]
        subgraph LeftPanel["Left: Document Viewer"]
            PDFViewer["PdfViewer Component\n(iframe + pdf.js)"]
            FocusBtn["Focus Mode Toggle"]
        end
        subgraph RightPanel["Right: Analysis Panel"]
            Structure["Structure Tab\nSection tree"]
            FindingsTab["Findings Tab\nClause groups + risk badges"]
            ReviewTab["Review Tab\nClause gaps + playbook"]
            KeyInfo["Key Info Tab\nExtracted terms"]
        end
    end

    subgraph Overlays["Overlay Panels"]
        AIChat["AI Chat Panel\nFloating, citations"]
        DebugPanel["Debug Panel\nTimeline trace"]
        PlaybookOvl["Playbook Compare"]
        ClauseIntel["Clause Intelligence\nDeep-dive panel"]
    end

    subgraph Communication["PDF Communication"]
        PostMsg["postMessage API"]
        Highlight["highlight: texts, focusText,\nmode, page, riskMap"]
        Navigate["navigate: page"]
        Clear["clear"]
    end

    NavDocs --> DetailView
    TabBar --> ContentsTab
    DebugBtn --> DebugPanel
    NavAI --> AIChat
    PDFViewer --> PostMsg
    PostMsg --> Highlight
    PostMsg --> Navigate
    PostMsg --> Clear
    FindingsTab --> ClauseIntel
```

## 5. Risk Assessment Pipeline

How risk is evaluated at multiple levels.

```mermaid
flowchart TB
    subgraph Layer1["Layer 1: Keyword Risk Scan"]
        FullText["Full contract text\n(lowercased)"] --> R001["R-001: Unlimited Liability\nkeyword: unlimited liability"]
        FullText --> R002["R-002: Auto-Renewal\nkeyword: auto-renew"]
        FullText --> R003["R-003: Termination Rigidity\nabsence: termination for convenience"]
        FullText --> R004["R-004: Missing Governing Law\nabsence: governing law"]
        FullText --> R005["R-005: Long Payment Cycle\nkeyword: net 60/90"]
    end

    subgraph Layer2["Layer 2: LLM Clause Risk Assessment"]
        Chunks["Classified Chunks\nper clause group"] --> Compare["Compare vs\nClause Library\nstandard_language"]
        Compare --> LLMAssess["LLM Assessment\nCLAUSE_RISK_SYSTEM prompt"]
        LLMAssess --> Scores["Per-Clause Output:\nrisk_level, risk_score 0-100,\nreason, deviation,\nrecommendation"]
    end

    subgraph Layer3["Layer 3: Visual Risk Display"]
        Scores --> Badges["Risk Badges\nH/M/L in Findings"]
        Scores --> PDFColors["PDF Highlights\nred/amber/green"]
        Scores --> IntelPanel["Clause Intelligence\nscore bar + deep-dive"]
        Scores --> SummaryBar["Risk Summary Bar\nX High, Y Medium, Z Low"]
    end

    R001 --> RiskFlags["Risk Flags\nin Findings panel"]
    R002 --> RiskFlags
    R003 --> RiskFlags
    R004 --> RiskFlags
    R005 --> RiskFlags
```

## 6. API Endpoint Map

All backend routes grouped by domain.

```mermaid
flowchart LR
    subgraph ContractOps["Contract Operations"]
        C1["GET /contracts"]
        C2["POST /contracts/ingest"]
        C3["POST /contracts/{id}/analyze"]
        C4["POST /contracts/{id}/ask"]
        C5["GET /contracts/{id}/file"]
        C6["GET /contracts/{id}/chunks"]
        C7["GET /contracts/{id}/highlights"]
        C8["GET /contracts/{id}/suggested-questions"]
        C9["GET /contracts/{id}/clause-gaps"]
        C10["GET /contracts/{id}/clause-assessments"]
        C11["POST /contracts/{id}/clause-assessments/run"]
        C12["POST /contracts/{id}/explain"]
        C13["POST /contracts/{id}/playbook-compare"]
    end

    subgraph RunOps["Run Operations"]
        R1["GET /contracts/{id}/runs"]
        R2["GET /contracts/{id}/risks"]
        R3["POST /runs/{id}/approve"]
        R4["GET /runs/{id}/trace"]
        R5["GET /runs/{id}"]
    end

    subgraph SocialOps["Collaboration"]
        S1["GET /contracts/{id}/comments"]
        S2["POST /contracts/{id}/comments"]
        S3["GET /contracts/{id}/activity"]
    end

    subgraph SentinelOps["Sentinel AI"]
        T1["GET /sentinel/prompts"]
        T2["POST /sentinel/prompts"]
        T3["POST /sentinel/review"]
        T4["GET /sentinel/sessions"]
    end

    subgraph AutopilotOps["Autopilot Agent"]
        A1["GET /autopilot/templates"]
        A2["POST /autopilot/tasks"]
        A3["POST /autopilot/tasks/{id}/execute"]
    end

    subgraph LibraryOps["Clause Library"]
        L1["GET /clause-library"]
        L2["POST /clause-library"]
        L3["PUT /clause-library/{id}"]
        L4["DELETE /clause-library/{id}"]
    end

    subgraph WorkflowOps["Workflows"]
        W1["GET /workflows"]
        W2["POST /workflows"]
        W3["PATCH /workflows/{id}/steps/{sid}"]
    end

    subgraph TemplateOps["Doc Templates"]
        D1["GET /templates"]
        D2["POST /templates/{id}/generate"]
        D3["GET /generated-docs"]
    end

    subgraph DashOps["Dashboard"]
        I1["GET /dashboard/insights"]
    end
```

## Technology Stack

| Layer | Technology | Purpose |
|-------|-----------|---------|
| Frontend | Next.js 14 (App Router), React, TypeScript | Single-page application |
| PDF Viewer | pdf.js via iframe, postMessage API | In-browser PDF rendering + highlighting |
| Charts | Recharts | Bar charts, line charts (no pie charts) |
| API | FastAPI (Python 3.11+) | REST API server |
| Orchestration | LangGraph (StateGraph) | Multi-agent workflow routing |
| LLM | LiteLLM + OpenRouter | Claude 3.5 Sonnet (primary), GPT-4o Mini (fallback) |
| Embeddings | text-embedding-3-small | 1536-dimension vectors |
| Database | PostgreSQL + pgvector | Structured data + vector similarity |
| Containerization | Docker Compose | PostgreSQL container |

## Database Schema (Key Tables)

| Table | Primary Key | Purpose |
|-------|------------|---------|
| contracts | contract_id | Contract metadata |
| contract_chunks | (contract_id, chunk_id) | Parsed text chunks with embeddings |
| runs | run_id | Analysis run results + trace |
| clause_risk_assessments | assessment_id | Per-clause LLM risk scores |
| clause_library | clause_id | Standard clause definitions |
| workflows | workflow_id | Review workflow tracking |
| workflow_steps | step_id | Individual workflow steps |
| contract_comments | comment_id | User comments |
| contract_activity | activity_id | Activity audit log |
| prompt_templates | prompt_id | Sentinel AI prompts |
| review_sessions | session_id | Sentinel review results |
| agent_tasks | task_id | Autopilot agent tasks |
| doc_templates | template_id | Document generation templates |
| generated_docs | doc_id | Generated documents |
