from __future__ import annotations

from contextlib import contextmanager
from typing import Iterator

import psycopg

from app.core.config import settings


@contextmanager
def get_conn() -> Iterator[psycopg.Connection]:
    conn = psycopg.connect(settings.database_url)
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_db() -> None:
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("CREATE EXTENSION IF NOT EXISTS vector;")
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS contracts (
                    contract_id TEXT PRIMARY KEY,
                    filename TEXT NOT NULL,
                    created_at TIMESTAMPTZ NOT NULL
                );
                """
            )
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS contract_chunks (
                    contract_id TEXT NOT NULL REFERENCES contracts(contract_id) ON DELETE CASCADE,
                    chunk_id TEXT NOT NULL,
                    text TEXT NOT NULL,
                    section TEXT NULL,
                    page INT NULL,
                    embedding vector(1536) NULL,
                    PRIMARY KEY (contract_id, chunk_id)
                );
                """
            )
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS runs (
                    run_id TEXT PRIMARY KEY,
                    contract_id TEXT NOT NULL REFERENCES contracts(contract_id) ON DELETE CASCADE,
                    mode TEXT NOT NULL,
                    summary JSONB NULL,
                    answer TEXT NULL,
                    answer_citations JSONB NOT NULL,
                    risks JSONB NOT NULL,
                    requires_approval BOOLEAN NOT NULL DEFAULT FALSE,
                    approved BOOLEAN NOT NULL DEFAULT FALSE,
                    trace JSONB NOT NULL,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                );
                """
            )
            cur.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_chunks_contract_id ON contract_chunks(contract_id);
                """
            )
            cur.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_runs_contract_id_created_at ON runs(contract_id, created_at DESC);
                """
            )
            # Add embedding column if it doesn't exist (for existing databases)
            cur.execute(
                """
                DO $$
                BEGIN
                    IF NOT EXISTS (
                        SELECT 1 FROM information_schema.columns
                        WHERE table_name = 'contract_chunks' AND column_name = 'embedding'
                    ) THEN
                        ALTER TABLE contract_chunks ADD COLUMN embedding vector(1536) NULL;
                    END IF;
                END $$;
                """
            )
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS contract_comments (
                    comment_id TEXT PRIMARY KEY,
                    contract_id TEXT NOT NULL REFERENCES contracts(contract_id) ON DELETE CASCADE,
                    chunk_id TEXT NULL,
                    text TEXT NOT NULL,
                    author TEXT NOT NULL DEFAULT 'User',
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                );
                """
            )
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS contract_activity (
                    activity_id TEXT PRIMARY KEY,
                    contract_id TEXT NOT NULL REFERENCES contracts(contract_id) ON DELETE CASCADE,
                    action TEXT NOT NULL,
                    details TEXT NULL,
                    actor TEXT NOT NULL DEFAULT 'System',
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                );
                """
            )
            cur.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_activity_contract ON contract_activity(contract_id, created_at DESC);
                """
            )
            # Add metadata columns for filtering
            for col, coltype in [
                ("contract_type", "TEXT"),
                ("counterparty", "TEXT"),
                ("agreement_date", "DATE"),
                ("status", "TEXT DEFAULT 'Under Review'"),
                ("risk_level", "TEXT"),
                ("risk_score", "INT"),
            ]:
                cur.execute(f"""
                    DO $$ BEGIN
                        IF NOT EXISTS (
                            SELECT 1 FROM information_schema.columns
                            WHERE table_name = 'contracts' AND column_name = '{col}'
                        ) THEN
                            ALTER TABLE contracts ADD COLUMN {col} {coltype};
                        END IF;
                    END $$;
                """)

            # Sentinel AI Assistant tables
            cur.execute("""
                CREATE TABLE IF NOT EXISTS prompt_templates (
                    prompt_id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    description TEXT,
                    prompt_text TEXT NOT NULL,
                    category TEXT NOT NULL DEFAULT 'Custom',
                    author TEXT NOT NULL DEFAULT 'System',
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                );
            """)
            cur.execute("""
                CREATE TABLE IF NOT EXISTS review_sessions (
                    session_id TEXT PRIMARY KEY,
                    contract_id TEXT NOT NULL REFERENCES contracts(contract_id) ON DELETE CASCADE,
                    prompt_id TEXT REFERENCES prompt_templates(prompt_id),
                    custom_prompt TEXT,
                    status TEXT NOT NULL DEFAULT 'pending',
                    result JSONB,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    completed_at TIMESTAMPTZ
                );
            """)
            cur.execute("""
                CREATE INDEX IF NOT EXISTS idx_review_sessions_contract
                ON review_sessions(contract_id, created_at DESC);
            """)

            # Autopilot agent tasks
            cur.execute("""
                CREATE TABLE IF NOT EXISTS agent_tasks (
                    task_id TEXT PRIMARY KEY,
                    title TEXT NOT NULL,
                    description TEXT NOT NULL,
                    task_type TEXT NOT NULL DEFAULT 'custom',
                    scope TEXT NOT NULL DEFAULT 'all',
                    contract_id TEXT REFERENCES contracts(contract_id) ON DELETE SET NULL,
                    status TEXT NOT NULL DEFAULT 'queued',
                    progress INT NOT NULL DEFAULT 0,
                    steps JSONB NOT NULL DEFAULT '[]'::jsonb,
                    result JSONB,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    started_at TIMESTAMPTZ,
                    completed_at TIMESTAMPTZ
                );
            """)
            cur.execute("""
                CREATE INDEX IF NOT EXISTS idx_agent_tasks_status
                ON agent_tasks(status, created_at DESC);
            """)

            # ── Clause Risk Assessments ──
            cur.execute("""
                CREATE TABLE IF NOT EXISTS clause_risk_assessments (
                    assessment_id TEXT PRIMARY KEY,
                    contract_id TEXT NOT NULL REFERENCES contracts(contract_id) ON DELETE CASCADE,
                    chunk_id TEXT NOT NULL,
                    clause_type TEXT NOT NULL,
                    risk_level TEXT NOT NULL DEFAULT 'low',
                    risk_score INT NOT NULL DEFAULT 0,
                    reason TEXT NOT NULL,
                    standard_clause TEXT,
                    deviation TEXT,
                    recommendation TEXT,
                    citations JSONB NOT NULL DEFAULT '[]'::jsonb,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                );
            """)
            cur.execute("""
                CREATE INDEX IF NOT EXISTS idx_clause_risk_contract
                ON clause_risk_assessments(contract_id, clause_type);
            """)

            # ── Contract Reviews (human decisions + AI summary) ──
            cur.execute("""
                CREATE TABLE IF NOT EXISTS contract_reviews (
                    review_id TEXT PRIMARY KEY,
                    contract_id TEXT NOT NULL REFERENCES contracts(contract_id) ON DELETE CASCADE,
                    decision TEXT NOT NULL DEFAULT 'pending',
                    reviewer_notes TEXT,
                    ai_summary TEXT,
                    overall_score INT,
                    decided_by TEXT,
                    decided_at TIMESTAMPTZ,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                );
            """)
            cur.execute("""
                CREATE UNIQUE INDEX IF NOT EXISTS idx_contract_reviews_contract
                ON contract_reviews(contract_id);
            """)

            # ── Clause Library ──
            cur.execute("""
                CREATE TABLE IF NOT EXISTS clause_library (
                    clause_id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    category TEXT NOT NULL DEFAULT 'General',
                    description TEXT NOT NULL,
                    standard_language TEXT,
                    risk_notes TEXT,
                    required BOOLEAN NOT NULL DEFAULT FALSE,
                    tags TEXT[] DEFAULT '{}',
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                );
            """)

            # ── Workflows ──
            cur.execute("""
                CREATE TABLE IF NOT EXISTS workflows (
                    workflow_id TEXT PRIMARY KEY,
                    contract_id TEXT REFERENCES contracts(contract_id) ON DELETE CASCADE,
                    name TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'draft',
                    created_by TEXT NOT NULL DEFAULT 'User',
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                );
            """)
            cur.execute("""
                CREATE TABLE IF NOT EXISTS workflow_steps (
                    step_id TEXT PRIMARY KEY,
                    workflow_id TEXT NOT NULL REFERENCES workflows(workflow_id) ON DELETE CASCADE,
                    title TEXT NOT NULL,
                    description TEXT,
                    assignee TEXT,
                    step_type TEXT NOT NULL DEFAULT 'review',
                    status TEXT NOT NULL DEFAULT 'pending',
                    due_date DATE,
                    completed_at TIMESTAMPTZ,
                    step_order INT NOT NULL DEFAULT 0
                );
            """)
            cur.execute("""
                CREATE INDEX IF NOT EXISTS idx_workflows_contract
                ON workflows(contract_id, created_at DESC);
            """)
            cur.execute("""
                CREATE INDEX IF NOT EXISTS idx_wf_steps_workflow
                ON workflow_steps(workflow_id, step_order);
            """)

            # ── Doc Templates & Generated Docs ──
            cur.execute("""
                CREATE TABLE IF NOT EXISTS doc_templates (
                    template_id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    description TEXT,
                    doc_type TEXT NOT NULL DEFAULT 'MSA',
                    template_body TEXT NOT NULL,
                    variables JSONB NOT NULL DEFAULT '[]'::jsonb,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                );
            """)
            cur.execute("""
                CREATE TABLE IF NOT EXISTS generated_docs (
                    doc_id TEXT PRIMARY KEY,
                    template_id TEXT REFERENCES doc_templates(template_id),
                    title TEXT NOT NULL,
                    instructions TEXT,
                    variables_filled JSONB NOT NULL DEFAULT '{}'::jsonb,
                    generated_text TEXT,
                    status TEXT NOT NULL DEFAULT 'generating',
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                );
            """)

            # Seed default procurement prompt templates
            cur.execute("SELECT COUNT(*) FROM prompt_templates WHERE author = 'Sentinel'")
            if cur.fetchone()[0] == 0:  # type: ignore[index]
                _seed_prompt_templates(cur)

            # Seed clause library
            cur.execute("SELECT COUNT(*) FROM clause_library")
            if cur.fetchone()[0] == 0:  # type: ignore[index]
                _seed_clause_library(cur)

            # Seed doc templates
            cur.execute("SELECT COUNT(*) FROM doc_templates")
            if cur.fetchone()[0] == 0:  # type: ignore[index]
                _seed_doc_templates(cur)


