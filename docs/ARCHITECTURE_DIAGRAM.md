# Contract Intelligence — Architecture

```mermaid
flowchart TB
    subgraph UI["Frontend (Next.js)"]
        Upload["Upload Contract"]
        PDFView["PDF Viewer + Highlights"]
        Chat["Ask AI Panel"]
        Dashboard["Dashboard / Analytics"]
    end

    subgraph API["FastAPI Backend"]
        Ingest["Ingest API"]
        Analyze["Analyze API"]
        Query["Query API"]
    end

    subgraph Agents["LangGraph Orchestrator"]
        Init["Initialize"] --> Router{"Route Tasks"}
        Router -->|summary| SumAgent["Summarization Agent\n(Role: Contract Summarizer)\n(Schema: Strict JSON)"]
        Router -->|qa| QAAgent["Q&A Agent\n(Role: Contract Analyst)\n(Schema: Citation-required)"]
        Router -->|risk| RiskAgent["Risk & Compliance Agent\n(Role: Risk Analyst)\n(Schema: Playbook-referenced)"]
        SumAgent --> QAAgent --> RiskAgent --> Finalize["Finalize"]
    end

    subgraph Processing["Document Processing"]
        Parse["Parse PDF / DOCX / TXT"]
        Chunk["Semantic Section Chunker\n(Header detection, section boundaries)"]
        Classify["LLM Clause Classifier\n(8 categories)"]
        Embed["Embedding Model\n(text-embedding-3-small)"]
    end

    subgraph Storage["Storage Layer"]
        PG["PostgreSQL + pgvector"]
        Files["File Storage\n(Raw uploads)"]
    end

    subgraph Models["Foundation Models"]
        LLM["Claude 3.5 Sonnet\n(Primary)"]
        Fallback["GPT-4o-mini\n(Fallback)"]
        EmbModel["text-embedding-3-small\n(Embeddings)"]
    end

    Upload -->|file| Ingest
    Ingest --> Parse --> Chunk --> Embed
    Chunk --> Classify
    Embed -->|vectors| PG
    Chunk -->|chunks + metadata| PG
    Ingest -->|raw bytes| Files

    Chat -->|question| Analyze
    Analyze --> Init
    QAAgent -->|"hybrid retrieve\n(semantic + keyword)"| PG
    SumAgent --> LLM
    QAAgent --> LLM
    RiskAgent --> LLM
    LLM -.->|fallback| Fallback
    Embed --> EmbModel

    Finalize -->|"structured response\n(summary, answer, citations, risks)"| UI
    Files -->|serve PDF| PDFView
    PG -->|chunks, highlights| PDFView

    style UI fill:#eff6ff,stroke:#3b82f6,color:#1e3a5f
    style Agents fill:#f0fdf4,stroke:#22c55e,color:#14532d
    style Processing fill:#fefce8,stroke:#eab308,color:#713f12
    style Storage fill:#fdf2f8,stroke:#ec4899,color:#831843
    style Models fill:#f5f3ff,stroke:#8b5cf6,color:#3b0764
```

## Component Summary

| Layer | Technology | Purpose |
|-------|-----------|---------|
| **Frontend** | Next.js, React, react-pdf | PDF viewer with clause highlights, Ask AI chat, dashboard |
| **API** | FastAPI | REST endpoints for ingest, analyze, query, file serving |
| **Orchestrator** | LangGraph | Routes tasks to specialized agents with shared state |
| **Agents** | Role-specific prompts + strict schemas | Summarization, Q&A, Risk analysis |
| **Retrieval** | Hybrid (semantic + keyword) | pgvector cosine similarity + keyword fallback |
| **Embeddings** | text-embedding-3-small via OpenRouter | 1536-dim vectors stored in pgvector |
| **Classification** | LLM-based clause classifier | 8 contract clause categories |
| **Chunking** | Semantic section detection | Header/clause boundary detection |
| **LLM** | Claude 3.5 Sonnet / GPT-4o-mini | Primary + fallback via OpenRouter |
| **Database** | PostgreSQL + pgvector | Contracts, chunks, embeddings, runs, traces |