def _seed_prompt_templates(cur: psycopg.Cursor) -> None:  # type: ignore[type-arg]
    """Insert default procurement-focused prompt templates."""
    templates = [
        {
            "prompt_id": "pt_msa_review",
            "name": "Master Service Agreement Review",
            "description": "Comprehensive review of MSAs focusing on service scope, SLAs, liability, and vendor obligations.",
            "category": "Procurement",
            "prompt_text": (
                "You are a senior procurement analyst reviewing a Master Service Agreement. "
                "Generate a structured review table with the following columns:\n"
                "1. **Question** — The review question\n"
                "2. **Answer** — Detailed answer from the contract\n"
                "3. **Exact Source** — Exact quotes with section references\n"
                "4. **Risk Assessment** — High risk, Moderate risk, or No risk\n"
                "5. **Risk Analysis** — 2-3 sentences analyzing the risk\n\n"
                "Questions to answer:\n"
                "1. Who are the parties to this agreement and what are their roles?\n"
                "2. What services are being provided, and are they clearly defined?\n"
                "3. What are the payment terms, pricing structure, and late payment penalties?\n"
                "4. What are the SLA commitments and remedies for non-compliance?\n"
                "5. What are the liability caps and indemnification obligations?\n"
                "6. What are the termination rights and notice periods for each party?\n"
                "7. Are there auto-renewal provisions? What is the opt-out window?\n"
                "8. How does the agreement handle data protection and privacy?\n"
                "9. Who owns intellectual property created during the engagement?\n"
                "10. What insurance requirements are specified?\n"
                "11. Is there a non-solicitation or non-compete clause?\n"
                "12. What is the governing law and dispute resolution mechanism?\n\n"
                "Format the output as a markdown table. If information is not found, state 'Not found in contract' and mark as Moderate risk."
            ),
        },
        {
            "prompt_id": "pt_vendor_risk",
            "name": "Vendor Risk Assessment",
            "description": "Evaluate vendor contract risks including financial, operational, compliance, and reputational risks.",
            "category": "Risk",
            "prompt_text": (
                "You are a risk management specialist reviewing a vendor contract for a large enterprise. "
                "Perform a comprehensive vendor risk assessment covering:\n\n"
                "**Risk Categories to Evaluate:**\n"
                "1. Financial Risk — Payment terms, liability caps, penalty exposure\n"
                "2. Operational Risk — SLA gaps, business continuity, force majeure\n"
                "3. Compliance Risk — Regulatory adherence, data protection, audit rights\n"
                "4. Reputational Risk — Confidentiality, branding, public disclosure\n"
                "5. Strategic Risk — Lock-in, dependency, exit difficulty\n\n"
                "For each category, provide:\n"
                "- Risk Level (High/Medium/Low)\n"
                "- Key findings from the contract\n"
                "- Specific clause references\n"
                "- Recommended mitigations\n\n"
                "End with an overall risk score (1-10) and executive summary."
            ),
        },
        {
            "prompt_id": "pt_nda_review",
            "name": "NDA Compliance Review",
            "description": "Review NDAs for scope, obligations, duration, and enforceability concerns.",
            "category": "Procurement",
            "prompt_text": (
                "Review this Non-Disclosure Agreement and evaluate:\n\n"
                "1. Is the definition of 'Confidential Information' appropriately scoped?\n"
                "2. Are the obligations of the Receiving Party clearly stated?\n"
                "3. What are the permitted disclosures and exceptions?\n"
                "4. What is the duration of confidentiality obligations?\n"
                "5. Are there any residuals or carve-out clauses?\n"
                "6. What remedies are available for breach?\n"
                "7. Is it mutual or one-way? Is that appropriate for the context?\n"
                "8. Does it include a non-solicitation clause?\n"
                "9. What is the governing law and jurisdiction?\n"
                "10. Are there any unusual or non-standard provisions?\n\n"
                "Provide a markdown table with columns: Question, Finding, Risk Level, Recommendation."
            ),
        },
        {
            "prompt_id": "pt_saas_review",
            "name": "SaaS License Agreement Review",
            "description": "Review SaaS subscription agreements for data rights, uptime, and termination concerns.",
            "category": "Procurement",
            "prompt_text": (
                "Review this SaaS License Agreement from a procurement perspective:\n\n"
                "1. What is the subscription term and renewal mechanism?\n"
                "2. What are the uptime/availability commitments (SLA)?\n"
                "3. What happens to our data upon termination? Is there a data export period?\n"
                "4. Does the vendor claim any rights to our data for AI training or analytics?\n"
                "5. What security certifications does the vendor maintain (SOC 2, ISO 27001)?\n"
                "6. Are there usage limits, seat caps, or overage charges?\n"
                "7. What are the price escalation terms upon renewal?\n"
                "8. Is there a most-favored-customer pricing clause?\n"
                "9. What are the data residency and cross-border transfer provisions?\n"
                "10. What indemnification does the vendor provide for IP infringement?\n\n"
                "Format as a detailed table: Question, Answer, Source Reference, Risk Level, Recommendation."
            ),
        },
        {
            "prompt_id": "pt_sow_review",
            "name": "Statement of Work Review",
            "description": "Review SOWs for deliverables, timelines, acceptance criteria, and change management.",
            "category": "Procurement",
            "prompt_text": (
                "Review this Statement of Work focusing on:\n\n"
                "1. Are deliverables clearly defined with measurable acceptance criteria?\n"
                "2. Is the project timeline realistic with clear milestones?\n"
                "3. What is the payment schedule — milestone-based or time-based?\n"
                "4. Is there a change management / change order process?\n"
                "5. Who provides project management and escalation paths?\n"
                "6. What are the warranty terms for delivered work?\n"
                "7. Are there penalties for late delivery?\n"
                "8. How is intellectual property for deliverables assigned?\n"
                "9. What are the resource commitment obligations?\n"
                "10. Is there a clear project governance structure?\n\n"
                "Provide a structured review with Risk Assessment for each item."
            ),
        },
        {
            "prompt_id": "pt_payment_analysis",
            "name": "Payment Terms Analysis",
            "description": "Deep analysis of payment structures, penalties, and financial exposure.",
            "category": "Procurement",
            "prompt_text": (
                "Analyze the payment and financial terms in this contract:\n\n"
                "1. What is the total contract value or estimated spend?\n"
                "2. What is the payment schedule (Net 30/45/60/90)?\n"
                "3. Are there early payment discounts offered?\n"
                "4. What are the late payment penalties and interest rates?\n"
                "5. Is there a right to set-off or withhold payments?\n"
                "6. Are price adjustments tied to any index (CPI, etc.)?\n"
                "7. What taxes and additional fees apply?\n"
                "8. Are there volume discounts or commitment thresholds?\n"
                "9. What are the invoicing requirements and dispute procedures?\n"
                "10. What financial reporting obligations exist?\n\n"
                "Provide a financial risk summary with total potential exposure."
            ),
        },
        {
            "prompt_id": "pt_data_privacy",
            "name": "Data Privacy Compliance Check",
            "description": "Evaluate data privacy provisions against GDPR, CCPA, and enterprise standards.",
            "category": "Risk",
            "prompt_text": (
                "Evaluate the data privacy and protection provisions in this contract:\n\n"
                "1. Is there a Data Processing Agreement (DPA) or equivalent?\n"
                "2. What personal data will be processed and for what purpose?\n"
                "3. Are there GDPR/CCPA compliance commitments?\n"
                "4. What are the data breach notification requirements and timelines?\n"
                "5. Are there restrictions on sub-processors?\n"
                "6. What are the data retention and deletion policies?\n"
                "7. Are cross-border data transfers addressed (SCCs, adequacy decisions)?\n"
                "8. Does the vendor have the right to use data for AI training?\n"
                "9. What audit rights exist for data processing activities?\n"
                "10. Are there data subject access request (DSAR) handling procedures?\n\n"
                "Rate each provision as Compliant, Partially Compliant, or Non-Compliant."
            ),
        },
        {
            "prompt_id": "pt_termination_audit",
            "name": "Termination & Renewal Audit",
            "description": "Audit termination rights, renewal terms, and exit provisions.",
            "category": "Risk",
            "prompt_text": (
                "Audit the termination and renewal provisions in this contract:\n\n"
                "1. What are the termination for convenience rights for each party?\n"
                "2. What constitutes a material breach triggering termination?\n"
                "3. What are the cure periods before termination can be exercised?\n"
                "4. Is there an automatic renewal mechanism? What is the notice period to opt out?\n"
                "5. What are the financial consequences of early termination?\n"
                "6. Is there a transition/wind-down period upon termination?\n"
                "7. What happens to data, deliverables, and IP upon termination?\n"
                "8. Are there any survival clauses that extend beyond termination?\n"
                "9. Can the contract be assigned or transferred?\n"
                "10. What force majeure provisions exist?\n\n"
                "Provide a termination risk profile with actionable recommendations."
            ),
        },
    ]

    for t in templates:
        cur.execute(
            """INSERT INTO prompt_templates (prompt_id, name, description, prompt_text, category, author)
               VALUES (%s, %s, %s, %s, %s, 'Sentinel')
               ON CONFLICT (prompt_id) DO NOTHING""",
            (t["prompt_id"], t["name"], t["description"], t["prompt_text"], t["category"]),
        )


def _seed_clause_library(cur: psycopg.Cursor) -> None:  # type: ignore[type-arg]
    clauses = [
        ("cl_indemnification", "Indemnification", "Risk", "Obligation of one party to compensate the other for losses or damages arising from the agreement.", "Each Party shall indemnify, defend, and hold harmless the other Party from and against any and all claims, damages, losses, costs, and expenses arising out of or relating to any breach of this Agreement.", "Ensure mutual indemnification. Watch for one-sided indemnity that only protects the vendor.", True),
        ("cl_liability_cap", "Limitation of Liability", "Risk", "Caps the maximum financial exposure for each party under the contract.", "IN NO EVENT SHALL EITHER PARTY'S AGGREGATE LIABILITY EXCEED THE TOTAL FEES PAID OR PAYABLE UNDER THIS AGREEMENT DURING THE TWELVE (12) MONTH PERIOD PRECEDING THE CLAIM.", "Verify the cap is reasonable relative to contract value. Check for carve-outs (IP infringement, data breach, gross negligence).", True),
        ("cl_force_majeure", "Force Majeure", "General", "Excuses performance when prevented by events beyond reasonable control.", "Neither Party shall be liable for any failure or delay in performance due to causes beyond its reasonable control, including but not limited to acts of God, war, terrorism, pandemic, fire, flood, or government actions.", "Ensure both parties are covered. Check if pandemic/epidemic is explicitly listed.", False),
        ("cl_ip_ownership", "Intellectual Property", "IP", "Defines ownership of intellectual property created or used during the engagement.", "All intellectual property developed by Vendor specifically for Client under this Agreement shall be the exclusive property of Client. Vendor retains all rights to pre-existing IP and general tools.", "Clarify work product vs. background IP. Ensure client owns custom deliverables.", True),
        ("cl_confidentiality", "Confidentiality", "General", "Obligations to protect proprietary and sensitive information exchanged between parties.", "Each Party agrees to hold in confidence all Confidential Information received from the other Party and not to disclose such information to any third party without prior written consent, for a period of five (5) years following disclosure.", "Check duration (typically 3-5 years). Ensure carve-outs for legally required disclosures.", True),
        ("cl_non_compete", "Non-Compete", "General", "Restrictions on competing activities during and after the agreement.", "During the term of this Agreement and for a period of twelve (12) months thereafter, Vendor shall not directly compete with Client in the specific market segment covered by this Agreement.", "Ensure scope is narrowly defined. Overly broad non-competes may be unenforceable.", False),
        ("cl_term_convenience", "Termination for Convenience", "Risk", "Right to end the contract without cause with appropriate notice.", "Either Party may terminate this Agreement for any reason upon sixty (60) days' prior written notice to the other Party.", "Ensure both parties have this right equally. Check notice periods are reasonable (30-90 days).", True),
        ("cl_term_cause", "Termination for Cause", "Risk", "Right to end the contract due to material breach or default.", "Either Party may terminate this Agreement immediately upon written notice if the other Party materially breaches this Agreement and fails to cure such breach within thirty (30) days after receiving written notice.", "Ensure cure period exists (typically 30 days). Define what constitutes material breach.", True),
        ("cl_governing_law", "Governing Law", "General", "Specifies the jurisdiction whose laws govern the contract.", "This Agreement shall be governed by and construed in accordance with the laws of the State of California, without regard to its conflict of laws principles.", "Ensure jurisdiction is favorable. Watch for foreign governing law that may complicate enforcement.", True),
        ("cl_dispute_resolution", "Dispute Resolution", "General", "Process for resolving disagreements between the parties.", "Any dispute arising out of or relating to this Agreement shall first be submitted to mediation. If mediation is unsuccessful, the dispute shall be resolved by binding arbitration under the rules of the American Arbitration Association.", "Arbitration is typically faster but may limit discovery. Consider whether litigation is preferred for certain claim types.", False),
        ("cl_payment_terms", "Payment Terms", "Financial", "Defines payment schedules, methods, and conditions.", "Client shall pay all undisputed invoices within thirty (30) days of receipt. Invoices shall be submitted monthly in arrears with supporting documentation.", "Check payment cycle (Net 30/45/60). Look for early payment discounts and late payment penalties.", True),
        ("cl_late_payment", "Late Payment Penalties", "Financial", "Consequences for overdue payments.", "Any undisputed amounts not paid when due shall bear interest at the rate of 1.5% per month or the maximum rate permitted by law, whichever is less.", "Ensure penalty rate is reasonable. Check for right to suspend services for non-payment.", False),
        ("cl_warranty", "Warranty", "Risk", "Guarantees about the quality and performance of deliverables or services.", "Vendor warrants that all Services shall be performed in a professional and workmanlike manner in accordance with generally accepted industry standards.", "Check warranty duration. Ensure remedies for breach of warranty are adequate.", True),
        ("cl_insurance", "Insurance Requirements", "Risk", "Minimum insurance coverage required of one or both parties.", "Vendor shall maintain Commercial General Liability insurance with limits of not less than $2,000,000 per occurrence and $5,000,000 in the aggregate during the term of this Agreement.", "Verify coverage types and minimum amounts are appropriate for the engagement scope.", False),
        ("cl_data_protection", "Data Protection", "Risk", "Obligations for handling, storing, and protecting personal and sensitive data.", "Vendor shall implement and maintain appropriate technical and organizational measures to protect Personal Data against unauthorized access, loss, or destruction, in compliance with applicable Data Protection Laws.", "Ensure GDPR/CCPA compliance. Check for DPA requirements and breach notification timelines.", True),
        ("cl_audit_rights", "Audit Rights", "Procurement", "Right to inspect the other party's records and practices related to the contract.", "Client shall have the right, upon thirty (30) days' prior written notice, to audit Vendor's records, systems, and facilities to verify compliance with this Agreement, no more than once per calendar year.", "Ensure audit rights exist. Check frequency limits and who bears the cost.", True),
        ("cl_assignment", "Assignment", "General", "Restrictions on transferring contract rights or obligations to third parties.", "Neither Party may assign this Agreement without the prior written consent of the other Party, except in connection with a merger, acquisition, or sale of all or substantially all of its assets.", "Ensure assignment requires consent. Check for carve-outs for corporate restructuring.", False),
        ("cl_survival", "Survival", "General", "Clauses that remain in effect after contract termination.", "The following sections shall survive any termination or expiration of this Agreement: Confidentiality, Indemnification, Limitation of Liability, Intellectual Property, and Governing Law.", "Ensure critical protections survive termination.", False),
        ("cl_entire_agreement", "Entire Agreement", "General", "States that the written contract supersedes all prior agreements and communications.", "This Agreement constitutes the entire agreement between the Parties with respect to its subject matter and supersedes all prior negotiations, representations, and agreements.", "Standard boilerplate. Ensure no important side agreements are inadvertently voided.", False),
        ("cl_amendment", "Amendment", "General", "Process for making changes to the agreement.", "This Agreement may only be amended or modified by a written instrument signed by authorized representatives of both Parties.", "Ensure amendments require written mutual consent.", False),
    ]
    for c in clauses:
        cur.execute(
            """INSERT INTO clause_library (clause_id, name, category, description, standard_language, risk_notes, required)
               VALUES (%s, %s, %s, %s, %s, %s, %s)
               ON CONFLICT (clause_id) DO NOTHING""",
            c,
        )


def _seed_doc_templates(cur: psycopg.Cursor) -> None:  # type: ignore[type-arg]
    templates = [
        (
            "tpl_msa",
            "Master Service Agreement",
            "Standard MSA template for procurement engagements.",
            "MSA",
            "MASTER SERVICE AGREEMENT\n\nThis Master Service Agreement (\"Agreement\") is entered into as of {{effective_date}} by and between:\n\n{{client_name}} (\"Client\")\nand\n{{vendor_name}} (\"Vendor\")\n\n1. SERVICES\nVendor shall provide the services described in one or more Statements of Work executed under this Agreement.\n\n2. TERM\nThis Agreement shall commence on {{effective_date}} and continue for a period of {{term_length}}, unless earlier terminated.\n\n3. FEES AND PAYMENT\n{{payment_terms}}\n\n4. CONFIDENTIALITY\nEach Party agrees to hold in confidence all Confidential Information received from the other Party.\n\n5. INTELLECTUAL PROPERTY\n{{ip_terms}}\n\n6. LIMITATION OF LIABILITY\n{{liability_cap}}\n\n7. INDEMNIFICATION\nEach Party shall indemnify and hold harmless the other Party from claims arising from its breach of this Agreement.\n\n8. TERMINATION\nEither Party may terminate this Agreement for convenience upon {{notice_period}} days' written notice.\n\n9. GOVERNING LAW\nThis Agreement shall be governed by the laws of {{governing_law}}.\n\n10. ENTIRE AGREEMENT\nThis Agreement constitutes the entire agreement between the Parties.",
            '[\"client_name\", \"vendor_name\", \"effective_date\", \"term_length\", \"payment_terms\", \"ip_terms\", \"liability_cap\", \"notice_period\", \"governing_law\"]',
        ),
        (
            "tpl_nda",
            "Non-Disclosure Agreement",
            "Mutual NDA for protecting confidential information during negotiations.",
            "NDA",
            "MUTUAL NON-DISCLOSURE AGREEMENT\n\nThis Agreement is entered into as of {{effective_date}} between:\n\n{{party_a}} (\"Party A\")\nand\n{{party_b}} (\"Party B\")\n\n1. PURPOSE\n{{purpose}}\n\n2. CONFIDENTIAL INFORMATION\nAll non-public information disclosed by either Party in connection with the Purpose.\n\n3. OBLIGATIONS\nEach Party shall protect Confidential Information using the same degree of care it uses for its own confidential information.\n\n4. TERM\nThis Agreement shall remain in effect for {{term_length}} from the Effective Date. Confidentiality obligations survive for {{survival_period}} after termination.\n\n5. GOVERNING LAW\nGoverned by the laws of {{governing_law}}.",
            '[\"party_a\", \"party_b\", \"effective_date\", \"purpose\", \"term_length\", \"survival_period\", \"governing_law\"]',
        ),
        (
            "tpl_sow",
            "Statement of Work",
            "SOW template for defining project scope, deliverables, and timelines.",
            "SOW",
            "STATEMENT OF WORK\n\nSOW Number: {{sow_number}}\nEffective Date: {{effective_date}}\nReference Agreement: {{reference_agreement}}\n\n1. PROJECT OVERVIEW\n{{project_description}}\n\n2. SCOPE OF WORK\n{{scope}}\n\n3. DELIVERABLES\n{{deliverables}}\n\n4. TIMELINE\n{{timeline}}\n\n5. FEES\n{{fees}}\n\n6. ACCEPTANCE CRITERIA\n{{acceptance_criteria}}\n\n7. PROJECT CONTACTS\nClient PM: {{client_pm}}\nVendor PM: {{vendor_pm}}",
            '[\"sow_number\", \"effective_date\", \"reference_agreement\", \"project_description\", \"scope\", \"deliverables\", \"timeline\", \"fees\", \"acceptance_criteria\", \"client_pm\", \"vendor_pm\"]',
        ),
        (
            "tpl_po",
            "Purchase Order",
            "Standard purchase order for goods and services procurement.",
            "PO",
            "PURCHASE ORDER\n\nPO Number: {{po_number}}\nDate: {{po_date}}\n\nBuyer: {{buyer_name}}\nSupplier: {{supplier_name}}\n\nITEMS:\n{{line_items}}\n\nTOTAL: {{total_amount}}\n\nDELIVERY: {{delivery_terms}}\nPAYMENT: {{payment_terms}}\n\nSPECIAL INSTRUCTIONS:\n{{special_instructions}}",
            '[\"po_number\", \"po_date\", \"buyer_name\", \"supplier_name\", \"line_items\", \"total_amount\", \"delivery_terms\", \"payment_terms\", \"special_instructions\"]',
        ),
        (
            "tpl_amendment",
            "Contract Amendment",
            "Amendment template for modifying existing agreements.",
            "Amendment",
            "AMENDMENT TO AGREEMENT\n\nAmendment Number: {{amendment_number}}\nEffective Date: {{effective_date}}\nOriginal Agreement Date: {{original_date}}\n\nParties:\n{{party_a}} and {{party_b}}\n\nWHEREAS the Parties entered into the Original Agreement and wish to modify certain terms:\n\nAMENDMENTS:\n{{amendments}}\n\nAll other terms and conditions of the Original Agreement remain unchanged and in full force and effect.\n\nIN WITNESS WHEREOF, the Parties have executed this Amendment as of the date first written above.",
            '[\"amendment_number\", \"effective_date\", \"original_date\", \"party_a\", \"party_b\", \"amendments\"]',
        ),
    ]
    for t in templates:
        cur.execute(
            """INSERT INTO doc_templates (template_id, name, description, doc_type, template_body, variables)
               VALUES (%s, %s, %s, %s, %s, %s::jsonb)
               ON CONFLICT (template_id) DO NOTHING""",
            t,
        )
