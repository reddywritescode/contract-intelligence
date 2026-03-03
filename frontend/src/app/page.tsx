"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  analyzeContract,
  askAI,
  createAutopilotTask,
  createClause,
  createSentinelPrompt,
  createWorkflow,
  executeAutopilotTask,
  explainClause,
  getClauseAssessments,
  runClauseAssessments,
  generateFromTemplate,
  getActivity,
  getAutopilotTask,
  getAutopilotTasks,
  getAutopilotTemplates,
  getChunks,
  getClauseGaps,
  getClauseLibrary,
  getComments,
  getContractFileUrl,
  getDashboardInsights,
  getDocTemplates,
  getGeneratedDocs,
  getHighlights,
  getRun,
  getTrace,
  getSentinelPrompts,
  getSentinelSessions,
  getSuggestedQuestions,
  getWorkflow,
  getWorkflows,
  ingestContract,
  listContracts,
  listRuns,
  playbookCompare,
  deleteContract,
  deleteAllContracts,
  getReviewDecision,
  saveReviewDecision,
  generateReviewSummary,
  postComment,
  runSentinelReview,
  updateWorkflowStep,
} from "@/lib/api";
import DocumentViewer from "@/components/DocumentViewer";
import PdfViewer from "@/components/PdfViewer";
import {
  PieChart, Pie, Cell, BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, ResponsiveContainer, LineChart, Line,
} from "recharts";

/* ─── Types ───────────────────────────────────────── */

type AnalyzeResult = {
  run_id: string;
  contract_id: string;
  mode: "review" | "agent";
  summary?: { raw?: string } | Record<string, unknown>;
  answer?: string;
  answer_citations?: Array<{ chunk_id: string; section?: string; page?: number | null; excerpt?: string }>;
  risks?: Array<{ risk_id: string; risk_type: string; severity: string; reason: string }>;
  requires_approval?: boolean;
};

type ContractRow = {
  contract_id: string; filename: string; created_at: string; chunk_count: number;
  contract_type?: string | null; counterparty?: string | null;
  agreement_date?: string | null; status?: string | null; risk_level?: string | null;
  risk_score?: number | null;
};
type ChunkItem = { chunk_id: string; text: string; section?: string; page?: number | null };
type HighlightItem = { chunk_id: string; section?: string; page?: number | null; excerpt?: string };
type QASource = { idx: number; chunkId: string; text: string; page?: number; section?: string };
type QAThread = { id: string; role: "user" | "ai"; text: string; sources?: QASource[]; intent?: { tasks: string[]; reasoning: string } };
type SummaryEntry = { key: string; label: string; value: string };
type AppView = "welcome" | "documents" | "dashboard" | "detail" | "sentinel" | "autopilot" | "tools" | "clause-library" | "workflows";
type ToolSubView = "hub" | "sentinel" | "autopilot" | "doc-diff" | "doc-gen" | "redline" | "compliance" | "batch" | "export";
type ClauseLibItem = { clause_id: string; name: string; category: string; description: string; standard_language?: string; risk_notes?: string; required: boolean; tags?: string[] };
type WorkflowItem = { workflow_id: string; contract_id?: string; name: string; status: string; filename?: string; total_steps: number; completed_steps: number; created_by: string; created_at: string };
type WorkflowStepItem = { step_id: string; workflow_id: string; title: string; description?: string; assignee?: string; step_type: string; status: string; due_date?: string; completed_at?: string; step_order: number };
type WorkflowDetail = WorkflowItem & { steps: WorkflowStepItem[] };
type DocTemplate = { template_id: string; name: string; description?: string; doc_type: string; template_body: string; variables: string[] };
type GeneratedDoc = { doc_id: string; template_id?: string; template_name?: string; title: string; instructions?: string; generated_text?: string; status: string; created_at: string };
type PromptTemplate = { prompt_id: string; name: string; description: string; prompt_text: string; category: string; author: string };
type ReviewSession = { session_id: string; contract_id: string; prompt_id?: string; prompt_name?: string; filename?: string; status: string; result?: { review_text: string; prompt_name?: string } | null; created_at: string };
type TaskTemplate = { key: string; title: string; description: string; task_type: string; icon: string };
type AgentTask = { task_id: string; title: string; description: string; task_type: string; scope: string; contract_id?: string | null; filename?: string | null; status: string; progress: number; steps: { step: string; message: string; ts: string }[]; result?: { report: string; contracts_analyzed?: number } | null; created_at: string; started_at?: string | null; completed_at?: string | null };
type DetailTab = "overview" | "contents" | "lifecycle" | "analytics" | "comments" | "activity";
type ContentsPanelTab = "structure" | "review" | "keyinfo";
type HighlightMode = null | "clauses" | "risks" | "parties" | "dates";
type CommentItem = { comment_id: string; contract_id: string; chunk_id?: string | null; text: string; author: string; created_at: string };
type ActivityItem = { activity_id: string; contract_id: string; action: string; details?: string | null; actor: string; created_at: string };
type ClauseGap = { clause_key: string; name: string; description: string; required: boolean; status: string; review_status: string; count: number; excerpts: string[] };
type ClauseAssessment = { assessment_id: string; contract_id: string; chunk_id: string; clause_type: string; risk_level: string; risk_score: number; reason: string; standard_clause?: string; deviation?: string; recommendation?: string; citations: { chunk_id: string }[]; created_at: string };

/* ─── Helpers ─────────────────────────────────────── */

function wordDiff(a: string, b: string): { text: string; type: "same" | "add" | "del" }[] {
  const wa = a.split(/\s+/), wb = b.split(/\s+/);
  const bSet = new Set(wb);
  const aSet = new Set(wa);
  const result: { text: string; type: "same" | "add" | "del" }[] = [];
  let bi = 0;
  for (const w of wa) {
    if (bi < wb.length && wb[bi] === w) { result.push({ text: w, type: "same" }); bi++; }
    else if (!bSet.has(w)) { result.push({ text: w, type: "del" }); }
    else { result.push({ text: w, type: "same" }); }
  }
  for (; bi < wb.length; bi++) {
    if (!aSet.has(wb[bi])) result.push({ text: wb[bi], type: "add" });
  }
  return result;
}

const preferredOrder = ["term", "effective_date", "renewal", "renewal_terms", "termination", "termination_rights", "payment_terms", "liability", "indemnification", "confidentiality", "governing_law", "dispute_resolution"];

const CATEGORY_COLORS: Record<string, string> = {
  term: "#6366f1",
  termination: "#f59e0b",
  liability: "#ef4444",
  payment: "#3b82f6",
  governing: "#16a34a",
  confidentiality: "#8b5cf6",
  ip: "#06b6d4",
};

function categoryColorForKey(key: string): string {
  if (key.includes("term_and") || (key.includes("term") && !key.includes("terminat"))) return CATEGORY_COLORS.term;
  if (key.includes("terminat")) return CATEGORY_COLORS.termination;
  if (key.includes("liab") || key.includes("indemnit")) return CATEGORY_COLORS.liability;
  if (key.includes("payment")) return CATEGORY_COLORS.payment;
  if (key.includes("confid")) return CATEGORY_COLORS.confidentiality;
  if (key.includes("intellect") || key.includes("_ip")) return CATEGORY_COLORS.ip;
  return CATEGORY_COLORS.governing;
}

const CLAUSE_TOOLTIPS: Record<string, string> = {
  confidentiality: "Protects sensitive information shared between parties during and after the contract",
  termination: "Conditions under which either party can end the contract early",
  liability_and_indemnity: "Limits on financial exposure and obligations to cover third-party claims",
  liability: "Limits on financial exposure and obligations to cover third-party claims",
  indemnification: "Obligations to compensate the other party for losses from specified events",
  payment: "Payment amounts, schedules, invoicing terms, and late-fee provisions",
  payment_terms: "Payment amounts, schedules, invoicing terms, and late-fee provisions",
  term_and_renewal: "Contract duration, effective date, and automatic renewal conditions",
  term: "Contract duration, effective date, and automatic renewal conditions",
  intellectual_property: "Ownership and licensing of IP created, used, or shared during the agreement",
  governing_law: "Which jurisdiction's laws apply and where disputes are resolved",
  dispute_resolution: "Process for resolving disagreements — mediation, arbitration, or litigation",
  force_majeure: "Excuses performance when unforeseeable events (war, pandemic, natural disaster) occur",
  assignment: "Whether either party can transfer their rights or obligations to a third party",
  warranties: "Promises about the quality, fitness, or condition of goods or services delivered",
  insurance: "Required insurance coverage types and minimum amounts each party must carry",
  data_protection: "Obligations for handling personal data — GDPR, CCPA, or other privacy compliance",
};

const SECTION_INFO: Record<string, string> = {
  summary: "AI-generated executive overview of the contract, including key statistics (clauses found, missing items, risk count) and a reviewer decision workflow. Use this to quickly understand the contract's status before diving into details.",
  risk: "Per-clause risk assessment scored 0–100 by AI. Each detected clause type is evaluated against procurement best practices. Click any clause to highlight it in the PDF and see why it was flagged.",
  missing: "Checks whether all required standard clauses (e.g., Governing Law, Indemnification) are present in the contract. Missing clauses represent gaps that could expose your organization to legal or financial risk.",
  compliance: "Side-by-side comparison of every detected clause against your organization's Clause Library standards. Filter by status, review deviations, accept compliant clauses, or compare vendor text to playbook language inline.",
  keywords: "Pattern-based scan for high-risk keywords and phrases (e.g., 'unlimited liability', 'auto-renew', 'sole discretion') that may indicate unfavorable terms, even when the AI clause assessment doesn't flag them.",
};

function prettify(k: string): string { return k.replace(/[_\-]+/g, " ").replace(/\b\w/g, c => c.toUpperCase()); }
function normalizeKey(k: string): string { return k.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, ""); }
function compact(v: string, max = 280): string { const s = v.replace(/\s+/g, " ").trim(); return s.length <= max ? s : s.slice(0, max - 1) + "\u2026"; }

function formatMarkdown(md: string): string {
  let html = md
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/^### (.+)$/gm, '<h3 style="margin:16px 0 8px;font-size:15px">$1</h3>')
    .replace(/^## (.+)$/gm, '<h2 style="margin:20px 0 10px;font-size:17px">$1</h2>')
    .replace(/^# (.+)$/gm, '<h1 style="margin:24px 0 12px;font-size:19px">$1</h1>')
    .replace(/^---$/gm, '<hr style="border:none;border-top:1px solid var(--border);margin:16px 0"/>')
    .replace(/^- (.+)$/gm, '<li style="margin:2px 0;list-style:disc;margin-left:20px">$1</li>')
    .replace(/^\d+\. (.+)$/gm, '<li style="margin:2px 0;list-style:decimal;margin-left:20px">$1</li>');

  // Simple markdown table handling
  const lines = html.split("\n");
  let inTable = false;
  const processed: string[] = [];
  for (const line of lines) {
    if (line.trim().startsWith("|") && line.trim().endsWith("|")) {
      if (line.replace(/[|\-\s:]/g, "").length === 0) { continue; } // separator row
      const cells = line.split("|").filter(c => c.trim()).map(c => c.trim());
      if (!inTable) {
        processed.push('<table class="sentinel__mdTable"><thead><tr>');
        cells.forEach(c => processed.push(`<th>${c}</th>`));
        processed.push("</tr></thead><tbody>");
        inTable = true;
      } else {
        processed.push("<tr>");
        cells.forEach(c => processed.push(`<td>${c}</td>`));
        processed.push("</tr>");
      }
    } else {
      if (inTable) { processed.push("</tbody></table>"); inTable = false; }
      processed.push(line);
    }
  }
  if (inTable) processed.push("</tbody></table>");
  html = processed.join("\n").replace(/\n\n+/g, "<br/><br/>").replace(/\n/g, "<br/>");
  return html;
}

function parseSummary(s?: AnalyzeResult["summary"]): Record<string, unknown> | null {
  if (!s || typeof s !== "object") return null;
  if ("raw" in s) {
    const raw = String(s.raw || "").trim();
    if (!raw) return null;
    try { const p = JSON.parse(raw); return typeof p === "object" && p ? p as Record<string, unknown> : null; } catch { return { summary: raw }; }
  }
  return s as Record<string, unknown>;
}

function flattenNode(v: unknown, path: string[], entries: SummaryEntry[], byKey: Record<string, string>): void {
  if (v == null) return;
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
    const rk = path.join("_") || "summary"; const k = normalizeKey(rk);
    entries.push({ key: k, label: prettify(rk), value: compact(String(v)) });
    if (!byKey[k]) byKey[k] = String(v);
    return;
  }
  if (Array.isArray(v)) {
    if (!v.length) return;
    if (v.every(i => typeof i === "string" || typeof i === "number" || typeof i === "boolean")) {
      const rk = path.join("_") || "items"; const k = normalizeKey(rk);
      const t = compact(v.map(String).join("; "));
      entries.push({ key: k, label: prettify(rk), value: t }); if (!byKey[k]) byKey[k] = t; return;
    }
    v.slice(0, 5).forEach((i, idx) => flattenNode(i, [...path, `item_${idx + 1}`], entries, byKey));
    return;
  }
  if (typeof v === "object") Object.entries(v as Record<string, unknown>).forEach(([k2, v2]) => flattenNode(v2, [...path, k2], entries, byKey));
}

function normalizeSummary(s?: AnalyzeResult["summary"]): { entries: SummaryEntry[]; byKey: Record<string, string> } {
  const obj = parseSummary(s); if (!obj) return { entries: [], byKey: {} };
  const entries: SummaryEntry[] = [], byKey: Record<string, string> = {};
  flattenNode(obj, [], entries, byKey);
  const seen = new Set<string>();
  const uniq = entries.filter(e => { const t = `${e.key}::${e.value.slice(0, 16)}`; if (seen.has(t)) return false; seen.add(t); return true; });
  uniq.sort((a, b) => {
    const ai = preferredOrder.indexOf(a.key), bi = preferredOrder.indexOf(b.key);
    if (ai !== -1 || bi !== -1) { if (ai === -1) return 1; if (bi === -1) return -1; return ai - bi; }
    return a.label.localeCompare(b.label);
  });
  return { entries: uniq.slice(0, 14), byKey };
}

function riskWeight(sev?: string): number { const s = (sev || "").toLowerCase(); return s === "high" ? 28 : s === "medium" ? 16 : 8; }
function riskTone(sev?: string): "high" | "medium" | "low" { const s = (sev || "").toLowerCase(); return s === "high" ? "high" : s === "medium" ? "medium" : "low"; }

function buildActions(risks: AnalyzeResult["risks"]): string[] {
  if (!risks?.length) return ["No critical risks \u2014 proceed with standard review.", "Confirm obligations before approval.", "Store for renewal tracking."];
  const map: Record<string, string> = {
    unlimited_liability: "Route to legal for liability cap redline.",
    auto_renewal: "Create renewal reminder task.",
    termination_rigidity: "Request termination-for-convenience clause.",
    missing_governing_law: "Add governing law language.",
    long_payment_cycle: "Escalate payment terms to finance.",
  };
  const out: string[] = [];
  risks.forEach(r => { const m = map[normalizeKey(r.risk_type)] || `Review ${prettify(r.risk_type)} with legal.`; if (!out.includes(m)) out.push(m); });
  out.push("Share evidence with procurement owner.");
  return out.slice(0, 5);
}

function barClass(v: number) { return v >= 50 ? "catBar__fill--high" : v >= 30 ? "catBar__fill--medium" : v >= 15 ? "catBar__fill--low" : "catBar__fill--neutral"; }

/* ─── Component ───────────────────────────────────── */

export default function HomePage() {
  /* ─── URL Routing ─── */
  function viewFromPath(path: string): { view: AppView; contractId?: string } {
    if (path.startsWith("/documents")) return { view: "documents" };
    if (path.startsWith("/clause-library")) return { view: "clause-library" };
    if (path.startsWith("/workflows")) return { view: "workflows" };
    if (path.startsWith("/sentinel")) return { view: "tools" };
    if (path.startsWith("/autopilot")) return { view: "tools" };
    if (path.startsWith("/tools")) return { view: "tools" };
    if (path.startsWith("/insights")) return { view: "dashboard" };
    if (path.startsWith("/contracts/")) return { view: "detail", contractId: path.split("/")[2] };
    return { view: "welcome" };
  }

  function pathFromView(v: AppView, cId?: string): string {
    if (v === "documents") return "/documents";
    if (v === "clause-library") return "/clause-library";
    if (v === "workflows") return "/workflows";
    if (v === "sentinel") return "/sentinel";
    if (v === "autopilot") return "/autopilot";
    if (v === "tools") return "/tools";
    if (v === "dashboard") return "/insights";
    if (v === "detail" && cId) return `/contracts/${cId}`;
    return "/";
  }

  /* STATE: Navigation */
  const [view, setView] = useState<AppView>("welcome");
  const [detailTab, setDetailTab] = useState<DetailTab>("contents");
  const [panelTab, setPanelTab] = useState<ContentsPanelTab>("review");
  const [toolSubView, setToolSubView] = useState<ToolSubView>("hub");

  /* STATE: Data */
  const [contracts, setContracts] = useState<ContractRow[]>([]);
  const [contractId, setContractId] = useState("");
  const [chunks, setChunks] = useState<ChunkItem[]>([]);
  const [highlights, setHighlights] = useState<Record<string, HighlightItem[]>>({});
  const [result, setResult] = useState<AnalyzeResult | null>(null);
  const [suggestedQs, setSuggestedQs] = useState<string[]>([]);

  /* STATE: AI Panel */
  const [showAI, setShowAI] = useState(false);
  const [highlightMode, setHighlightMode] = useState<HighlightMode>(null);
  const [highlightIndex, setHighlightIndex] = useState(0);
  const [activeClauseGroup, setActiveClauseGroup] = useState<string | null>(null);
  const [hlPulse, setHlPulse] = useState(false);
  const [thread, setThread] = useState<QAThread[]>([]);
  const [query, setQuery] = useState("");
  const [chatScope, setChatScope] = useState<"document" | "all">("document");
  const [expandedSources, setExpandedSources] = useState<string | null>(null);
  const [askAiSources, setAskAiSources] = useState<{ chunkId: string; text: string; page?: number; section?: string }[]>([]);
  const [askAiFocusIdx, setAskAiFocusIdx] = useState(0);

  /* STATE: loading, error */
  const [loading, setLoading] = useState(false);
  const [loadingLabel, setLoadingLabel] = useState("");
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");

  /* STATE: auto-analysis progress */
  const [analysisPhase, setAnalysisPhase] = useState("");
  const [analysisProgress, setAnalysisProgress] = useState(0);

  /* STATE: Autopilot Agent */
  const [apTemplates, setApTemplates] = useState<TaskTemplate[]>([]);
  const [apTasks, setApTasks] = useState<AgentTask[]>([]);
  const [apSelectedTask, setApSelectedTask] = useState<AgentTask | null>(null);
  const [apCustomTitle, setApCustomTitle] = useState("");
  const [apCustomDesc, setApCustomDesc] = useState("");
  const [apCustomContract, setApCustomContract] = useState("");
  const [apExecuting, setApExecuting] = useState<string | null>(null);
  const [showCustomTask, setShowCustomTask] = useState(false);

  /* STATE: Sentinel AI Assistant */
  const [sentinelPrompts, setSentinelPrompts] = useState<PromptTemplate[]>([]);
  const [sentinelSessions, setSentinelSessions] = useState<ReviewSession[]>([]);
  const [sentinelInstruction, setSentinelInstruction] = useState("");
  const [sentinelSelectedPrompt, setSentinelSelectedPrompt] = useState<PromptTemplate | null>(null);
  const [sentinelSelectedContract, setSentinelSelectedContract] = useState<string>("");
  const [sentinelReviewResult, setSentinelReviewResult] = useState<string>("");
  const [sentinelReviewing, setSentinelReviewing] = useState(false);
  const [showPromptLib, setShowPromptLib] = useState(false);
  const [promptFilter, setPromptFilter] = useState("All");
  const [showNewPrompt, setShowNewPrompt] = useState(false);
  const [newPromptName, setNewPromptName] = useState("");
  const [newPromptDesc, setNewPromptDesc] = useState("");
  const [newPromptText, setNewPromptText] = useState("");
  const [newPromptCat, setNewPromptCat] = useState("Custom");
  const sentinelFileRef = useRef<HTMLInputElement>(null);

  /* STATE: Clause Library */
  const [clauseLib, setClauseLib] = useState<ClauseLibItem[]>([]);
  const [clauseLibFilter, setClauseLibFilter] = useState("All");
  const [clauseLibSearch, setClauseLibSearch] = useState("");
  const [clauseLibExpanded, setClauseLibExpanded] = useState<string | null>(null);
  const [showAddClause, setShowAddClause] = useState(false);
  const [newClauseName, setNewClauseName] = useState("");
  const [newClauseDesc, setNewClauseDesc] = useState("");
  const [newClauseCat, setNewClauseCat] = useState("General");
  const [newClauseLang, setNewClauseLang] = useState("");
  const [newClauseRisk, setNewClauseRisk] = useState("");

  /* STATE: Workflows */
  const [workflows, setWorkflows] = useState<WorkflowItem[]>([]);
  const [selectedWorkflow, setSelectedWorkflow] = useState<WorkflowDetail | null>(null);
  const [showNewWorkflow, setShowNewWorkflow] = useState(false);

  /* STATE: Doc Templates + Generation */
  const [docTemplates, setDocTemplates] = useState<DocTemplate[]>([]);
  const [generatedDocs, setGeneratedDocs] = useState<GeneratedDoc[]>([]);
  const [selectedTemplate, setSelectedTemplate] = useState<DocTemplate | null>(null);
  const [genInstructions, setGenInstructions] = useState("");
  const [genResult, setGenResult] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);

  /* STATE: Risk filter */
  const [hideLowRisk, setHideLowRisk] = useState(true);

  /* STATE: Clause Risk Assessments */
  const [clauseAssessments, setClauseAssessments] = useState<ClauseAssessment[]>([]);
  const [selectedAssessment, setSelectedAssessment] = useState<ClauseAssessment | null>(null);
  const [assessmentRunning, setAssessmentRunning] = useState(false);
  const [focusMode, setFocusMode] = useState(false);

  /* STATE: Dark mode */
  const [darkMode, setDarkMode] = useState(false);
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", darkMode ? "dark" : "light");
  }, [darkMode]);

  /* STATE: Debug/Trace Mode */
  const [showDebug, setShowDebug] = useState(false);
  const [debugSteps, setDebugSteps] = useState<{ step: number; name: string; ts: string; details: Record<string, unknown>; status: string }[]>([]);
  const [debugLoading, setDebugLoading] = useState(false);

  /* STATE: Review Decision & AI Summary */
  const [reviewDecision, setReviewDecision] = useState<string>("pending");
  const [reviewerNotes, setReviewerNotes] = useState("");
  const [aiSummary, setAiSummary] = useState<string>("");
  const [overallScore, setOverallScore] = useState<number | null>(null);
  const [reviewDecidedAt, setReviewDecidedAt] = useState<string | null>(null);
  const [reviewDecidedBy, setReviewDecidedBy] = useState<string | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [savingDecision, setSavingDecision] = useState(false);
  type CollapsedSections = { summary: boolean; risk: boolean; missing: boolean; compliance: boolean; keywords: boolean };
  const [collapsed, setCollapsed] = useState<CollapsedSections>({ summary: false, risk: false, missing: false, compliance: true, keywords: true });

  /* STATE: Clause annotation */
  const [annotatingClause, setAnnotatingClause] = useState<string | null>(null);
  const [annotationText, setAnnotationText] = useState("");
  const [savedAnnotations, setSavedAnnotations] = useState<Record<string, string>>({});

  /* STATE: Playbook comparison */
  const [playbookData, setPlaybookData] = useState<{ vendor_clause: string; playbook_clause: string; deviations: { type: string; description: string }[]; risk_level: string; summary: string } | null>(null);
  const [playbookLoading, setPlaybookLoading] = useState(false);

  /* STATE: Dashboard Insights */
  type InsightsData = {
    total_contracts: number;
    type_distribution: { contract_type: string; count: number }[];
    status_distribution: { status: string; count: number }[];
    risk_distribution: { risk_level: string; count: number }[];
    counterparty_distribution: { counterparty: string; count: number }[];
    contracts_over_time: { month: string; count: number }[];
    missing_terms: { clause: string; missing_count: number }[];
    recent_contracts: { contract_id: string; filename: string; contract_type?: string; counterparty?: string; status?: string; risk_level?: string }[];
    activity_summary: { action: string; count: number }[];
  };
  const [insights, setInsights] = useState<InsightsData | null>(null);
  const [insightsLoading, setInsightsLoading] = useState(false);
  const [insightsCategory, setInsightsCategory] = useState("overview");

  /* STATE: Comments, Activity, Clause Library */
  const [comments, setComments] = useState<CommentItem[]>([]);
  const [newComment, setNewComment] = useState("");
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [clauseGaps, setClauseGaps] = useState<ClauseGap[]>([]);
  const [explainText, setExplainText] = useState("");
  const [explainLoading, setExplainLoading] = useState(false);
  const [clauseReviewStatus, setClauseReviewStatus] = useState<Record<string, string>>({});
  const [complianceFilter, setComplianceFilter] = useState<"all" | "detected" | "missing" | "needs_review">("all");
  const [inlineCompareKey, setInlineCompareKey] = useState<string | null>(null);
  const [openSectionInfo, setOpenSectionInfo] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState(false);

  /* STATE: Document filters */
  const [filterType, setFilterType] = useState("");
  const [filterCounterparty, setFilterCounterparty] = useState("");
  const [filterStatus, setFilterStatus] = useState("");
  const [filterRisk, setFilterRisk] = useState("");
  const [filterDateFrom, setFilterDateFrom] = useState("");
  const [filterDateTo, setFilterDateTo] = useState("");
  const [filterSearch, setFilterSearch] = useState("");
  const [showFilters, setShowFilters] = useState(true);

  /* Scroll refs */
  const scrollToChunkRef = useRef<string | null>(null);

  /* DERIVED */
  const selectedContract = useMemo(() => contracts.find(c => c.contract_id === contractId) || null, [contracts, contractId]);
  const summaryView = useMemo(() => normalizeSummary(result?.summary), [result?.summary]);
  const risks = result?.risks || [];

  const overallRisk = useMemo(() => Math.min(100, 18 + risks.reduce((a, r) => a + riskWeight(r.severity), 0)), [risks]);
  const riskLevel = overallRisk >= 75 ? "High" : overallRisk >= 45 ? "Moderate" : "Low";

  const categoryScores = useMemo(() => {
    const b: Record<string, number> = { Liability: 12, Termination: 12, Renewal: 12, Payment: 12, Compliance: 12 };
    risks.forEach(r => {
      const t = r.risk_type.toLowerCase(), w = riskWeight(r.severity);
      if (t.includes("liabil") || t.includes("indemn")) b.Liability = Math.min(100, b.Liability + w);
      else if (t.includes("terminat")) b.Termination = Math.min(100, b.Termination + w);
      else if (t.includes("renew")) b.Renewal = Math.min(100, b.Renewal + w);
      else if (t.includes("payment")) b.Payment = Math.min(100, b.Payment + w);
      else b.Compliance = Math.min(100, b.Compliance + w);
    });
    return b;
  }, [risks]);

  const actionItems = useMemo(() => buildActions(result?.risks), [result?.risks]);
  const timeline = useMemo(() => ({
    effective: summaryView.byKey.effective_date || summaryView.byKey.term || null,
    renewal: summaryView.byKey.renewal_terms || summaryView.byKey.renewal || null,
    termination: summaryView.byKey.termination_rights || summaryView.byKey.termination || null,
    governingLaw: summaryView.byKey.governing_law || null,
  }), [summaryView.byKey]);

  const highlightedChunkIds = useMemo(() => {
    if (!highlightMode) return new Set<string>();
    if (highlightMode === "clauses") {
      const ids = new Set<string>();
      if (activeClauseGroup && highlights[activeClauseGroup]) {
        highlights[activeClauseGroup].forEach(i => ids.add(i.chunk_id));
      }
      return ids;
    }
    if (highlightMode === "risks") {
      const ids = new Set<string>();
      risks.forEach(r => {
        Object.entries(highlights).forEach(([groupKey, items]) => {
          const rt = r.risk_type.toLowerCase();
          if ((groupKey.includes("liabil") && (rt.includes("liabil") || rt.includes("unlimited"))) ||
              (groupKey.includes("terminat") && rt.includes("terminat")) ||
              (groupKey.includes("renewal") && (rt.includes("renew") || rt.includes("auto"))) ||
              (groupKey.includes("payment") && rt.includes("payment")) ||
              (groupKey.includes("governing") && rt.includes("governing")))
            items.forEach(i => ids.add(i.chunk_id));
        });
      });
      return ids;
    }
    if (highlightMode === "parties") {
      const ids = new Set<string>();
      const partyTerms = ["buyer", "seller", "supplier", "party", "parties", "between", "signatory"];
      chunks.forEach(c => { if (partyTerms.some(t => c.text.toLowerCase().includes(t))) ids.add(c.chunk_id); });
      return ids;
    }
    if (highlightMode === "dates") {
      const ids = new Set<string>();
      const dateRx = /\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2},?\s+\d{4}|\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}|\b\d{4}[\/\-]\d{2}[\/\-]\d{2}/i;
      chunks.forEach(c => { if (dateRx.test(c.text)) ids.add(c.chunk_id); });
      return ids;
    }
    return new Set<string>();
  }, [highlightMode, activeClauseGroup, highlights, risks, chunks]);

  const highlightedList = useMemo(() =>
    chunks.filter(c => highlightedChunkIds.has(c.chunk_id)),
  [chunks, highlightedChunkIds]);

  const askAiHighlightList = useMemo(() =>
    askAiSources.map(src => chunks.find(c => c.chunk_id === src.chunkId)).filter(Boolean) as typeof chunks,
  [askAiSources, chunks]);

  const isAskAiActive = askAiSources.length > 0;

  const effectiveHighlightedList = isAskAiActive ? askAiHighlightList : highlightedList;
  const effectiveHighlightMode: HighlightMode = isAskAiActive ? "clauses" : highlightMode;
  const effectiveHighlightIndex = isAskAiActive ? askAiFocusIdx : highlightIndex;
  const effectiveCategoryColor = isAskAiActive ? "#3b82f6" : (activeClauseGroup ? categoryColorForKey(activeClauseGroup) : undefined);
  const effectiveGroupName = isAskAiActive ? "Ask AI" : (activeClauseGroup ? prettify(activeClauseGroup) : undefined);
  const effectiveAssessment = isAskAiActive ? null : (activeClauseGroup ? clauseAssessments.find(a => a.clause_type === activeClauseGroup) ?? null : null);

  const clauseGroups = useMemo(() => {
    const groups: { name: string; key: string; items: HighlightItem[] }[] = [];
    for (const [k, items] of Object.entries(highlights)) {
      if (items.length > 0) groups.push({ name: prettify(k), key: k, items });
    }
    return groups;
  }, [highlights]);

  const sectionTree = useMemo(() => {
    const seen = new Set<string>();
    return chunks
      .filter(c => c.section && !seen.has(c.section) && (seen.add(c.section), true))
      .map(c => ({ section: c.section!, page: c.page, chunkId: c.chunk_id }));
  }, [chunks]);

  /* ─── Data Loading ──────────────────────────────── */

  const refreshContracts = useCallback(async (filters?: Record<string, string>) => {
    try { const d = await listContracts(filters); setContracts((d.contracts || []) as ContractRow[]); } catch { /* ignore */ }
  }, []);

  const applyFilters = useCallback(() => {
    const f: Record<string, string> = {};
    if (filterType) f.contract_type = filterType;
    if (filterCounterparty) f.counterparty = filterCounterparty;
    if (filterStatus) f.status = filterStatus;
    if (filterRisk) f.risk_level = filterRisk;
    if (filterDateFrom) f.date_from = filterDateFrom;
    if (filterDateTo) f.date_to = filterDateTo;
    if (filterSearch) f.search = filterSearch;
    void refreshContracts(f);
  }, [filterType, filterCounterparty, filterStatus, filterRisk, filterDateFrom, filterDateTo, filterSearch, refreshContracts]);

  const clearFilters = useCallback(() => {
    setFilterType(""); setFilterCounterparty(""); setFilterStatus("");
    setFilterRisk(""); setFilterDateFrom(""); setFilterDateTo(""); setFilterSearch("");
    void refreshContracts();
  }, [refreshContracts]);

  const loadContractData = useCallback(async (id: string): Promise<{ assessmentCount: number; chunkCount: number }> => {
    const [cd, hd, qd, rd, cmt, act, cg, ca, rv] = await Promise.all([
      getChunks(id), getHighlights(id), getSuggestedQuestions(id), listRuns(id),
      getComments(id).catch(() => ({ comments: [] })),
      getActivity(id).catch(() => ({ activity: [] })),
      getClauseGaps(id).catch(() => ({ clause_library: [] })),
      getClauseAssessments(id).catch(() => ({ assessments: [] })),
      getReviewDecision(id).catch(() => ({ decision: "pending", reviewer_notes: null, ai_summary: null, overall_score: null, decided_at: null, decided_by: null })),
    ]);
    const chunks = (cd.chunks || []) as ChunkItem[];
    const assessments = (ca.assessments || []) as ClauseAssessment[];
    setChunks(chunks);
    setHighlights((hd.highlights || {}) as Record<string, HighlightItem[]>);
    setSuggestedQs((qd.questions || []) as string[]);
    setComments((cmt.comments || []) as CommentItem[]);
    setActivity((act.activity || []) as ActivityItem[]);
    setClauseGaps((cg.clause_library || []) as ClauseGap[]);
    setClauseAssessments(assessments);
    setReviewDecision(rv.decision || "pending");
    setReviewerNotes(rv.reviewer_notes || "");
    setAiSummary(rv.ai_summary || "");
    setOverallScore(rv.overall_score ?? null);
    setReviewDecidedAt(rv.decided_at || null);
    setReviewDecidedBy(rv.decided_by || null);
    const runs = (rd.runs || []) as Array<{ run_id: string }>;
    if (runs.length > 0) {
      const latest = await getRun(runs[0].run_id);
      setResult({ run_id: latest.run_id, contract_id: latest.contract_id, mode: latest.mode, summary: latest.summary, answer: latest.answer, answer_citations: latest.answer_citations, risks: latest.risks, requires_approval: latest.requires_approval });
    } else { setResult(null); }
    return { assessmentCount: assessments.length, chunkCount: chunks.length };
  }, []);

  useEffect(() => { void refreshContracts(); }, [refreshContracts]);
  useEffect(() => { if (view === "documents") applyFilters(); }, [filterType, filterStatus, filterRisk, filterDateFrom, filterDateTo]); // eslint-disable-line react-hooks/exhaustive-deps

  // URL routing effects are placed after openContract definition below

  useEffect(() => {
    if (view === "autopilot" || (view === "tools" && toolSubView === "autopilot")) {
      getAutopilotTemplates().then(d => setApTemplates(d.templates || [])).catch(() => {});
      getAutopilotTasks().then(d => setApTasks(d.tasks || [])).catch(() => {});
      if (contracts.length === 0) void refreshContracts();
    }
  }, [view, toolSubView]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (view === "sentinel" || (view === "tools" && toolSubView === "sentinel")) {
      getSentinelPrompts().then(d => setSentinelPrompts(d.prompts || [])).catch(() => {});
      getSentinelSessions().then(d => setSentinelSessions(d.sessions || [])).catch(() => {});
      if (contracts.length === 0) void refreshContracts();
    }
  }, [view, toolSubView]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (view === "clause-library") {
      getClauseLibrary().then(d => setClauseLib(d.clauses || [])).catch(() => {});
    }
  }, [view]);

  useEffect(() => {
    if (view === "workflows") {
      getWorkflows().then(d => setWorkflows(d.workflows || [])).catch(() => {});
      if (contracts.length === 0) void refreshContracts();
    }
  }, [view]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (view === "tools" && (toolSubView === "doc-gen" || toolSubView === "hub")) {
      getDocTemplates().then(d => setDocTemplates(d.templates || [])).catch(() => {});
      getGeneratedDocs().then(d => setGeneratedDocs(d.docs || [])).catch(() => {});
    }
  }, [view, toolSubView]);

  useEffect(() => {
    if (view === "dashboard") {
      setInsightsLoading(true);
      getDashboardInsights()
        .then(data => setInsights(data))
        .catch(() => setInsights(null))
        .finally(() => setInsightsLoading(false));
    }
  }, [view]);

  /* ─── Actions ───────────────────────────────────── */

  const openContract = useCallback(async (id: string) => {
    setContractId(id);
    setView("detail");
    setDetailTab("contents");
    setHighlightMode(null);
    setHighlightIndex(0);
    setActiveClauseGroup(null);
    setThread([]);
    setQuery("");
    setError("");
    setResult(null);
    setChunks([]);
    const path = `/contracts/${id}`;
    if (window.location.pathname !== path) {
      window.history.pushState({ view: "detail", contractId: id }, "", path);
    }
    setLoading(true); setLoadingLabel("loading");
    try { await loadContractData(id); } catch (err) { setError(err instanceof Error ? err.message : "Load failed"); }
    finally { setLoading(false); setLoadingLabel(""); }
  }, [loadContractData]);

  // Sync URL on initial load (handle deep links like /contracts/ctr_xxx)
  useEffect(() => {
    const { view: urlView, contractId: urlContractId } = viewFromPath(window.location.pathname);
    if (urlView === "detail" && urlContractId) {
      void openContract(urlContractId);
    } else if (urlView !== "welcome") {
      setView(urlView);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Handle browser back/forward
  useEffect(() => {
    const handlePopState = () => {
      const { view: urlView, contractId: urlContractId } = viewFromPath(window.location.pathname);
      if (urlView === "detail" && urlContractId) {
        void openContract(urlContractId);
      } else {
        setView(urlView);
        setHighlightMode(null);
        setHighlightIndex(0);
      }
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [openContract]);

  const runAutoAnalysis = useCallback(async (cid: string) => {
    const phases = [
      { label: "Extracting text & splitting into sections…", pct: 15 },
      { label: "Classifying clauses…", pct: 35 },
      { label: "Assessing risks & obligations…", pct: 60 },
      { label: "Generating summary…", pct: 80 },
      { label: "Finalizing analysis…", pct: 95 },
    ];
    setAnalysisPhase(phases[0].label);
    setAnalysisProgress(phases[0].pct);
    let phaseIdx = 0;
    const ticker = setInterval(() => {
      phaseIdx = Math.min(phaseIdx + 1, phases.length - 1);
      setAnalysisPhase(phases[phaseIdx].label);
      setAnalysisProgress(phases[phaseIdx].pct);
    }, 3500);
    try {
      setError(""); setLoading(true); setLoadingLabel("analyze");
      const out = await analyzeContract(cid, { mode: "agent", tasks: ["summary", "qa", "risk"], question: "Summarize this contract and flag all risks" });
      setResult(out as AnalyzeResult);
      setThread(prev => [...prev, { id: out.run_id, role: "ai", text: out.answer || "Analysis complete." }]);
      const { assessmentCount, chunkCount } = await loadContractData(cid);
      if (assessmentCount === 0 && chunkCount > 0) {
        setAnalysisProgress(90);
        setAnalysisPhase("Running per-clause risk assessment…");
        try {
          const resp = await runClauseAssessments(cid);
          setClauseAssessments((resp.assessments || []) as ClauseAssessment[]);
        } catch { /* best-effort fallback */ }
        await loadContractData(cid);
      }
      setAnalysisProgress(100);
      setAnalysisPhase("Analysis complete");
      setTimeout(() => { setAnalysisPhase(""); setAnalysisProgress(0); }, 1500);
    } catch (err) { setError(err instanceof Error ? err.message : "Analysis failed"); setAnalysisPhase(""); setAnalysisProgress(0); }
    finally { clearInterval(ticker); setLoading(false); setLoadingLabel(""); }
  }, [loadContractData]);

  const onUpload = useCallback(async (f: File) => {
    setError(""); setLoading(true); setLoadingLabel("upload");
    setAnalysisPhase("Uploading & indexing document…");
    setAnalysisProgress(5);
    try {
      const ing = await ingestContract(f);
      await refreshContracts();
      await openContract(ing.contract_id);
      await runAutoAnalysis(ing.contract_id);
    } catch (err) { setError(err instanceof Error ? err.message : "Upload failed"); setAnalysisPhase(""); setAnalysisProgress(0); }
  }, [refreshContracts, openContract, runAutoAnalysis]);

  const runPrompt = useCallback(async (prompt: string) => {
    if (!contractId || !prompt.trim()) return;
    setError(""); setLoading(true); setLoadingLabel("analyze");
    setThread(prev => [...prev, { id: `u-${Date.now()}`, role: "user", text: prompt }]);
    setQuery("");
    try {
      const out = await askAI(contractId, prompt);
      if (out.summary || out.risks) {
        setResult(prev => ({
          ...(prev || { run_id: out.run_id, contract_id: contractId, mode: "agent" }),
          run_id: out.run_id,
          summary: out.summary ?? prev?.summary,
          answer: out.answer ?? prev?.answer,
          answer_citations: out.answer_citations ?? prev?.answer_citations ?? [],
          risks: out.risks?.length ? out.risks : prev?.risks ?? [],
        } as AnalyzeResult));
      }

      // --- Build readable text for non-QA routes ---
      let chatText = out.answer || "";
      const routed = out.intent?.tasks || [];

      if (!chatText && routed.includes("risk") && out.risks?.length) {
        const lines = [`Found **${out.risks.length} risk${out.risks.length > 1 ? "s" : ""}** in this contract:\n`];
        for (const r of out.risks) {
          const sev = (r.severity || "").toUpperCase();
          const badge = sev === "HIGH" ? "\u{1F534}" : sev === "MEDIUM" ? "\u{1F7E0}" : "\u{1F7E2}";
          const label = (r.risk_type || "").replace(/_/g, " ");
          lines.push(`${badge} **${label}** (${sev})\n${r.reason}`);
        }
        chatText = lines.join("\n\n");
      }

      if (!chatText && routed.includes("summary") && out.summary) {
        const parsed = typeof out.summary === "object" ? (out.summary.parsed || out.summary) : null;
        if (parsed && typeof parsed === "object") {
          const parts: string[] = ["Here\u2019s a summary of this contract:\n"];
          const p = parsed.parties;
          if (p) parts.push(`**Parties:** ${p.buyer || "?"} (Buyer) & ${p.supplier || "?"} (Supplier)`);
          if (parsed.effective_date) parts.push(`**Effective Date:** ${parsed.effective_date}`);
          if (parsed.term) parts.push(`**Term:** ${parsed.term}`);
          if (parsed.renewal_terms) parts.push(`**Renewal:** ${parsed.renewal_terms}`);
          if (parsed.payment_terms) parts.push(`**Payment Terms:** ${parsed.payment_terms}`);
          if (parsed.governing_law) parts.push(`**Governing Law:** ${parsed.governing_law}`);
          if (parsed.confidentiality) parts.push(`**Confidentiality:** ${parsed.confidentiality}`);
          if (parsed.liability) parts.push(`**Liability:** ${parsed.liability}`);
          if (parsed.indemnification) parts.push(`**Indemnification:** ${parsed.indemnification}`);
          const obls = parsed.key_obligations;
          if (Array.isArray(obls) && obls.length) {
            parts.push(`\n**Key Obligations:**`);
            obls.slice(0, 5).forEach((o: string) => parts.push(`\u2022 ${o}`));
          }
          chatText = parts.join("\n");
        } else {
          chatText = String(out.summary.raw || out.summary).slice(0, 800);
        }
      }

      if (!chatText) chatText = "Analysis complete. See the Review panel for details.";

      // --- Build sources: prefer QA citations, fall back to risk citation chunks ---
      let sources: QASource[] = (out.answer_citations || [])
        .slice(0, 5)
        .map((c: { chunk_id?: string; text?: string; page?: number; section?: string }, i: number) => ({
          idx: i + 1,
          chunkId: c.chunk_id || "",
          text: (c.text || "").slice(0, 200),
          page: c.page ?? undefined,
          section: c.section,
        }));

      if (sources.length === 0 && out.risks?.length) {
        const seen = new Set<string>();
        const riskChunkIds: string[] = [];
        for (const r of out.risks) {
          for (const cid of (r.citation_chunk_ids || [])) {
            if (!seen.has(cid)) { seen.add(cid); riskChunkIds.push(cid); }
          }
        }
        sources = riskChunkIds.slice(0, 5).map((cid, i) => {
          const ch = chunks.find(c => c.chunk_id === cid);
          return {
            idx: i + 1,
            chunkId: cid,
            text: ch ? ch.text.slice(0, 200) : "",
            page: ch?.page ?? undefined,
            section: ch?.section,
          };
        });
      }

      if (sources.length === 0 && out.summary?.source_chunk_ids?.length) {
        sources = (out.summary.source_chunk_ids as string[]).slice(0, 5).map((cid: string, i: number) => {
          const ch = chunks.find(c => c.chunk_id === cid);
          return {
            idx: i + 1,
            chunkId: cid,
            text: ch ? ch.text.slice(0, 200) : "",
            page: ch?.page ?? undefined,
            section: ch?.section,
          };
        });
      }

      const intentInfo = out.intent ? { tasks: out.intent.tasks, reasoning: out.intent.reasoning } : undefined;
      setThread(prev => [...prev, {
        id: out.run_id,
        role: "ai",
        text: chatText,
        sources: sources.length > 0 ? sources : undefined,
        intent: intentInfo,
      }]);
      await loadContractData(contractId);
    } catch (err) { setError(err instanceof Error ? err.message : "Analysis failed"); }
    finally { setLoading(false); setLoadingLabel(""); }
  }, [contractId, loadContractData, chunks]);

  const toggleHighlight = useCallback((m: HighlightMode) => {
    setAskAiSources([]);
    setAskAiFocusIdx(0);
    setHighlightMode(prev => prev === m ? null : m);
    setHighlightIndex(0);
    if (m !== "clauses") setActiveClauseGroup(null);
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(""), 3500);
    return () => clearTimeout(t);
  }, [toast]);

  const showToast = useCallback((msg: string) => setToast(msg), []);

  const navigateHighlight = useCallback((dir: 1 | -1) => {
    if (highlightedList.length === 0) return;
    const next = (highlightIndex + dir + highlightedList.length) % highlightedList.length;
    setHighlightIndex(next);
    scrollToChunkRef.current = highlightedList[next]?.chunk_id || null;
  }, [highlightIndex, highlightedList]);

  const jumpToNextRisk = useCallback(() => {
    if (clauseAssessments.length === 0 || !highlightedList.length) return;
    const highRiskChunks = new Set(clauseAssessments.filter(a => a.risk_level === "high").map(a => a.chunk_id));
    for (let offset = 1; offset <= highlightedList.length; offset++) {
      const idx = (highlightIndex + offset) % highlightedList.length;
      if (highRiskChunks.has(highlightedList[idx].chunk_id)) {
        setHighlightIndex(idx);
        scrollToChunkRef.current = highlightedList[idx].chunk_id;
        return;
      }
    }
  }, [highlightIndex, highlightedList, clauseAssessments]);

  useEffect(() => {
    if (detailTab !== "contents" || !highlightMode) return;
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === "ArrowLeft" || e.key === "ArrowUp") { e.preventDefault(); navigateHighlight(-1); }
      if (e.key === "ArrowRight" || e.key === "ArrowDown") { e.preventDefault(); navigateHighlight(1); }
      if (e.key === "r" || e.key === "R") { e.preventDefault(); jumpToNextRisk(); }
      if (e.key === "Escape") { setHighlightMode(null); setActiveClauseGroup(null); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [detailTab, highlightMode, navigateHighlight, jumpToNextRisk]);

  const loadDebugTrace = useCallback(async () => {
    if (!selectedContract || !result) return;
    setDebugLoading(true);
    try {
      const traceData = await getTrace(result.run_id);
      const events: { ts: string; step: string; details: Record<string, unknown> }[] = traceData?.events || [];

      const uniqueSections = new Set(chunks.map(c => c.section).filter(Boolean));
      const uniquePages = new Set(chunks.map(c => c.page).filter(p => p != null));
      const clauseGroupCount = Object.keys(highlights).length;

      const steps: { step: number; name: string; ts: string; details: Record<string, unknown>; status: string }[] = [];
      let stepNum = 1;

      steps.push({
        step: stepNum++, name: "Document Upload",
        ts: selectedContract.created_at,
        details: { filename: selectedContract.filename, format: selectedContract.filename.split(".").pop()?.toUpperCase() || "PDF", contract_type: selectedContract.contract_type || "Auto-detected" },
        status: "complete",
      });

      steps.push({
        step: stepNum++, name: "Parsing & Chunking",
        ts: selectedContract.created_at,
        details: { chunks: chunks.length, sections: uniqueSections.size, pages: uniquePages.size, method: "Section-header regex, 1200 char max" },
        status: chunks.length > 0 ? "complete" : "pending",
      });

      steps.push({
        step: stepNum++, name: "Embedding Generation",
        ts: selectedContract.created_at,
        details: { model: "text-embedding-3-small", dimensions: 1536, chunks_embedded: chunks.length, storage: "PostgreSQL + pgvector" },
        status: chunks.length > 0 ? "complete" : "pending",
      });

      steps.push({
        step: stepNum++, name: "Clause Classification",
        ts: selectedContract.created_at,
        details: { categories_detected: clauseGroupCount, method: "Keyword classifier", highlight_items: Object.values(highlights).reduce((s, a) => s + a.length, 0) },
        status: clauseGroupCount > 0 ? "complete" : "pending",
      });

      for (const ev of events) {
        if (ev.step === "initialize") {
          steps.push({ step: stepNum++, name: "Workflow Initialize", ts: ev.ts, details: ev.details, status: "complete" });
        } else if (ev.step === "summarize") {
          steps.push({ step: stepNum++, name: "Summarization (LLM)", ts: ev.ts, details: { ...ev.details, output: result.summary ? "Parsed OK" : "No summary" }, status: ev.details.parsed_ok !== false ? "complete" : "warning" });
        } else if (ev.step === "qa") {
          steps.push({ step: stepNum++, name: "Q&A Agent (LLM)", ts: ev.ts, details: ev.details, status: "complete" });
        } else if (ev.step === "clause_risk_assess") {
          const high = clauseAssessments.filter(a => a.risk_level === "high").length;
          const medium = clauseAssessments.filter(a => a.risk_level === "medium").length;
          const low = clauseAssessments.filter(a => a.risk_level === "low").length;
          steps.push({ step: stepNum++, name: "LLM Clause Risk Assessment", ts: ev.ts, details: { ...ev.details, high_risk: high, medium_risk: medium, low_risk: low }, status: ev.details.error ? "error" : "complete" });
        } else if (ev.step === "risk_scan") {
          steps.push({ step: stepNum++, name: "Keyword Risk Scan", ts: ev.ts, details: ev.details, status: "complete" });
        } else if (ev.step === "finalize") {
          steps.push({ step: stepNum++, name: "Finalize", ts: ev.ts, details: { status: "Analysis complete", total_steps: stepNum - 1 }, status: "complete" });
        }
      }

      if (events.length === 0 && result) {
        steps.push({ step: stepNum++, name: "Analysis Run", ts: result.run_id, details: { mode: result.mode, risks_found: risks.length }, status: "complete" });
      }

      setDebugSteps(steps);
    } catch { setDebugSteps([]); }
    setDebugLoading(false);
  }, [selectedContract, result, chunks, highlights, risks, clauseAssessments]);

  useEffect(() => {
    if (showDebug && debugSteps.length === 0 && selectedContract && result) {
      void loadDebugTrace();
    }
  }, [showDebug]); // eslint-disable-line react-hooks/exhaustive-deps

  const jumpToClauseGroup = useCallback((groupKey: string) => {
    const items = highlights[groupKey];
    if (!items?.length) return;
    setAskAiSources([]);
    setAskAiFocusIdx(0);
    if (activeClauseGroup === groupKey) {
      setActiveClauseGroup(null);
      setHighlightMode(null);
      setHighlightIndex(0);
      return;
    }
    setActiveClauseGroup(groupKey);
    setHighlightMode("clauses");
    setHighlightIndex(0);
    setDetailTab("contents");
    scrollToChunkRef.current = items[0].chunk_id;
    setHlPulse(true);
    setTimeout(() => setHlPulse(false), 100);
  }, [highlights, activeClauseGroup]);

  const canRun = Boolean(contractId && !loading);

  /* ─── Render helpers ────────────────────────────── */

  const navTo = useCallback((v: AppView, cId?: string) => {
    setView(v);
    setHighlightMode(null);
    setHighlightIndex(0);
    const path = pathFromView(v, cId || contractId);
    if (window.location.pathname !== path) {
      window.history.pushState({ view: v, contractId: cId || contractId }, "", path);
    }
  }, [contractId]); // eslint-disable-line react-hooks/exhaustive-deps

  const fileInput = (
    <input
      type="file"
      accept=".pdf,.docx,.doc,.html,.htm,.txt,.md"
      onChange={e => { const f = e.target.files?.[0]; if (f) void onUpload(f); }}
    />
  );

  /* ─── Render ────────────────────────────────────── */

  return (
    <>
      {/* ═══ TOP NAV ═══ */}
      <nav className="topNav">
        <div className="topNav__brand" onClick={() => navTo(contracts.length > 0 ? "documents" : "welcome")}>
          <div className="topNav__logo">CI</div>
          <span className="topNav__brandText">Contract Intelligence</span>
        </div>
        <div className="topNav__links">
          <button type="button" className={`topNav__link${view === "documents" ? " topNav__link--active" : ""}`} onClick={() => navTo("documents")}>Documents</button>
          <button type="button" className={`topNav__link${view === "clause-library" ? " topNav__link--active" : ""}`} onClick={() => navTo("clause-library")}>Clause Library</button>
          <button type="button" className={`topNav__link${view === "workflows" ? " topNav__link--active" : ""}`} onClick={() => navTo("workflows")}>Workflows</button>
          <button type="button" className={`topNav__link${view === "tools" || view === "sentinel" || view === "autopilot" ? " topNav__link--active" : ""}`} onClick={() => { navTo("tools"); setToolSubView("hub"); }}>Tools</button>
          <button type="button" className={`topNav__link${view === "dashboard" ? " topNav__link--active" : ""}`} onClick={() => navTo("dashboard")}>Insights</button>
        </div>
        <div className="topNav__right">
          <label className="topNav__uploadBtn">
            Upload {fileInput}
          </label>
          {view === "detail" && (
            <button type="button" className={`topNav__aiBtn${showAI ? " topNav__aiBtn--active" : ""}`} onClick={() => setShowAI(v => !v)}>
              &#10024; Ask AI
            </button>
          )}
          <button type="button" className="themeToggle" onClick={() => setDarkMode(v => !v)} title={darkMode ? "Switch to light mode" : "Switch to dark mode"}>
            {darkMode
              ? <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="3.5" stroke="currentColor" strokeWidth="1.3"/><path d="M8 1.5v1.5m0 10v1.5M1.5 8H3m10 0h1.5M3.4 3.4l1.06 1.06m7.08 7.08l1.06 1.06M3.4 12.6l1.06-1.06m7.08-7.08l1.06-1.06" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg>
              : <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M14 9.5A6.5 6.5 0 016.5 2 6.5 6.5 0 108 14.5a6.47 6.47 0 006-5z" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>
            }
          </button>
        </div>
      </nav>

      <div className="appMain">
        <div className="appContent">
          {/* ═══ WELCOME ═══ */}
          {view === "welcome" && (
            <div className="welcome">
              <div className="welcome__icon"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><path d="M9 15l2 2 4-4"/></svg></div>
              <h1 className="welcome__title">AI-Powered Contract Review</h1>
              <p className="welcome__desc">Upload a supplier agreement, NDA, or any legal document. AI will extract clauses, flag risks, and surface procurement actions — in seconds.</p>
              <div
                className={`welcome__dropzone${loading && loadingLabel === "upload" ? " welcome__dropzone--uploading" : ""}`}
                onDragOver={e => { e.preventDefault(); e.currentTarget.classList.add("welcome__dropzone--hover"); }}
                onDragLeave={e => { e.preventDefault(); e.currentTarget.classList.remove("welcome__dropzone--hover"); }}
                onDrop={e => { e.preventDefault(); e.currentTarget.classList.remove("welcome__dropzone--hover"); const f = e.dataTransfer.files[0]; if (f) void onUpload(f); }}
              >
                {loading && loadingLabel === "upload" ? (
                  <div className="welcome__dropzoneUploading">
                    <div className="analysisBar__spinner" />
                    <p className="welcome__dropzoneStatus">Uploading &amp; processing document…</p>
                  </div>
                ) : (
                  <>
                    <div className="welcome__dropzoneIcon"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg></div>
                    <p className="welcome__dropzoneText">Drag your contract here or <label className="welcome__dropzoneBrowse">click to browse{fileInput}</label></p>
                    <p className="welcome__dropzoneHint">PDF, DOCX, HTML, TXT — up to 50 MB</p>
                  </>
                )}
              </div>
              <div className="welcome__features">
                <div className="welcome__feature"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M9 12l2 2 4-4"/><circle cx="12" cy="12" r="10"/></svg><span>Clause Extraction</span></div>
                <div className="welcome__feature"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 9v2m0 4h.01"/><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/></svg><span>Risk Analysis</span></div>
                <div className="welcome__feature"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg><span>AI Q&amp;A</span></div>
                <div className="welcome__feature"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg><span>Compliance Check</span></div>
              </div>

              {/* ── Try a Sample ── */}
              <div className="welcome__samples">
                <p className="welcome__samplesTitle">Or try a sample contract</p>
                <div className="welcome__sampleCards">
                  {([
                    { file: "/samples/sample-msa.pdf", name: "Master Supplier Agreement", desc: "Multi-clause supplier contract with risk, payment, IP, and termination terms", icon: "MSA", color: "#6366f1" },
                    { file: "/samples/sample-nda.pdf", name: "Non-Disclosure Agreement", desc: "Mutual NDA covering confidentiality obligations, exclusions, and remedies", icon: "NDA", color: "#0ea5e9" },
                    { file: "/samples/sample-sow.pdf", name: "Statement of Work", desc: "Cloud migration SOW with milestones, fixed pricing, HIPAA, and liability caps", icon: "SOW", color: "#f59e0b" },
                  ] as const).map(s => (
                    <button
                      key={s.file}
                      type="button"
                      className="welcome__sampleCard"
                      disabled={loading}
                      onClick={async () => {
                        try {
                          const resp = await fetch(s.file);
                          const blob = await resp.blob();
                          const file = new File([blob], s.file.split("/").pop()!, { type: blob.type || "application/pdf" });
                          void onUpload(file);
                        } catch { setError("Failed to load sample document."); }
                      }}
                    >
                      <span className="welcome__sampleIcon" style={{ background: s.color }}>{s.icon}</span>
                      <span className="welcome__sampleText">
                        <strong>{s.name}</strong>
                        <span>{s.desc}</span>
                      </span>
                      <svg className="welcome__sampleArrow" width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                    </button>
                  ))}
                </div>
              </div>

              {error && <p className="errorBanner" style={{ maxWidth: 480, margin: "12px auto 0" }}>{error}</p>}
            </div>
          )}

          {/* ═══ DOCUMENTS LIST (Ironclad-style) ═══ */}
          {view === "documents" && (
            <div className="docRepo">
              {/* Filter sidebar */}
              {showFilters && (
                <aside className="docRepo__filters">
                  <div className="filterHeader">
                    <button type="button" className="filterHeader__toggle" onClick={() => setShowFilters(false)}>&#9776; Filters</button>
                    <button type="button" className="filterHeader__clear" onClick={clearFilters}>Clear Filters</button>
                  </div>

                  <div className="filterGroup">
                    <label className="filterGroup__label">Contract Type</label>
                    <select className="filterGroup__select" value={filterType} onChange={e => setFilterType(e.target.value)}>
                      <option value="">All Types</option>
                      <option value="NDA">NDA</option>
                      <option value="MSA">MSA</option>
                      <option value="SOW">Statement of Work</option>
                      <option value="SaaS License">SaaS License</option>
                      <option value="Vendor Agreement">Vendor Agreement</option>
                      <option value="Lease">Lease</option>
                      <option value="Employment">Employment</option>
                      <option value="Purchase Order">Purchase Order</option>
                      <option value="Service Agreement">Service Agreement</option>
                      <option value="Other">Other</option>
                    </select>
                  </div>

                  <div className="filterGroup">
                    <label className="filterGroup__label">Status</label>
                    <select className="filterGroup__select" value={filterStatus} onChange={e => setFilterStatus(e.target.value)}>
                      <option value="">All Statuses</option>
                      <option value="Active">Active</option>
                      <option value="Under Review">Under Review</option>
                      <option value="Expired">Expired</option>
                      <option value="Terminated">Terminated</option>
                    </select>
                  </div>

                  <div className="filterGroup">
                    <label className="filterGroup__label">Risk Level</label>
                    <select className="filterGroup__select" value={filterRisk} onChange={e => setFilterRisk(e.target.value)}>
                      <option value="">All Risk Levels</option>
                      <option value="Low">Low</option>
                      <option value="Medium">Medium</option>
                      <option value="High">High</option>
                    </select>
                  </div>

                  <div className="filterGroup">
                    <label className="filterGroup__label">Agreement Date</label>
                    <div className="filterGroup__dates">
                      <input type="date" className="filterGroup__input" value={filterDateFrom} onChange={e => setFilterDateFrom(e.target.value)} placeholder="From" />
                      <input type="date" className="filterGroup__input" value={filterDateTo} onChange={e => setFilterDateTo(e.target.value)} placeholder="To" />
                    </div>
                  </div>

                  <div className="filterGroup">
                    <label className="filterGroup__label">Counterparty</label>
                    <input
                      type="text"
                      className="filterGroup__input"
                      value={filterCounterparty}
                      onChange={e => setFilterCounterparty(e.target.value)}
                      onKeyDown={e => { if (e.key === "Enter") applyFilters(); }}
                      placeholder="Search counterparty..."
                    />
                  </div>
                </aside>
              )}

              {/* Main table area */}
              <div className="docRepo__main">
                <div className="docRepo__toolbar">
                  {!showFilters && (
                    <button type="button" className="btn btn--sm" onClick={() => setShowFilters(true)}>&#9776; Filters</button>
                  )}
                  <h1 className="docRepo__title">Repository</h1>
                  <div className="docRepo__search">
                    <input
                      type="text"
                      placeholder="Search counterparty name, contract text, etc."
                      value={filterSearch}
                      onChange={e => setFilterSearch(e.target.value)}
                      onKeyDown={e => { if (e.key === "Enter") applyFilters(); }}
                    />
                  </div>
                  <span className="docRepo__count">{contracts.length} contracts</span>
                  {contracts.length > 0 && (
                    <button type="button" className="btn btn--sm btn--danger" onClick={async () => {
                      if (!window.confirm(`Delete all ${contracts.length} contracts and related data? This cannot be undone.`)) return;
                      try {
                        await deleteAllContracts();
                        showToast("All contracts deleted");
                        void refreshContracts();
                        setView("documents");
                      } catch { showToast("Failed to delete contracts"); }
                    }}>Clear All Data</button>
                  )}
                </div>

                {/* KPI Tiles */}
                {contracts.length > 0 && (
                  <div className="repoKpi">
                    <div className="repoKpi__tile">
                      <span className="repoKpi__num">{contracts.length}</span>
                      <span className="repoKpi__label">Total Contracts</span>
                    </div>
                    <div className="repoKpi__tile repoKpi__tile--red">
                      <span className="repoKpi__num">{contracts.filter(c => c.risk_level?.toLowerCase() === "high").length}</span>
                      <span className="repoKpi__label">High Risk Flagged</span>
                    </div>
                    <div className="repoKpi__tile repoKpi__tile--amber">
                      <span className="repoKpi__num">
                        {contracts.filter(c => {
                          const d = c.agreement_date || c.created_at;
                          if (!d) return false;
                          const days = Math.floor((Date.now() - new Date(d).getTime()) / 86400000);
                          return days > 275;
                        }).length}
                      </span>
                      <span className="repoKpi__label">Upcoming Renewals</span>
                    </div>
                    <div className="repoKpi__tile">
                      <span className="repoKpi__num">{contracts.filter(c => c.status === "Active").length}</span>
                      <span className="repoKpi__label">Active Contracts</span>
                    </div>
                  </div>
                )}

                {contracts.length === 0 ? (
                  <div className="emptyState">No contracts match the current filters.</div>
                ) : (
                  <table className="docTable">
                    <thead>
                      <tr>
                        <th>Record Name</th>
                        <th>Counterparty</th>
                        <th>Contract Type</th>
                        <th>Agreement Date</th>
                        <th>Status</th>
                        <th>Risk</th>
                        <th style={{ width: 40 }}></th>
                      </tr>
                    </thead>
                    <tbody>
                      {contracts.map(c => (
                        <tr key={c.contract_id} onClick={() => void openContract(c.contract_id)}>
                          <td><span className="docTable__name">{c.filename}</span></td>
                          <td>{c.counterparty || <span className="text-muted">—</span>}</td>
                          <td>{c.contract_type ? <span className="typeBadge">{c.contract_type}</span> : <span className="text-muted">—</span>}</td>
                          <td className="text-muted">
                            {c.agreement_date ? new Date(c.agreement_date + "T00:00:00").toLocaleDateString() : new Date(c.created_at).toLocaleDateString()}
                            {(() => {
                              const d = c.agreement_date || c.created_at;
                              if (!d) return null;
                              const ageDays = Math.floor((Date.now() - new Date(d).getTime()) / 86400000);
                              const remaining = 365 - ageDays;
                              if (remaining <= 0) return <span className="renewalCountdown renewalCountdown--expired">Expired</span>;
                              if (remaining <= 90) return <span className="renewalCountdown renewalCountdown--soon">{remaining}d left</span>;
                              if (remaining <= 180) return <span className="renewalCountdown">{Math.floor(remaining / 30)}mo left</span>;
                              return null;
                            })()}
                          </td>
                          <td>
                            <span className={`statusBadge statusBadge--${(c.status || "Under Review").toLowerCase().replace(/\s/g, "")}`}>{c.status || "Under Review"}</span>
                            {(() => { const d = c.agreement_date || c.created_at; const days = Math.floor((Date.now() - new Date(d).getTime()) / 86400000); return days > 275 ? <span className="expiryBadge">Expiring</span> : null; })()}
                          </td>
                          <td>
                            {c.risk_level ? (
                              <span className="riskDonut" title={`${c.risk_level} Risk${c.risk_score != null ? ` — Score: ${c.risk_score}/100` : ""}`}>
                                <svg width="28" height="28" viewBox="0 0 36 36">
                                  <circle cx="18" cy="18" r="15.9" fill="none" stroke="var(--border)" strokeWidth="3" />
                                  <circle cx="18" cy="18" r="15.9" fill="none"
                                    stroke={c.risk_level.toLowerCase() === "high" ? "#dc2626" : c.risk_level.toLowerCase() === "medium" ? "#f59e0b" : "#22c55e"}
                                    strokeWidth="3" strokeDasharray={`${(c.risk_score ?? (c.risk_level.toLowerCase() === "high" ? 80 : c.risk_level.toLowerCase() === "medium" ? 50 : 25))} 100`}
                                    strokeLinecap="round" transform="rotate(-90 18 18)" />
                                </svg>
                                <span className="riskDonut__label">{c.risk_level.charAt(0)}</span>
                              </span>
                            ) : <span className="text-muted">—</span>}
                          </td>
                          <td>
                            <button type="button" className="docTable__deleteBtn" title="Delete contract" onClick={async (e) => {
                              e.stopPropagation();
                              if (!window.confirm(`Delete "${c.filename}" and all related data?`)) return;
                              try {
                                await deleteContract(c.contract_id);
                                showToast(`Deleted ${c.filename}`);
                                void refreshContracts();
                              } catch { showToast("Delete failed"); }
                            }}>
                              <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M2 4h10M5 4V2.5A.5.5 0 015.5 2h3a.5.5 0 01.5.5V4M11 4v7.5a1 1 0 01-1 1H4a1 1 0 01-1-1V4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/></svg>
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          )}

          {/* ═══ CLAUSE LIBRARY (top-level) ═══ */}
          {view === "clause-library" && (
            <div className="clauseLibView">
              <div className="clauseLibView__header">
                <div>
                  <h1 className="clauseLibView__title">Clause Library</h1>
                  <p className="clauseLibView__desc">{clauseLib.length} standard clauses for procurement contract review</p>
                </div>
                <button type="button" className="btn btn--primary btn--sm" onClick={() => setShowAddClause(!showAddClause)}>
                  {showAddClause ? "Cancel" : "+ Add Clause"}
                </button>
              </div>
              {showAddClause && (
                <div className="clauseLibView__addForm">
                  <input className="clauseLibView__input" placeholder="Clause name" value={newClauseName} onChange={e => setNewClauseName(e.target.value)} />
                  <input className="clauseLibView__input" placeholder="Description" value={newClauseDesc} onChange={e => setNewClauseDesc(e.target.value)} />
                  <select className="clauseLibView__input" value={newClauseCat} onChange={e => setNewClauseCat(e.target.value)}>
                    {["General", "Risk", "Financial", "IP", "Procurement"].map(c => <option key={c}>{c}</option>)}
                  </select>
                  <textarea className="clauseLibView__input" placeholder="Standard language (approved text)" value={newClauseLang} onChange={e => setNewClauseLang(e.target.value)} rows={3} />
                  <textarea className="clauseLibView__input" placeholder="Risk notes" value={newClauseRisk} onChange={e => setNewClauseRisk(e.target.value)} rows={2} />
                  <button type="button" className="btn btn--primary btn--sm" onClick={async () => {
                    if (!newClauseName.trim() || !newClauseDesc.trim()) return;
                    await createClause({ name: newClauseName, description: newClauseDesc, category: newClauseCat, standard_language: newClauseLang, risk_notes: newClauseRisk });
                    setNewClauseName(""); setNewClauseDesc(""); setNewClauseLang(""); setNewClauseRisk("");
                    setShowAddClause(false);
                    const d = await getClauseLibrary();
                    setClauseLib(d.clauses || []);
                  }}>Save Clause</button>
                </div>
              )}
              <div className="clauseLibView__controls">
                <input className="clauseLibView__search" placeholder="Search clauses..." value={clauseLibSearch} onChange={e => setClauseLibSearch(e.target.value)} />
                <div className="clauseLibView__filters">
                  {["All", "General", "Risk", "Financial", "IP", "Procurement"].map(c => (
                    <button key={c} type="button" className={`clauseLibView__filterBtn${clauseLibFilter === c ? " clauseLibView__filterBtn--active" : ""}`} onClick={() => setClauseLibFilter(c)}>{c}</button>
                  ))}
                </div>
              </div>
              <div className="clauseLibView__list">
                {clauseLib
                  .filter(c => clauseLibFilter === "All" || c.category === clauseLibFilter)
                  .filter(c => !clauseLibSearch || c.name.toLowerCase().includes(clauseLibSearch.toLowerCase()) || c.description.toLowerCase().includes(clauseLibSearch.toLowerCase()))
                  .map(c => (
                    <div key={c.clause_id} className={`clauseLibView__card${clauseLibExpanded === c.clause_id ? " clauseLibView__card--expanded" : ""}`}>
                      <button type="button" className="clauseLibView__cardHeader" onClick={() => setClauseLibExpanded(clauseLibExpanded === c.clause_id ? null : c.clause_id)}>
                        <div className="clauseLibView__cardLeft">
                          <span className={`clauseLibView__catBadge clauseLibView__catBadge--${c.category.toLowerCase()}`}>{c.category}</span>
                          <span className="clauseLibView__cardName">{c.name}</span>
                          {c.required && <span className="clauseLibView__reqBadge">Required</span>}
                        </div>
                        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" style={{ transform: clauseLibExpanded === c.clause_id ? "rotate(180deg)" : "none", transition: "0.15s" }}><path d="M2.5 4l3.5 3.5L9.5 4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/></svg>
                      </button>
                      <div className="clauseLibView__cardDesc">{c.description}</div>
                      {clauseLibExpanded === c.clause_id && (
                        <div className="clauseLibView__cardBody">
                          {c.standard_language && (
                            <div className="clauseLibView__section">
                              <div className="clauseLibView__sectionTitle">Standard Language</div>
                              <div className="clauseLibView__sectionText">{c.standard_language}</div>
                            </div>
                          )}
                          {c.risk_notes && (
                            <div className="clauseLibView__section">
                              <div className="clauseLibView__sectionTitle">Risk Notes</div>
                              <div className="clauseLibView__sectionText clauseLibView__sectionText--risk">{c.risk_notes}</div>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  ))}
              </div>
            </div>
          )}

          {/* ═══ WORKFLOWS (top-level) ═══ */}
          {view === "workflows" && (
            <div className="workflowsView">
              {!selectedWorkflow ? (
                <>
                  <div className="workflowsView__header">
                    <div>
                      <h1 className="workflowsView__title">Workflows</h1>
                      <p className="workflowsView__desc">Route contracts through review, approval, and execution stages. Workflows ensure every contract follows your organization&rsquo;s governance process before signature.</p>
                    </div>
                    <button type="button" className="btn btn--primary btn--sm" onClick={() => setShowNewWorkflow(!showNewWorkflow)}>
                      {showNewWorkflow ? "Cancel" : "+ New Workflow"}
                    </button>
                  </div>

                  {/* Example use-cases callout */}
                  {workflows.length === 0 && !showNewWorkflow && (
                    <div className="workflowsView__examples">
                      <div className="workflowsView__examplesTitle">What can workflows do?</div>
                      <div className="workflowsView__examplesGrid">
                        <div className="workflowsView__exampleCard">
                          <div className="workflowsView__exampleIcon"><svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M10 1L2 5.5v4.5c0 4.63 3.2 8.95 7.5 10 4.3-1.05 7.5-5.37 7.5-10V5.5L10 1z" stroke="var(--accent)" strokeWidth="1.3" fill="none"/><path d="M7 10l2 2 4-4" stroke="var(--accent)" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg></div>
                          <div className="workflowsView__exampleName">Standard Contract Review</div>
                          <div className="workflowsView__exampleDesc">AI analyzes the contract first, then Legal reviews flagged clauses, Risk Manager assesses exposure, and a Director gives final approval. Ensures nothing reaches signature without proper scrutiny.</div>
                        </div>
                        <div className="workflowsView__exampleCard">
                          <div className="workflowsView__exampleIcon"><svg width="20" height="20" viewBox="0 0 20 20" fill="none"><circle cx="10" cy="10" r="8" stroke="var(--accent)" strokeWidth="1.3"/><path d="M10 6v4l3 2" stroke="var(--accent)" strokeWidth="1.3" strokeLinecap="round"/></svg></div>
                          <div className="workflowsView__exampleName">Expedited Approval</div>
                          <div className="workflowsView__exampleDesc">For low-risk renewals or standard NDAs. AI runs a quick review, and if no high-risk flags are found, the contract goes directly to a Manager for fast-track approval.</div>
                        </div>
                        <div className="workflowsView__exampleCard">
                          <div className="workflowsView__exampleIcon"><svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M2 14l4-4 3 3 4-4 5 5" stroke="var(--accent)" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg></div>
                          <div className="workflowsView__exampleName">Renewal Decision Pipeline</div>
                          <div className="workflowsView__exampleDesc">When a contract is within 90 days of expiry, AI runs a term analysis, Stakeholders review pricing and performance, and a Director decides whether to renew, renegotiate, or let it lapse.</div>
                        </div>
                        <div className="workflowsView__exampleCard">
                          <div className="workflowsView__exampleIcon"><svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M14 2H6a2 2 0 00-2 2v12a2 2 0 002 2h8a2 2 0 002-2V4a2 2 0 00-2-2z" stroke="var(--accent)" strokeWidth="1.3"/><path d="M8 8h4M8 11h2" stroke="var(--accent)" strokeWidth="1.2" strokeLinecap="round"/></svg></div>
                          <div className="workflowsView__exampleName">Vendor Onboarding</div>
                          <div className="workflowsView__exampleDesc">New vendor contracts follow a full governance path: Procurement drafts terms, Legal reviews compliance, InfoSec validates data handling, and Finance approves spend. All tracked in one place.</div>
                        </div>
                      </div>
                      <button type="button" className="btn btn--primary" style={{ marginTop: 16 }} onClick={() => setShowNewWorkflow(true)}>Create Your First Workflow</button>
                    </div>
                  )}

                  {showNewWorkflow && (
                    <div className="workflowsView__newForm">
                      <p style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 12 }}>Select a workflow template to get started:</p>
                      {[
                        { name: "Standard Review", desc: "Full governance: AI → Legal → Risk → Director", steps: [{ title: "AI Analysis", step_type: "review", assignee: "AI" }, { title: "Legal Review", step_type: "review", assignee: "Legal Team" }, { title: "Risk Assessment", step_type: "review", assignee: "Risk Manager" }, { title: "Final Approval", step_type: "approve", assignee: "Director" }] },
                        { name: "Expedited Review", desc: "Fast-track: AI → Manager approval", steps: [{ title: "AI Review", step_type: "review", assignee: "AI" }, { title: "Manager Approval", step_type: "approve", assignee: "Manager" }] },
                        { name: "Renewal Review", desc: "Renewal pipeline: AI → Stakeholders → Director", steps: [{ title: "AI Analysis", step_type: "review", assignee: "AI" }, { title: "Stakeholder Review", step_type: "review", assignee: "Stakeholders" }, { title: "Renewal Decision", step_type: "approve", assignee: "Director" }] },
                      ].map(tpl => (
                        <button key={tpl.name} type="button" className="workflowsView__tplCard" onClick={async () => {
                          const contractSel = contracts[0]?.contract_id;
                          const wf = await createWorkflow({ name: tpl.name, contract_id: contractSel, steps: tpl.steps });
                          setShowNewWorkflow(false);
                          const d = await getWorkflows();
                          setWorkflows(d.workflows || []);
                          const full = await getWorkflow(wf.workflow_id);
                          setSelectedWorkflow(full);
                        }}>
                          <div className="workflowsView__tplName">{tpl.name}</div>
                          <div className="workflowsView__tplSteps">{tpl.desc} &middot; {tpl.steps.length} steps</div>
                        </button>
                      ))}
                    </div>
                  )}

                  {/* Kanban board */}
                  {workflows.length > 0 && (
                    <div className="workflowsView__board">
                      {["active", "completed", "draft"].map(col => {
                        const items = workflows.filter(w => w.status === col);
                        return (
                          <div key={col} className="workflowsView__col">
                            <div className="workflowsView__colHeader">
                              <span className="workflowsView__colTitle">{col === "active" ? "In Progress" : col === "completed" ? "Completed" : "Draft"}</span>
                              <span className="workflowsView__colCount">{items.length}</span>
                            </div>
                            {items.length === 0 && <div className="workflowsView__colEmpty">No workflows</div>}
                            {items.map(w => (
                              <button key={w.workflow_id} type="button" className="workflowsView__card" onClick={async () => {
                                const full = await getWorkflow(w.workflow_id);
                                setSelectedWorkflow(full);
                              }}>
                                <div className="workflowsView__cardName">{w.name}</div>
                                <div className="workflowsView__cardMeta">{w.filename || "All contracts"}</div>
                                <div className="workflowsView__cardProgress">
                                  <div className="workflowsView__progressBar"><div className="workflowsView__progressFill" style={{ width: `${w.total_steps ? (w.completed_steps / w.total_steps) * 100 : 0}%` }} /></div>
                                  <span>{w.completed_steps}/{w.total_steps} steps</span>
                                </div>
                              </button>
                            ))}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </>
              ) : (
                <div className="workflowDetail">
                  <button type="button" className="workflowDetail__back" onClick={() => setSelectedWorkflow(null)}>&larr; Back to Workflows</button>
                  <div className="workflowDetail__header">
                    <h2>{selectedWorkflow.name}</h2>
                    <span className={`workflowDetail__statusBadge workflowDetail__statusBadge--${selectedWorkflow.status}`}>{selectedWorkflow.status}</span>
                  </div>
                  {selectedWorkflow.filename && <p style={{ fontSize: 13, color: "var(--text-secondary)" }}>Contract: {selectedWorkflow.filename}</p>}
                  <div className="workflowDetail__timeline">
                    {selectedWorkflow.steps.map((s, i) => (
                      <div key={s.step_id} className={`workflowDetail__step workflowDetail__step--${s.status}`}>
                        <div className="workflowDetail__stepConnector">{i < selectedWorkflow.steps.length - 1 && <div className="workflowDetail__stepLine" />}</div>
                        <div className={`workflowDetail__stepDot workflowDetail__stepDot--${s.status}`}>
                          {s.status === "completed" ? <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2.5 6l2.5 2.5 4.5-5" stroke="#fff" strokeWidth="1.5" strokeLinecap="round"/></svg> : <span>{i + 1}</span>}
                        </div>
                        <div className="workflowDetail__stepContent">
                          <div className="workflowDetail__stepTitle">{s.title}</div>
                          <div className="workflowDetail__stepMeta">
                            {s.assignee && <span>Assigned: {s.assignee}</span>}
                            <span className={`workflowDetail__stepStatus workflowDetail__stepStatus--${s.status}`}>{s.status.replace("_", " ")}</span>
                          </div>
                          {s.status === "in_progress" && (
                            <button type="button" className="btn btn--primary btn--sm" style={{ marginTop: 8 }} onClick={async () => {
                              await updateWorkflowStep(selectedWorkflow.workflow_id, s.step_id, { status: "completed" });
                              const full = await getWorkflow(selectedWorkflow.workflow_id);
                              setSelectedWorkflow(full);
                              const d = await getWorkflows();
                              setWorkflows(d.workflows || []);
                            }}>Mark Complete</button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ═══ TOOLS HUB ═══ */}
          {(view === "tools" || view === "sentinel" || view === "autopilot") && (
            <>
            {/* Tools sub-navigation */}
            {(toolSubView !== "hub" || view === "tools") && (
              <div className="toolsSubNav">
                <button type="button" className={`toolsSubNav__item${toolSubView === "hub" ? " toolsSubNav__item--active" : ""}`} onClick={() => setToolSubView("hub")}>
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><rect x="1" y="1" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.2"/><rect x="8" y="1" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.2"/><rect x="1" y="8" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.2"/><rect x="8" y="8" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.2"/></svg>
                  All Tools
                </button>
                <button type="button" className={`toolsSubNav__item${toolSubView === "sentinel" ? " toolsSubNav__item--active" : ""}`} onClick={() => setToolSubView("sentinel")}>Sentinel</button>
                <button type="button" className={`toolsSubNav__item${toolSubView === "autopilot" ? " toolsSubNav__item--active" : ""}`} onClick={() => setToolSubView("autopilot")}>Autopilot</button>
                <button type="button" className={`toolsSubNav__item${toolSubView === "doc-gen" ? " toolsSubNav__item--active" : ""}`} onClick={() => setToolSubView("doc-gen")}>Doc Generator</button>
                <button type="button" className={`toolsSubNav__item${toolSubView === "doc-diff" ? " toolsSubNav__item--active" : ""}`} onClick={() => setToolSubView("doc-diff")}>Doc Diff</button>
                <button type="button" className={`toolsSubNav__item${toolSubView === "redline" ? " toolsSubNav__item--active" : ""}`} onClick={() => setToolSubView("redline")}>Redline</button>
                <button type="button" className={`toolsSubNav__item${toolSubView === "compliance" ? " toolsSubNav__item--active" : ""}`} onClick={() => setToolSubView("compliance")}>Compliance</button>
                <button type="button" className={`toolsSubNav__item${toolSubView === "batch" ? " toolsSubNav__item--active" : ""}`} onClick={() => setToolSubView("batch")}>Batch Analysis</button>
                <button type="button" className={`toolsSubNav__item${toolSubView === "export" ? " toolsSubNav__item--active" : ""}`} onClick={() => setToolSubView("export")}>Export</button>
              </div>
            )}

            {/* ── Tools Hub Grid ── */}
            {toolSubView === "hub" && (
              <div className="toolsHub">
                <div className="toolsHub__header">
                  <h1 className="toolsHub__title">Tools</h1>
                  <p className="toolsHub__desc">AI-powered contract tools for review, generation, comparison, and compliance.</p>
                </div>
                <div className="toolsHub__grid">
                  <button type="button" className="toolCard" onClick={() => setToolSubView("sentinel")}>
                    <div className="toolCard__icon toolCard__icon--sentinel"><svg width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M12 2L3 7v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V7l-9-5z" stroke="currentColor" strokeWidth="1.5" fill="none"/><path d="M9 12l2 2 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg></div>
                    <div className="toolCard__name">Sentinel</div>
                    <div className="toolCard__desc">AI contract review assistant. Define prompts, upload documents, get detailed compliance analysis.</div>
                    <span className="toolCard__badge">Active</span>
                  </button>
                  <button type="button" className="toolCard" onClick={() => setToolSubView("autopilot")}>
                    <div className="toolCard__icon toolCard__icon--autopilot"><svg width="24" height="24" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.5"/><path d="M12 8v4l3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/><path d="M7 3l1 2M17 3l-1 2" stroke="currentColor" strokeWidth="1.3"/></svg></div>
                    <div className="toolCard__name">Autopilot</div>
                    <div className="toolCard__desc">Autonomous agent that executes tasks — renewals, risk audits, spend analysis, compliance checks.</div>
                    <span className="toolCard__badge">Active</span>
                  </button>
                  <button type="button" className="toolCard" onClick={() => setToolSubView("doc-diff")}>
                    <div className="toolCard__icon toolCard__icon--diff"><svg width="24" height="24" viewBox="0 0 24 24" fill="none"><rect x="2" y="3" width="8" height="18" rx="2" stroke="currentColor" strokeWidth="1.5"/><rect x="14" y="3" width="8" height="18" rx="2" stroke="currentColor" strokeWidth="1.5"/><path d="M6 8h0M6 11h0M6 14h0M18 8h0M18 11h0M18 14h0" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg></div>
                    <div className="toolCard__name">Doc Diff</div>
                    <div className="toolCard__desc">Compare two contracts side-by-side. Highlight additions, deletions, and changed clauses instantly.</div>
                    <span className="toolCard__badge toolCard__badge--new">New</span>
                  </button>
                  <button type="button" className="toolCard" onClick={() => setToolSubView("doc-gen")}>
                    <div className="toolCard__icon toolCard__icon--gen"><svg width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" stroke="currentColor" strokeWidth="1.5"/><polyline points="14,2 14,8 20,8" stroke="currentColor" strokeWidth="1.5"/><path d="M9 15l2 2 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg></div>
                    <div className="toolCard__name">Doc Generator</div>
                    <div className="toolCard__desc">Generate contracts, amendments, and addenda from templates using AI. Customize clauses with natural language.</div>
                    <span className="toolCard__badge toolCard__badge--new">New</span>
                  </button>
                  <button type="button" className="toolCard" onClick={() => setToolSubView("redline")}>
                    <div className="toolCard__icon toolCard__icon--redline"><svg width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" stroke="currentColor" strokeWidth="1.5"/><path d="M18.5 2.5a2.12 2.12 0 013 3L12 15l-4 1 1-4 9.5-9.5z" stroke="currentColor" strokeWidth="1.5"/></svg></div>
                    <div className="toolCard__name">Redline</div>
                    <div className="toolCard__desc">Auto-generate redlines and suggested edits based on your playbook and negotiation preferences.</div>
                    <span className="toolCard__badge toolCard__badge--new">New</span>
                  </button>
                  <button type="button" className="toolCard" onClick={() => setToolSubView("compliance")}>
                    <div className="toolCard__icon toolCard__icon--compliance"><svg width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M9 11l3 3L22 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11" stroke="currentColor" strokeWidth="1.5"/></svg></div>
                    <div className="toolCard__name">Compliance Check</div>
                    <div className="toolCard__desc">Verify contracts against regulatory frameworks, company policies, and industry standards.</div>
                    <span className="toolCard__badge toolCard__badge--new">New</span>
                  </button>
                  <button type="button" className="toolCard" onClick={() => setToolSubView("batch")}>
                    <div className="toolCard__icon toolCard__icon--batch"><svg width="24" height="24" viewBox="0 0 24 24" fill="none"><rect x="3" y="3" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.5"/></svg></div>
                    <div className="toolCard__name">Batch Analysis</div>
                    <div className="toolCard__desc">Process entire contract portfolios at once — extract metadata, flag risks, score obligations in bulk.</div>
                    <span className="toolCard__badge toolCard__badge--new">New</span>
                  </button>
                  <button type="button" className="toolCard" onClick={() => setToolSubView("export")}>
                    <div className="toolCard__icon toolCard__icon--export"><svg width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" stroke="currentColor" strokeWidth="1.5"/><polyline points="7,10 12,15 17,10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/><line x1="12" y1="15" x2="12" y2="3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg></div>
                    <div className="toolCard__name">Export Center</div>
                    <div className="toolCard__desc">Generate PDF reports, Excel summaries, JSON data exports, and executive briefing packs.</div>
                    <span className="toolCard__badge toolCard__badge--new">New</span>
                  </button>
                </div>
              </div>
            )}



          {/* ═══ SENTINEL AI ASSISTANT ═══ */}
          {toolSubView === "sentinel" && (
            <div className="sentinel">
              {/* Left panel — instruction + history */}
              <div className="sentinel__left">
                <div className="sentinel__instruction">
                  <div className="sentinel__inputWrap">
                    <textarea
                      className="sentinel__textarea"
                      placeholder="Type in your instructions or select a prompt template..."
                      value={sentinelInstruction}
                      onChange={e => setSentinelInstruction(e.target.value)}
                      rows={4}
                    />
                    <div className="sentinel__inputActions">
                      <div className="sentinel__inputLeft">
                        <label className="sentinel__attachBtn">
                          <input
                            ref={sentinelFileRef}
                            type="file"
                            accept=".pdf,.docx,.txt,.html,.md"
                            style={{ display: "none" }}
                            onChange={async (e) => {
                              const file = e.target.files?.[0];
                              if (!file) return;
                              try {
                                const resp = await ingestContract(file);
                                setSentinelSelectedContract(resp.contract_id);
                                showToast(`Uploaded ${file.name}`);
                                void refreshContracts();
                              } catch { showToast("Upload failed"); }
                            }}
                          />
                          Attach
                        </label>
                        <button
                          type="button"
                          className="sentinel__promptBtn"
                          onClick={() => setShowPromptLib(!showPromptLib)}
                        >Prompts</button>
                      </div>
                      <button
                        type="button"
                        className="sentinel__sendBtn"
                        disabled={sentinelReviewing || (!sentinelInstruction.trim() && !sentinelSelectedPrompt) || !sentinelSelectedContract}
                        onClick={async () => {
                          if (!sentinelSelectedContract) { showToast("Please attach or select a contract first."); return; }
                          setSentinelReviewing(true);
                          setSentinelReviewResult("");
                          try {
                            const payload: { contract_id: string; prompt_id?: string; custom_prompt?: string } = {
                              contract_id: sentinelSelectedContract,
                            };
                            if (sentinelSelectedPrompt) {
                              payload.prompt_id = sentinelSelectedPrompt.prompt_id;
                            }
                            if (sentinelInstruction.trim()) {
                              payload.custom_prompt = sentinelInstruction.trim();
                            }
                            const resp = await runSentinelReview(payload);
                            setSentinelReviewResult(resp.result?.review_text || "No result returned.");
                            const sessions = await getSentinelSessions();
                            setSentinelSessions(sessions.sessions || []);
                          } catch { setSentinelReviewResult("Review failed. Please try again."); }
                          setSentinelReviewing(false);
                        }}
                      >{sentinelReviewing ? "Reviewing..." : "Send"}</button>
                    </div>
                  </div>

                  {/* Selected contract indicator */}
                  {sentinelSelectedContract && (
                    <div className="sentinel__selectedDoc">
                      <span className="sentinel__docIcon">&#128196;</span>
                      <span>{contracts.find(c => c.contract_id === sentinelSelectedContract)?.filename || sentinelSelectedContract}</span>
                      <button type="button" className="sentinel__docRemove" onClick={() => setSentinelSelectedContract("")}>&times;</button>
                    </div>
                  )}

                  {/* Contract picker if none attached */}
                  {!sentinelSelectedContract && contracts.length > 0 && (
                    <div className="sentinel__contractPicker">
                      <span style={{ fontSize: 12, color: "var(--text-muted)" }}>Or select an existing contract:</span>
                      <select
                        className="sentinel__contractSelect"
                        value=""
                        onChange={e => setSentinelSelectedContract(e.target.value)}
                      >
                        <option value="">Choose a contract...</option>
                        {contracts.map(c => (
                          <option key={c.contract_id} value={c.contract_id}>{c.filename}</option>
                        ))}
                      </select>
                    </div>
                  )}

                  {/* Selected prompt indicator */}
                  {sentinelSelectedPrompt && (
                    <div className="sentinel__selectedPrompt">
                      <span className="sentinel__promptIcon">&#128221;</span>
                      <div>
                        <div style={{ fontWeight: 600, fontSize: 13 }}>{sentinelSelectedPrompt.name}</div>
                        <div style={{ fontSize: 11, color: "var(--text-muted)" }}>{sentinelSelectedPrompt.category}</div>
                      </div>
                      <button type="button" className="sentinel__docRemove" onClick={() => { setSentinelSelectedPrompt(null); setSentinelInstruction(""); }}>&times;</button>
                    </div>
                  )}

                  {/* Prompt Library Dropdown */}
                  {showPromptLib && (
                    <div className="sentinel__promptLib">
                      <div className="sentinel__promptLibHeader">
                        <strong style={{ fontSize: 16 }}>Prompt Library</strong>
                        <button type="button" className="sentinel__promptLibAdd" onClick={() => setShowNewPrompt(!showNewPrompt)}>+</button>
                      </div>
                      <div className="sentinel__promptFilters">
                        {["All", "Procurement", "Risk", "Custom"].map(cat => (
                          <button key={cat} type="button"
                            className={`sentinel__promptFilterBtn${promptFilter === cat ? " sentinel__promptFilterBtn--active" : ""}`}
                            onClick={() => setPromptFilter(cat)}
                          >{cat}</button>
                        ))}
                      </div>
                      {showNewPrompt && (
                        <div className="sentinel__newPromptForm">
                          <input placeholder="Prompt name" value={newPromptName} onChange={e => setNewPromptName(e.target.value)} className="sentinel__newPromptInput" />
                          <input placeholder="Description" value={newPromptDesc} onChange={e => setNewPromptDesc(e.target.value)} className="sentinel__newPromptInput" />
                          <select value={newPromptCat} onChange={e => setNewPromptCat(e.target.value)} className="sentinel__newPromptInput">
                            <option value="Custom">Custom</option>
                            <option value="Procurement">Procurement</option>
                            <option value="Risk">Risk</option>
                          </select>
                          <textarea placeholder="Prompt text..." value={newPromptText} onChange={e => setNewPromptText(e.target.value)} className="sentinel__newPromptInput" rows={4} />
                          <button type="button" className="btn btn--primary btn--sm" onClick={async () => {
                            if (!newPromptName.trim() || !newPromptText.trim()) return;
                            await createSentinelPrompt({ name: newPromptName, description: newPromptDesc, prompt_text: newPromptText, category: newPromptCat });
                            setNewPromptName(""); setNewPromptDesc(""); setNewPromptText("");
                            setShowNewPrompt(false);
                            const d = await getSentinelPrompts();
                            setSentinelPrompts(d.prompts || []);
                          }}>Save Prompt</button>
                        </div>
                      )}
                      <div className="sentinel__promptList">
                        {sentinelPrompts
                          .filter(p => promptFilter === "All" || p.category === promptFilter)
                          .map(p => (
                            <button
                              type="button" key={p.prompt_id}
                              className={`sentinel__promptItem${sentinelSelectedPrompt?.prompt_id === p.prompt_id ? " sentinel__promptItem--active" : ""}`}
                              onClick={() => {
                                setSentinelSelectedPrompt(p);
                                setSentinelInstruction(p.prompt_text);
                                setShowPromptLib(false);
                              }}
                            >
                              <div className="sentinel__promptItemName">{p.name}</div>
                              <div className="sentinel__promptItemAuthor">{p.author}</div>
                            </button>
                          ))}
                      </div>
                    </div>
                  )}
                </div>

                {/* Session History */}
                <div className="sentinel__history">
                  <div className="sentinel__historyTitle">Review History</div>
                  {sentinelSessions.length === 0 ? (
                    <div className="emptyState" style={{ fontSize: 12, padding: 12 }}>No reviews yet.</div>
                  ) : sentinelSessions.map(s => (
                    <button
                      type="button" key={s.session_id}
                      className="sentinel__historyItem"
                      onClick={() => {
                        if (s.result?.review_text) setSentinelReviewResult(s.result.review_text);
                        if (s.contract_id) setSentinelSelectedContract(s.contract_id);
                      }}
                    >
                      <div className="sentinel__historyName">{s.prompt_name || "Custom Review"}</div>
                      <div className="sentinel__historyMeta">
                        <span>{s.filename || s.contract_id.slice(0, 8)}</span>
                        <span className={`sentinel__historyStatus sentinel__historyStatus--${s.status}`}>{s.status}</span>
                      </div>
                      <div className="sentinel__historyTime">{new Date(s.created_at).toLocaleString()}</div>
                    </button>
                  ))}
                </div>
              </div>

              {/* Right panel — results / welcome */}
              <div className="sentinel__right">
                {!sentinelReviewResult && !sentinelReviewing && (
                  <div className="sentinel__welcome">
                    <div className="sentinel__welcomeIcon">
                      <svg width="72" height="72" viewBox="0 0 72 72" fill="none"><rect width="72" height="72" rx="16" fill="var(--accent-bg)"/><path d="M20 48V24l12 6-12 6v12z" fill="var(--accent)" opacity="0.6"/><rect x="28" y="20" width="24" height="32" rx="3" stroke="var(--accent)" strokeWidth="2" fill="none"/><line x1="33" y1="28" x2="47" y2="28" stroke="var(--accent)" strokeWidth="1.5"/><line x1="33" y1="34" x2="47" y2="34" stroke="var(--accent)" strokeWidth="1.5"/><line x1="33" y1="40" x2="43" y2="40" stroke="var(--accent)" strokeWidth="1.5"/></svg>
                    </div>
                    <h2 className="sentinel__welcomeTitle">Your documents will appear here</h2>
                    <p className="sentinel__welcomeDesc">As you work on your project, any documents you upload and review with AI will be displayed here, ready to edit and customize.</p>
                  </div>
                )}
                {sentinelReviewing && (
                  <div className="sentinel__welcome">
                    <div className="sentinel__spinner" />
                    <h2 className="sentinel__welcomeTitle">Sentinel is reviewing your contract...</h2>
                    <p className="sentinel__welcomeDesc">This typically takes 15-30 seconds depending on the document length.</p>
                  </div>
                )}
                {sentinelReviewResult && !sentinelReviewing && (
                  <div className="sentinel__result">
                    <div className="sentinel__resultHeader">
                      <h2 style={{ fontSize: 16, fontWeight: 700 }}>Review Results</h2>
                      <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
                        {contracts.find(c => c.contract_id === sentinelSelectedContract)?.filename || ""}
                      </span>
                    </div>
                    <div className="sentinel__resultContent" dangerouslySetInnerHTML={{ __html: formatMarkdown(sentinelReviewResult) }} />
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ═══ AUTOPILOT AGENT ═══ */}
          {toolSubView === "autopilot" && (
            <div className="autopilot">
              {/* Left: Task Templates + Queue */}
              <div className="autopilot__left">
                <div className="autopilot__section">
                  <div className="autopilot__sectionTitle">Quick Actions</div>
                  <div className="autopilot__templates">
                    {apTemplates.map(t => {
                      const icons: Record<string, string> = { calendar: "\u25F7", shield: "\u25C6", search: "\u25CE", dollar: "\u25B8", refresh: "\u21BB", lock: "\u25A0", briefcase: "\u25B6", users: "\u25CF" };
                      return (
                        <button
                          type="button" key={t.key}
                          className="autopilot__templateCard"
                          onClick={async () => {
                            setApExecuting(t.key);
                            try {
                              const created = await createAutopilotTask({ title: t.title, description: t.description, task_type: t.task_type });
                              const executed = await executeAutopilotTask(created.task_id);
                              setApSelectedTask(executed);
                              const tasks = await getAutopilotTasks();
                              setApTasks(tasks.tasks || []);
                            } catch { showToast("Task execution failed."); }
                            setApExecuting(null);
                          }}
                          disabled={apExecuting !== null}
                        >
                          <span className="autopilot__templateIcon">{icons[t.icon] || "⚡"}</span>
                          <div>
                            <div className="autopilot__templateTitle">{t.title}</div>
                            <div className="autopilot__templateDesc">{t.description}</div>
                          </div>
                          {apExecuting === t.key && <span className="autopilot__templateSpinner" />}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Custom Request */}
                <div className="autopilot__section">
                  <button type="button" className="autopilot__customToggle" onClick={() => setShowCustomTask(!showCustomTask)}>
                    {showCustomTask ? "Cancel" : "+ Custom Request"}
                  </button>
                  {showCustomTask && (
                    <div className="autopilot__customForm">
                      <input
                        className="autopilot__customInput"
                        placeholder="Task title"
                        value={apCustomTitle}
                        onChange={e => setApCustomTitle(e.target.value)}
                      />
                      <textarea
                        className="autopilot__customInput"
                        placeholder="Describe what you need the agent to do..."
                        value={apCustomDesc}
                        onChange={e => setApCustomDesc(e.target.value)}
                        rows={3}
                      />
                      <select
                        className="autopilot__customInput"
                        value={apCustomContract}
                        onChange={e => setApCustomContract(e.target.value)}
                      >
                        <option value="">All contracts (portfolio-wide)</option>
                        {contracts.map(c => (
                          <option key={c.contract_id} value={c.contract_id}>{c.filename}</option>
                        ))}
                      </select>
                      <button
                        type="button" className="btn btn--primary btn--sm"
                        disabled={!apCustomTitle.trim() || !apCustomDesc.trim() || apExecuting !== null}
                        onClick={async () => {
                          setApExecuting("custom");
                          try {
                            const created = await createAutopilotTask({
                              title: apCustomTitle,
                              description: apCustomDesc,
                              task_type: "custom",
                              contract_id: apCustomContract || undefined,
                            });
                            const executed = await executeAutopilotTask(created.task_id);
                            setApSelectedTask(executed);
                            setApCustomTitle(""); setApCustomDesc(""); setApCustomContract("");
                            setShowCustomTask(false);
                            const tasks = await getAutopilotTasks();
                            setApTasks(tasks.tasks || []);
                          } catch { showToast("Task execution failed."); }
                          setApExecuting(null);
                        }}
                      >{apExecuting === "custom" ? "Running..." : "Submit & Run"}</button>
                    </div>
                  )}
                </div>

                {/* Task History */}
                <div className="autopilot__section autopilot__history">
                  <div className="autopilot__sectionTitle">Task History</div>
                  {apTasks.length === 0 ? (
                    <div className="emptyState" style={{ fontSize: 12, padding: 12 }}>No tasks yet.</div>
                  ) : apTasks.map(t => (
                    <button
                      type="button" key={t.task_id}
                      className={`autopilot__historyItem${apSelectedTask?.task_id === t.task_id ? " autopilot__historyItem--active" : ""}`}
                      onClick={async () => {
                        const full = await getAutopilotTask(t.task_id);
                        setApSelectedTask(full);
                      }}
                    >
                      <div className="autopilot__historyTop">
                        <span className="autopilot__historyTitle">{t.title}</span>
                        <span className={`autopilot__historyBadge autopilot__historyBadge--${t.status}`}>{t.status}</span>
                      </div>
                      <div className="autopilot__historyMeta">{new Date(t.created_at).toLocaleString()}</div>
                    </button>
                  ))}
                </div>
              </div>

              {/* Right: Task Detail / Results */}
              <div className="autopilot__right">
                {!apSelectedTask && !apExecuting && (
                  <div className="autopilot__empty">
                    <div className="autopilot__emptyIcon">
                      <svg width="80" height="80" viewBox="0 0 80 80" fill="none"><rect width="80" height="80" rx="18" fill="var(--accent-bg)"/><circle cx="40" cy="32" r="14" stroke="var(--accent)" strokeWidth="2" fill="none"/><path d="M30 50c0-5.5 4.5-10 10-10s10 4.5 10 10" stroke="var(--accent)" strokeWidth="2" fill="none"/><path d="M40 18v-4M52 20l2-3M28 20l-2-3" stroke="var(--accent)" strokeWidth="1.5"/></svg>
                    </div>
                    <h2 className="autopilot__emptyTitle">Autopilot Agent</h2>
                    <p className="autopilot__emptyDesc">Select a quick action or create a custom request. The agent will work autonomously, update its status, and deliver results when complete.</p>
                  </div>
                )}

                {apExecuting && !apSelectedTask && (
                  <div className="autopilot__empty">
                    <div className="sentinel__spinner" />
                    <h2 className="autopilot__emptyTitle">Agent is working...</h2>
                    <p className="autopilot__emptyDesc">The Autopilot agent is executing your request. Results will appear here shortly.</p>
                  </div>
                )}

                {apSelectedTask && (
                  <div className="autopilot__detail">
                    <div className="autopilot__detailHeader">
                      <div>
                        <h2 className="autopilot__detailTitle">{apSelectedTask.title}</h2>
                        <p className="autopilot__detailDesc">{apSelectedTask.description}</p>
                      </div>
                      <span className={`autopilot__statusBadge autopilot__statusBadge--${apSelectedTask.status}`}>
                        {apSelectedTask.status}
                      </span>
                    </div>

                    {/* Progress Bar */}
                    <div className="autopilot__progress">
                      <div className="autopilot__progressBar">
                        <div className="autopilot__progressFill" style={{ width: `${apSelectedTask.progress}%` }} />
                      </div>
                      <span className="autopilot__progressLabel">{apSelectedTask.progress}%</span>
                    </div>

                    {/* Steps Log */}
                    {apSelectedTask.steps && apSelectedTask.steps.length > 0 && (
                      <div className="autopilot__steps">
                        <div className="autopilot__stepsTitle">Agent Activity Log</div>
                        {apSelectedTask.steps.map((s, i) => (
                          <div key={i} className={`autopilot__step autopilot__step--${s.step === "error" ? "error" : s.step === "completed" ? "done" : "info"}`}>
                            <span className="autopilot__stepDot" />
                            <div>
                              <div className="autopilot__stepMsg">{s.message}</div>
                              <div className="autopilot__stepTime">{new Date(s.ts).toLocaleTimeString()}</div>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Results */}
                    {apSelectedTask.result?.report && (
                      <div className="autopilot__result">
                        <div className="autopilot__resultHeader">
                          <strong>Agent Report</strong>
                          <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                            {apSelectedTask.result.contracts_analyzed || 0} contracts analyzed
                          </span>
                        </div>
                        <div className="sentinel__resultContent" dangerouslySetInnerHTML={{ __html: formatMarkdown(apSelectedTask.result.report) }} />
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ═══ DOC DIFF ═══ */}
          {toolSubView === "doc-diff" && (
            <div className="toolStub">
              <div className="toolStub__icon"><svg width="48" height="48" viewBox="0 0 48 48" fill="none"><rect x="4" y="6" width="16" height="36" rx="3" stroke="var(--accent)" strokeWidth="2" fill="none"/><rect x="28" y="6" width="16" height="36" rx="3" stroke="var(--accent)" strokeWidth="2" fill="none"/><path d="M10 14h4M10 20h4M10 26h4M34 14h4M34 20h4M34 26h4" stroke="var(--accent)" strokeWidth="1.5" strokeLinecap="round"/><path d="M22 18l4 4-4 4" stroke="var(--accent)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg></div>
              <h2 className="toolStub__title">Document Diff</h2>
              <p className="toolStub__desc">Compare two contract versions or documents side-by-side. AI will highlight additions, deletions, clause changes, and semantic differences.</p>
              <div className="toolStub__actions">
                <div className="toolStub__dropzone">
                  <span className="toolStub__dropLabel">Drop or select <strong>Document A</strong></span>
                  <label className="btn btn--sm">Choose File<input type="file" accept=".pdf,.docx,.txt" style={{ display: "none" }} onChange={() => showToast("Document comparison coming soon.")} /></label>
                </div>
                <div className="toolStub__vs">VS</div>
                <div className="toolStub__dropzone">
                  <span className="toolStub__dropLabel">Drop or select <strong>Document B</strong></span>
                  <label className="btn btn--sm">Choose File<input type="file" accept=".pdf,.docx,.txt" style={{ display: "none" }} onChange={() => showToast("Document comparison coming soon.")} /></label>
                </div>
              </div>
              <button type="button" className="btn btn--primary" disabled>Compare Documents</button>
              <p className="toolStub__coming">Full diff engine coming soon. Powered by AI clause matching.</p>
            </div>
          )}

          {/* ═══ DOC GENERATOR ═══ */}
          {toolSubView === "doc-gen" && (
            <div className="docGenView">
              <div className="docGenView__header">
                <h1 className="docGenView__title">Document Generator</h1>
                <p className="docGenView__desc">Generate contracts from templates using natural language instructions.</p>
              </div>
              {!selectedTemplate ? (
                <>
                  <div className="docGenView__step">Step 1: Choose a template</div>
                  <div className="docGenView__tplGrid">
                    {docTemplates.map(t => (
                      <button key={t.template_id} type="button" className="docGenView__tplCard" onClick={() => { setSelectedTemplate(t); setGenResult(null); setGenInstructions(""); }}>
                        <div className="docGenView__tplType">{t.doc_type}</div>
                        <div className="docGenView__tplName">{t.name}</div>
                        <div className="docGenView__tplDesc">{t.description}</div>
                        <div className="docGenView__tplVars">{t.variables.length} variables</div>
                      </button>
                    ))}
                  </div>
                  {generatedDocs.length > 0 && (
                    <div style={{ marginTop: 32 }}>
                      <div className="docGenView__step">Previously Generated</div>
                      <div className="docGenView__history">
                        {generatedDocs.slice(0, 10).map(d => (
                          <button key={d.doc_id} type="button" className="docGenView__historyItem" onClick={() => setGenResult(d.generated_text || "")}>
                            <span className="docGenView__historyName">{d.title}</span>
                            <span className="docGenView__historyDate">{new Date(d.created_at).toLocaleDateString()}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              ) : !genResult ? (
                <>
                  <button type="button" className="docGenView__backBtn" onClick={() => setSelectedTemplate(null)}>&larr; Back to templates</button>
                  <div className="docGenView__step">Step 2: Describe what you need</div>
                  <div className="docGenView__selectedTpl">
                    <span className="docGenView__tplType">{selectedTemplate.doc_type}</span>
                    <span style={{ fontWeight: 600 }}>{selectedTemplate.name}</span>
                  </div>
                  <textarea className="docGenView__nlqBox" rows={5} value={genInstructions} onChange={e => setGenInstructions(e.target.value)} placeholder={`Describe the contract in natural language. For example:\n\n"Generate an MSA for Acme Corp with 2-year term, mutual indemnification, $1M liability cap, Net 30 payment terms, California governing law."\n\nThe AI will fill template variables and customize clauses based on your instructions.`} />
                  <button type="button" className="btn btn--primary" disabled={generating || !genInstructions.trim()} onClick={async () => {
                    setGenerating(true);
                    try {
                      const doc = await generateFromTemplate(selectedTemplate.template_id, { instructions: genInstructions, title: `${selectedTemplate.name} - ${new Date().toLocaleDateString()}` });
                      setGenResult(doc.generated_text || "Generation complete.");
                      const d = await getGeneratedDocs();
                      setGeneratedDocs(d.docs || []);
                    } catch { setGenResult("Generation failed. Please try again."); }
                    setGenerating(false);
                  }}>{generating ? "Generating..." : "Generate Document"}</button>
                </>
              ) : (
                <>
                  <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
                    <button type="button" className="btn btn--sm" onClick={() => setGenResult(null)}>&larr; New Instructions</button>
                    <button type="button" className="btn btn--sm" onClick={() => setSelectedTemplate(null)}>Choose Different Template</button>
                    <button type="button" className="btn btn--sm" onClick={() => { navigator.clipboard.writeText(genResult || ""); showToast("Copied to clipboard"); }}>Copy Text</button>
                  </div>
                  <div className="docGenView__step">Generated Document</div>
                  <div className="docGenView__preview">{genResult}</div>
                </>
              )}
            </div>
          )}

          {/* ═══ REDLINE ═══ */}
          {toolSubView === "redline" && (
            <div className="toolStub">
              <div className="toolStub__icon"><svg width="48" height="48" viewBox="0 0 48 48" fill="none"><path d="M22 8H8a4 4 0 00-4 4v28a4 4 0 004 4h28a4 4 0 004-4V26" stroke="var(--accent)" strokeWidth="2" fill="none"/><path d="M37 3a4.24 4.24 0 016 6L24 28l-8 2 2-8L37 3z" stroke="var(--accent)" strokeWidth="2" fill="none"/></svg></div>
              <h2 className="toolStub__title">Redline Generator</h2>
              <p className="toolStub__desc">Upload a contract and your playbook. AI auto-generates redlines, suggests alternative language, and marks up the document for negotiation.</p>
              <div className="toolStub__actions" style={{ flexDirection: "column", gap: 12 }}>
                <label className="btn btn--sm" style={{ alignSelf: "flex-start" }}>Upload Contract<input type="file" accept=".pdf,.docx" style={{ display: "none" }} onChange={() => showToast("Redline tool coming soon.")} /></label>
                <label className="btn btn--sm" style={{ alignSelf: "flex-start" }}>Upload Playbook (optional)<input type="file" accept=".pdf,.docx,.txt" style={{ display: "none" }} onChange={() => showToast("Redline tool coming soon.")} /></label>
              </div>
              <button type="button" className="btn btn--primary" disabled>Generate Redlines</button>
              <p className="toolStub__coming">Automated redline generation coming soon.</p>
            </div>
          )}

          {/* ═══ COMPLIANCE CHECK ═══ */}
          {toolSubView === "compliance" && (
            <div className="toolStub">
              <div className="toolStub__icon"><svg width="48" height="48" viewBox="0 0 48 48" fill="none"><path d="M18 22l6 6L44 8" stroke="var(--accent)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/><path d="M42 24v14a4 4 0 01-4 4H10a4 4 0 01-4-4V10a4 4 0 014-4h22" stroke="var(--accent)" strokeWidth="2"/></svg></div>
              <h2 className="toolStub__title">Compliance Check</h2>
              <p className="toolStub__desc">Verify contracts against your company policies, regulatory frameworks (GDPR, SOX, CCPA), and procurement guidelines in seconds.</p>
              <div className="toolStub__formGrid">
                <div className="toolStub__field">
                  <label className="toolStub__label">Contract</label>
                  <select className="toolStub__select">
                    <option value="">Select a contract...</option>
                    {contracts.map(c => <option key={c.contract_id} value={c.contract_id}>{c.filename}</option>)}
                  </select>
                </div>
                <div className="toolStub__field">
                  <label className="toolStub__label">Framework</label>
                  <select className="toolStub__select"><option>Company Policy</option><option>GDPR</option><option>SOX</option><option>CCPA</option><option>ISO 27001</option><option>Custom Rules</option></select>
                </div>
              </div>
              <button type="button" className="btn btn--primary" disabled>Run Compliance Check</button>
              <p className="toolStub__coming">Compliance verification coming soon.</p>
            </div>
          )}

          {/* ═══ BATCH ANALYSIS ═══ */}
          {toolSubView === "batch" && (
            <div className="toolStub">
              <div className="toolStub__icon"><svg width="48" height="48" viewBox="0 0 48 48" fill="none"><rect x="6" y="6" width="14" height="14" rx="3" stroke="var(--accent)" strokeWidth="2"/><rect x="28" y="6" width="14" height="14" rx="3" stroke="var(--accent)" strokeWidth="2"/><rect x="6" y="28" width="14" height="14" rx="3" stroke="var(--accent)" strokeWidth="2"/><rect x="28" y="28" width="14" height="14" rx="3" stroke="var(--accent)" strokeWidth="2"/></svg></div>
              <h2 className="toolStub__title">Batch Analysis</h2>
              <p className="toolStub__desc">Process your entire contract portfolio at once. Extract metadata, flag risks, score obligations, and build a knowledge base from hundreds of documents.</p>
              <div className="toolStub__stat">
                <span className="toolStub__statNum">{contracts.length}</span>
                <span className="toolStub__statLabel">contracts in repository</span>
              </div>
              <div className="toolStub__formGrid">
                <div className="toolStub__field toolStub__field--full">
                  <label className="toolStub__label">Analysis Tasks</label>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    {["Extract Metadata", "Clause Classification", "Risk Scoring", "Key Date Extraction", "Obligation Mapping"].map(t => (
                      <label key={t} style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 13 }}><input type="checkbox" defaultChecked /> {t}</label>
                    ))}
                  </div>
                </div>
              </div>
              <button type="button" className="btn btn--primary" disabled>Run Batch Analysis</button>
              <p className="toolStub__coming">Batch processing coming soon.</p>
            </div>
          )}

          {/* ═══ EXPORT CENTER ═══ */}
          {toolSubView === "export" && (
            <div className="toolStub">
              <div className="toolStub__icon"><svg width="48" height="48" viewBox="0 0 48 48" fill="none"><path d="M42 30v8a4 4 0 01-4 4H10a4 4 0 01-4-4v-8" stroke="var(--accent)" strokeWidth="2"/><polyline points="14,20 24,30 34,20" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/><line x1="24" y1="30" x2="24" y2="6" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round"/></svg></div>
              <h2 className="toolStub__title">Export Center</h2>
              <p className="toolStub__desc">Generate reports and data exports from your contract data. Choose from executive summaries, detailed analytics, or raw data formats.</p>
              <div className="toolStub__exportGrid">
                {[
                  { icon: "\u25A3", name: "PDF Report", desc: "Executive summary with risk overview" },
                  { icon: "\u25A6", name: "Excel Export", desc: "Full metadata and clause data" },
                  { icon: "\u25A4", name: "JSON Data", desc: "Structured data for integrations" },
                  { icon: "\u25A5", name: "Briefing Pack", desc: "Stakeholder-ready presentation" },
                ].map(exp => (
                  <button type="button" key={exp.name} className="toolStub__exportCard" onClick={() => showToast(`${exp.name} export coming soon.`)}>
                    <span style={{ fontSize: 24 }}>{exp.icon}</span>
                    <div className="toolStub__exportName">{exp.name}</div>
                    <div className="toolStub__exportDesc">{exp.desc}</div>
                  </button>
                ))}
              </div>
              <p className="toolStub__coming">Export functionality coming soon.</p>
            </div>
          )}

          </>
          )}

          {/* ═══ INSIGHTS DASHBOARD ═══ */}
          {view === "dashboard" && (
            <div className="insights">
              <aside className="insights__sidebar">
                <div className="insights__sideTitle">REPORTS</div>
                {[
                  { key: "overview", label: "Overview" },
                  { key: "contract_intelligence", label: "Contract Intelligence" },
                  { key: "risk_management", label: "Risk Management" },
                  { key: "procurement", label: "Procurement" },
                ].map(cat => (
                  <button
                    type="button" key={cat.key}
                    className={`insights__sideLink${insightsCategory === cat.key ? " insights__sideLink--active" : ""}`}
                    onClick={() => setInsightsCategory(cat.key)}
                  >{cat.label}</button>
                ))}
                <div className="insights__sideTitle" style={{ marginTop: 20 }}>CHARTS</div>
                {[
                  { key: "missing_terms", label: "Contracts With Missing Terms" },
                  { key: "counterparties", label: "Top Counterparties" },
                  { key: "timeline", label: "Contracts Over Time" },
                ].map(cat => (
                  <button
                    type="button" key={cat.key}
                    className={`insights__sideLink${insightsCategory === cat.key ? " insights__sideLink--active" : ""}`}
                    onClick={() => setInsightsCategory(cat.key)}
                  >{cat.label}</button>
                ))}
              </aside>
              <div className="insights__main">
                <div className="insights__header">
                  <h1 className="insights__title">Contract Intelligence</h1>
                </div>
                {insightsLoading && <div className="emptyState">Loading insights...</div>}
                {!insightsLoading && !insights && <div className="emptyState">Upload contracts to see insights.</div>}
                {!insightsLoading && insights && (
                  <>
                    {/* Summary Cards */}
                    <div className="insights__metrics">
                      <div className="insightMetric">
                        <div className="insightMetric__value">{insights.total_contracts}</div>
                        <div className="insightMetric__label">Total Contracts</div>
                      </div>
                      <div className="insightMetric">
                        <div className="insightMetric__value insightMetric__value--danger">{insights.risk_distribution.find(r => r.risk_level === "High")?.count || 0}</div>
                        <div className="insightMetric__label">High Risk</div>
                      </div>
                      <div className="insightMetric">
                        <div className="insightMetric__value insightMetric__value--warning">{insights.status_distribution.find(s => s.status === "Under Review")?.count || 0}</div>
                        <div className="insightMetric__label">Under Review</div>
                      </div>
                      <div className="insightMetric">
                        <div className="insightMetric__value insightMetric__value--accent">{insights.type_distribution.length}</div>
                        <div className="insightMetric__label">Contract Types</div>
                      </div>
                    </div>

                    {/* Chart Grid */}
                    <div className="insights__chartGrid">
                      {/* Contract Type Distribution - Donut */}
                      <div className="chartCard">
                        <div className="chartCard__title">Contract Types</div>
                        <div className="chartCard__subtitle">Repository data</div>
                        <ResponsiveContainer width="100%" height={260}>
                          <PieChart>
                            <Pie
                              data={insights.type_distribution}
                              dataKey="count"
                              nameKey="contract_type"
                              cx="50%" cy="50%"
                              innerRadius={55} outerRadius={95}
                              paddingAngle={2}
                              label={({ name, value }: { name?: string; value?: number }) => `${name || ""}: ${value || 0}`}
                            >
                              {insights.type_distribution.map((_, idx) => (
                                <Cell key={idx} fill={["#2a9d8f","#264653","#e9c46a","#f4a261","#e76f51","#457b9d","#6d6875","#b5838d"][idx % 8]} />
                              ))}
                            </Pie>
                            <Tooltip />
                          </PieChart>
                        </ResponsiveContainer>
                      </div>

                      {/* Status Distribution - Bar */}
                      <div className="chartCard">
                        <div className="chartCard__title">Contract Status</div>
                        <div className="chartCard__subtitle">Repository data</div>
                        <ResponsiveContainer width="100%" height={260}>
                          <BarChart data={insights.status_distribution} layout="vertical">
                            <CartesianGrid strokeDasharray="3 3" stroke="var(--border-light)" />
                            <XAxis type="number" tick={{ fontSize: 11 }} />
                            <YAxis dataKey="status" type="category" width={100} tick={{ fontSize: 11 }} />
                            <Tooltip />
                            <Bar dataKey="count" fill="#2a9d8f" radius={[0, 4, 4, 0]} />
                          </BarChart>
                        </ResponsiveContainer>
                      </div>

                      {/* Contracts Over Time - Line */}
                      {insights.contracts_over_time.length > 0 && (
                        <div className="chartCard">
                          <div className="chartCard__title">Contracts Over Time</div>
                          <div className="chartCard__subtitle">Repository data</div>
                          <ResponsiveContainer width="100%" height={260}>
                            <LineChart data={insights.contracts_over_time}>
                              <CartesianGrid strokeDasharray="3 3" stroke="var(--border-light)" />
                              <XAxis dataKey="month" tick={{ fontSize: 11 }} />
                              <YAxis tick={{ fontSize: 11 }} />
                              <Tooltip />
                              <Line type="monotone" dataKey="count" stroke="#264653" strokeWidth={2} dot={{ fill: "#264653", r: 4 }} />
                            </LineChart>
                          </ResponsiveContainer>
                        </div>
                      )}

                      {/* Missing Terms - Horizontal Bar */}
                      {insights.missing_terms.length > 0 && (
                        <div className="chartCard">
                          <div className="chartCard__title">Contracts With Missing Terms</div>
                          <div className="chartCard__subtitle">Repository data</div>
                          <ResponsiveContainer width="100%" height={260}>
                            <BarChart data={insights.missing_terms} layout="vertical">
                              <CartesianGrid strokeDasharray="3 3" stroke="var(--border-light)" />
                              <XAxis type="number" tick={{ fontSize: 11 }} />
                              <YAxis dataKey="clause" type="category" width={120} tick={{ fontSize: 10 }} />
                              <Tooltip />
                              <Bar dataKey="missing_count" fill="#e76f51" radius={[0, 4, 4, 0]} name="Missing Count" />
                            </BarChart>
                          </ResponsiveContainer>
                        </div>
                      )}

                      {/* Risk Distribution - Bar */}
                      {insights.risk_distribution.length > 0 && (
                        <div className="chartCard">
                          <div className="chartCard__title">Risk Distribution</div>
                          <div className="chartCard__subtitle">Repository data</div>
                          <ResponsiveContainer width="100%" height={260}>
                            <BarChart data={insights.risk_distribution}>
                              <CartesianGrid strokeDasharray="3 3" stroke="var(--border-light)" />
                              <XAxis dataKey="risk_level" tick={{ fontSize: 11 }} />
                              <YAxis tick={{ fontSize: 11 }} />
                              <Tooltip />
                              <Bar dataKey="count" radius={[4, 4, 0, 0]}>
                                {insights.risk_distribution.map((entry, idx) => (
                                  <Cell key={idx} fill={entry.risk_level === "High" ? "#e76f51" : entry.risk_level === "Medium" ? "#f4a261" : "#2a9d8f"} />
                                ))}
                              </Bar>
                            </BarChart>
                          </ResponsiveContainer>
                        </div>
                      )}

                      {/* Top Counterparties - Horizontal Bar */}
                      {insights.counterparty_distribution.length > 0 && (
                        <div className="chartCard">
                          <div className="chartCard__title">Top Counterparties</div>
                          <div className="chartCard__subtitle">Repository data</div>
                          <ResponsiveContainer width="100%" height={260}>
                            <BarChart data={insights.counterparty_distribution} layout="vertical">
                              <CartesianGrid strokeDasharray="3 3" stroke="var(--border-light)" />
                              <XAxis type="number" tick={{ fontSize: 11 }} />
                              <YAxis dataKey="counterparty" type="category" width={130} tick={{ fontSize: 10 }} />
                              <Tooltip />
                              <Bar dataKey="count" fill="#457b9d" radius={[0, 4, 4, 0]} />
                            </BarChart>
                          </ResponsiveContainer>
                        </div>
                      )}
                    </div>

                    {/* Recent Contracts Table */}
                    <div className="chartCard" style={{ marginTop: 16 }}>
                      <div className="chartCard__title">Recent Contracts</div>
                      {insights.recent_contracts.length === 0 ? (
                        <p style={{ fontSize: 13, color: "var(--text-muted)", padding: 16 }}>No contracts yet.</p>
                      ) : (
                        <table className="insightsTable">
                          <thead><tr><th>Name</th><th>Type</th><th>Counterparty</th><th>Status</th><th>Risk</th></tr></thead>
                          <tbody>
                            {insights.recent_contracts.map(c => (
                              <tr key={c.contract_id} onClick={() => void openContract(c.contract_id)} style={{ cursor: "pointer" }}>
                                <td className="insightsTable__name">{c.filename}</td>
                                <td><span className="typeBadge">{c.contract_type || "—"}</span></td>
                                <td>{c.counterparty || "—"}</td>
                                <td><span className={`statusBadge statusBadge--${(c.status || "").toLowerCase().replace(/\s+/g, "")}`}>{c.status || "—"}</span></td>
                                <td><span className={`riskBadge riskBadge--${(c.risk_level || "none").toLowerCase()}`}>{c.risk_level || "—"}</span></td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                    </div>
                  </>
                )}
              </div>
            </div>
          )}

          {/* ═══ CONTRACT DETAIL ═══ */}
          {view === "detail" && selectedContract && (
            <div className="contractDetail">
              {/* HEADER + TABS */}
              <div className="contractDetail__header">
                <div className="contractDetail__breadcrumbRow">
                  <button type="button" className="contractDetail__backIcon" onClick={() => navTo("documents")} aria-label="Back to documents">
                    <svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M12.5 15l-5-5 5-5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg>
                  </button>
                  <nav className="contractDetail__breadcrumb">
                    <button type="button" className="contractDetail__breadcrumbLink" onClick={() => navTo("documents")}>Documents</button>
                    <span className="contractDetail__breadcrumbSep">/</span>
                    {selectedContract.contract_type && (
                      <>
                        <span className="contractDetail__breadcrumbText">{selectedContract.contract_type}</span>
                        <span className="contractDetail__breadcrumbSep">/</span>
                      </>
                    )}
                    <span className="contractDetail__breadcrumbCurrent">{selectedContract.filename}</span>
                  </nav>
                </div>

                <div className="contractDetail__titleBlock">
                  <h1 className="contractDetail__title">
                    {selectedContract.contract_type && selectedContract.counterparty
                      ? `${selectedContract.contract_type} – ${selectedContract.counterparty}`
                      : selectedContract.contract_type
                        ? `${selectedContract.contract_type} – ${selectedContract.filename}`
                        : selectedContract.filename}
                  </h1>
                  <p className="contractDetail__desc">
                    {summaryView.byKey.summary
                      || summaryView.byKey.description
                      || summaryView.byKey.overview
                      || (summaryView.entries.length > 0 ? summaryView.entries[0].value : null)
                      || (selectedContract.contract_type
                        ? `${selectedContract.contract_type} document uploaded for review and analysis.`
                        : "Contract document uploaded for review and analysis.")}
                  </p>
                </div>

                <div className="contractDetail__metaGrid">
                  <div className="contractDetail__metaField">
                    <span className="contractDetail__metaLabel">Doc ID</span>
                    <span className="contractDetail__metaValue">
                      {selectedContract.contract_id.slice(0, 8)}
                      <button
                        type="button"
                        className="contractDetail__copyBtn"
                        aria-label="Copy document ID"
                        onClick={() => {
                          navigator.clipboard.writeText(selectedContract.contract_id);
                          setCopiedId(true);
                          setTimeout(() => setCopiedId(false), 1500);
                        }}
                      >
                        {copiedId ? (
                          <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M3.5 7.5l2 2 5-5" stroke="#059669" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                        ) : (
                          <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><rect x="4.5" y="4.5" width="7" height="7" rx="1.2" stroke="currentColor" strokeWidth="1.2"/><path d="M9.5 4.5V3.3A1.3 1.3 0 008.2 2H3.3A1.3 1.3 0 002 3.3v4.9a1.3 1.3 0 001.3 1.3h1.2" stroke="currentColor" strokeWidth="1.2"/></svg>
                        )}
                      </button>
                    </span>
                  </div>
                  <div className="contractDetail__metaField">
                    <span className="contractDetail__metaLabel">Contract Type</span>
                    <span className="contractDetail__metaValue">
                      {selectedContract.contract_type
                        ? <span className="typeBadge">{selectedContract.contract_type}</span>
                        : <span className="text-muted">—</span>}
                    </span>
                  </div>
                  <div className="contractDetail__metaField">
                    <span className="contractDetail__metaLabel">Parties</span>
                    <span className="contractDetail__metaValue">{selectedContract.counterparty || <span className="text-muted">—</span>}</span>
                  </div>
                  <div className="contractDetail__metaField">
                    <span className="contractDetail__metaLabel">Status</span>
                    <span className="contractDetail__metaValue">
                      <span className={`statusBadge statusBadge--${(selectedContract.status || "Under Review").toLowerCase().replace(/\s/g, "")}`}>
                        {selectedContract.status || "Under Review"}
                      </span>
                    </span>
                  </div>
                  <div className="contractDetail__metaField">
                    <span className="contractDetail__metaLabel">Risk Level</span>
                    <span className="contractDetail__metaValue">
                      {selectedContract.risk_level
                        ? <span className={`riskBadge riskBadge--${selectedContract.risk_level.toLowerCase()}`}>{selectedContract.risk_level}</span>
                        : (result ? <span className={`riskBadge riskBadge--${riskLevel.toLowerCase()}`}>{riskLevel}</span> : <span className="text-muted">—</span>)}
                    </span>
                  </div>
                  <div className="contractDetail__metaField">
                    <span className="contractDetail__metaLabel">Upload Date</span>
                    <span className="contractDetail__metaValue">{new Date(selectedContract.created_at).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" })}</span>
                  </div>
                </div>

                <div className="tabBar">
                  {(["overview", "contents", "lifecycle", "analytics", "comments", "activity"] as DetailTab[]).map(t => {
                    const labels: Record<string, string> = { overview: "Overview", contents: "Contents", lifecycle: "Lifecycle", analytics: "Analytics", comments: `Comments (${comments.length})`, activity: "Activity" };
                    return (
                      <button type="button" key={t} className={`tabBar__tab${detailTab === t ? " tabBar__tab--active" : ""}`} onClick={() => setDetailTab(t)}>
                        {labels[t] || t}
                      </button>
                    );
                  })}
                  <button type="button" className={`tabBar__debugBtn${showDebug ? " tabBar__debugBtn--active" : ""}`} onClick={() => setShowDebug(v => !v)} title="Debug / Trace Mode">
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 1v2m0 8v2M1 7h2m8 0h2M3.05 3.05l1.41 1.41m5.08 5.08l1.41 1.41M3.05 10.95l1.41-1.41m5.08-5.08l1.41-1.41" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/><circle cx="7" cy="7" r="2.5" stroke="currentColor" strokeWidth="1.2"/></svg>
                    Debug
                  </button>
                </div>
              </div>

              {error && <p className="errorBanner">{error}</p>}

              {/* Analysis progress bar */}
              {analysisPhase && (
                <div className="analysisBar">
                  <div className="analysisBar__inner">
                    <div className="analysisBar__icon">
                      {analysisProgress < 100 ? (
                        <div className="analysisBar__spinner" />
                      ) : (
                        <svg width="18" height="18" viewBox="0 0 18 18" fill="none"><circle cx="9" cy="9" r="8" stroke="#22c55e" strokeWidth="2"/><path d="M5.5 9.5l2 2 5-5" stroke="#22c55e" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                      )}
                    </div>
                    <div className="analysisBar__content">
                      <div className="analysisBar__header">
                        <span className="analysisBar__phase">{analysisPhase}</span>
                        <span className="analysisBar__pct">{analysisProgress}%</span>
                      </div>
                      <div className="analysisBar__track">
                        <div className="analysisBar__fill" style={{ width: `${analysisProgress}%` }} />
                      </div>
                      {analysisProgress < 100 && <span className="analysisBar__eta">Usually takes 30–60 seconds</span>}
                    </div>
                  </div>
                </div>
              )}

              {loading && loadingLabel === "loading" && !analysisPhase && (
                <div style={{ padding: 40, textAlign: "center" }}><div className="loadingDots" style={{ justifyContent: "center" }}><span /><span /><span /></div></div>
              )}

              {/* ── TAB: OVERVIEW ── */}
              {detailTab === "overview" && (
                <div className="tabBody">
                  <div className="overviewTab">
                    <div className="overviewCard">
                      <div className="overviewCard__title">Key Information</div>
                      {summaryView.entries.length === 0 ? (
                        analysisPhase && analysisProgress < 100 ? (
                          <div className="skeletonGroup">
                            {[1,2,3,4,5].map(i => <div key={i} className="skeleton skeleton--row" />)}
                          </div>
                        ) : (
                          <div style={{ textAlign: "center", padding: "12px 0" }}>
                            <p style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 10 }}>Contract has not been analyzed yet.</p>
                            <button type="button" className="btn btn--primary btn--sm" onClick={() => contractId && void runAutoAnalysis(contractId)}>Analyze Now</button>
                          </div>
                        )
                      ) : summaryView.entries.slice(0, 7).map(e => (
                        <div key={e.key} className="overviewCard__row">
                          <span className="overviewCard__label">{e.label}</span>
                          <span className="overviewCard__value">{e.value}</span>
                        </div>
                      ))}
                    </div>
                    <div className="overviewCard">
                      <div className="overviewCard__title">Risk Summary</div>
                      {risks.length === 0 ? (
                        analysisPhase && analysisProgress < 100 ? (
                          <div className="skeletonGroup">
                            <div className="skeleton skeleton--circle" />
                            {[1,2].map(i => <div key={i} className="skeleton skeleton--row" style={{ width: `${70 - i * 15}%` }} />)}
                          </div>
                        ) : (
                          <p style={{ fontSize: 13, color: "var(--text-muted)" }}>No risks flagged yet.</p>
                        )
                      ) : (
                        <>
                          <div className="riskScoreMini">
                            <div className={`riskScoreMini__circle riskScoreMini__circle--${riskTone(riskLevel)}`}>{overallRisk}</div>
                            <div>
                              <div className="riskScoreMini__text">{riskLevel} Risk</div>
                              <div className="riskScoreMini__sub">{risks.length} issue{risks.length !== 1 ? "s" : ""} flagged</div>
                            </div>
                          </div>
                          <div style={{ marginTop: 12 }}>
                            {risks.slice(0, 3).map(r => (
                              <div key={r.risk_id} style={{ fontSize: 12, color: "var(--text-secondary)", padding: "3px 0" }}>
                                &#8226; <strong>{prettify(r.risk_type)}</strong>: {r.reason}
                              </div>
                            ))}
                          </div>
                        </>
                      )}
                    </div>
                    <div className="overviewCard">
                      <div className="overviewCard__title">Contract Metadata</div>
                      <div className="overviewCard__row"><span className="overviewCard__label">Filename</span><span className="overviewCard__value">{selectedContract.filename}</span></div>
                      <div className="overviewCard__row"><span className="overviewCard__label">Sections Indexed</span><span className="overviewCard__value">{chunks.length}</span></div>
                      <div className="overviewCard__row"><span className="overviewCard__label">Status</span><span className="overviewCard__value"><span className="statusBadge">Active</span></span></div>
                    </div>
                    <div className="overviewCard">
                      <div className="overviewCard__title">Quick Actions</div>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                        <button type="button" className="btn btn--primary btn--sm" onClick={() => { setDetailTab("contents"); setShowAI(true); }}>Ask AI</button>
                        <button type="button" className="btn btn--sm" onClick={() => { setDetailTab("contents"); setPanelTab("review"); }}>View Provisions</button>
                        <button type="button" className="btn btn--sm" onClick={() => setDetailTab("lifecycle")}>Lifecycle</button>
                        <button type="button" className="btn btn--sm" onClick={() => setDetailTab("analytics")}>Analytics</button>
                        <button type="button" className="btn btn--sm" onClick={async () => {
                          const wf = await createWorkflow({ name: "Standard Review", contract_id: selectedContract.contract_id, steps: [
                            { title: "AI Analysis", step_type: "review", assignee: "AI" },
                            { title: "Legal Review", step_type: "review", assignee: "Legal Team" },
                            { title: "Risk Assessment", step_type: "review", assignee: "Risk Manager" },
                            { title: "Final Approval", step_type: "approve", assignee: "Director" },
                          ] });
                          showToast(`Workflow "${wf.name}" created`);
                        }}>Route to Legal</button>
                        <button type="button" className="btn btn--sm" onClick={async () => {
                          const wf = await createWorkflow({ name: "Approval Request", contract_id: selectedContract.contract_id, steps: [
                            { title: "Review Complete", step_type: "review", assignee: "User" },
                            { title: "Request Approval", step_type: "approve", assignee: "Manager" },
                          ] });
                          showToast(`Workflow "${wf.name}" created`);
                        }}>Request Approval</button>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* ── TAB: CONTENTS (split-panel) ── */}
              {detailTab === "contents" && (
                <div className={`contentsTab${focusMode ? " contentsTab--focus" : ""}`}>
                  <button type="button" className="focusModeBtn" title={focusMode ? "Exit Focus Mode" : "Focus Mode — expand PDF"} onClick={() => setFocusMode(f => !f)}>
                    {focusMode ? (
                      <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M6 2H3a1 1 0 00-1 1v3m0 4v3a1 1 0 001 1h3m4 0h3a1 1 0 001-1v-3m0-4V3a1 1 0 00-1-1h-3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>
                    ) : (
                      <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M2 6V3a1 1 0 011-1h3m4 0h3a1 1 0 011 1v3m0 4v3a1 1 0 01-1 1h-3m-4 0H3a1 1 0 01-1-1v-3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>
                    )}
                  </button>
                  {/* Left: PDF viewer */}
                  <div className="contentsTab__doc">
                    {selectedContract.filename.toLowerCase().endsWith(".pdf") ? (
                      <PdfViewer
                        fileUrl={getContractFileUrl(selectedContract.contract_id)}
                        chunks={chunks}
                        highlightedList={effectiveHighlightedList}
                        highlightMode={effectiveHighlightMode}
                        highlightIndex={effectiveHighlightIndex}
                        highlightTotal={effectiveHighlightedList.length}
                        onPrev={() => {
                          if (isAskAiActive) {
                            setAskAiFocusIdx(prev => (prev - 1 + askAiHighlightList.length) % askAiHighlightList.length);
                          } else { navigateHighlight(-1); }
                        }}
                        onNext={() => {
                          if (isAskAiActive) {
                            setAskAiFocusIdx(prev => (prev + 1) % askAiHighlightList.length);
                          } else { navigateHighlight(1); }
                        }}
                        contractName={selectedContract.filename}
                        riskAnnotations={isAskAiActive ? [] : clauseAssessments.map(a => ({ chunk_id: a.chunk_id, risk_level: a.risk_level, risk_score: a.risk_score, clause_type: a.clause_type }))}
                        categoryColor={effectiveCategoryColor}
                        activeGroupName={effectiveGroupName}
                        activeAssessment={effectiveAssessment}
                        onChunkClick={(cid) => {
                          if (isAskAiActive) return;
                          const assessment = clauseAssessments.find(a => a.chunk_id === cid);
                          if (assessment) { setSelectedAssessment(assessment); setPanelTab("review"); }
                        }}
                        onBadgeClick={(clauseType) => {
                          if (isAskAiActive) return;
                          const assessment = clauseAssessments.find(a => a.clause_type === clauseType);
                          if (assessment) { setSelectedAssessment(assessment); setPanelTab("review"); }
                        }}
                        pulse={hlPulse}
                      />
                    ) : (
                      <DocumentViewer
                        chunks={chunks}
                        highlights={highlights}
                        highlightedIds={highlightedChunkIds}
                        highlightMode={highlightMode}
                        currentChunkId={highlightedList[highlightIndex]?.chunk_id || null}
                        scrollToChunkId={scrollToChunkRef.current}
                        onScrollDone={() => { scrollToChunkRef.current = null; }}
                        contractName={selectedContract.filename}
                        totalChunks={chunks.length}
                        highlightIndex={highlightIndex}
                        highlightTotal={highlightedList.length}
                        onPrev={() => navigateHighlight(-1)}
                        onNext={() => navigateHighlight(1)}
                      />
                    )}
                  </div>

                  {/* Right: tabbed panel */}
                  <div className="contentsPanel">
                    <div className="contentsPanel__tabs">
                      {(["structure", "review", "keyinfo"] as ContentsPanelTab[]).map(t => {
                        const labels: Record<ContentsPanelTab, string> = { structure: "Structure", review: "Review", keyinfo: "Key Info" };
                        return (
                          <button type="button" key={t} className={`contentsPanel__tab${panelTab === t ? " contentsPanel__tab--active" : ""}`} onClick={() => setPanelTab(t)}>
                            {labels[t]}
                          </button>
                        );
                      })}
                    </div>
                    <div className="contentsPanel__body">

                      {/* ── STRUCTURE ── */}
                      {panelTab === "structure" && (
                        <div className="panelSection">
                          <p className="panelSection__hint">Document outline — click a section to scroll to it.</p>
                          {sectionTree.length === 0 ? (
                            <p className="panelSection__empty">No sections detected. Upload and analyze the document first.</p>
                          ) : (
                            <div className="structureTree">
                              {sectionTree.map((s, i) => (
                                <button
                                  type="button"
                                  key={`${s.chunkId}-${i}`}
                                  className="structureTree__item"
                                  onClick={() => {
                                    scrollToChunkRef.current = s.chunkId;
                                    if (s.page) {
                                      const iframe = document.querySelector<HTMLIFrameElement>(".pdfViewer__frame");
                                      iframe?.contentWindow?.postMessage({ type: "navigate", payload: { page: s.page } }, "*");
                                    }
                                  }}
                                >
                                  <span className="structureTree__icon">
                                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><rect x="1" y="2" width="10" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.1"/><path d="M3.5 5h5M3.5 7.2h3" stroke="currentColor" strokeWidth="1" strokeLinecap="round"/></svg>
                                  </span>
                                  <span className="structureTree__name">{s.section}</span>
                                  {s.page != null && <span className="structureTree__page">p.{s.page}</span>}
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                      )}

                      {/* ── REVIEW (unified) ── */}
                      {panelTab === "review" && (
                        <div className="panelSection">
                          {selectedAssessment ? (
                            <div className="clauseIntel">
                              <button type="button" className="clauseIntel__back" onClick={() => setSelectedAssessment(null)}>
                                <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M8.5 3L4.5 7l4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                                Back to Review
                              </button>
                              <div className="clauseIntel__header">
                                <span className="clauseIntel__title">{prettify(selectedAssessment.clause_type)}</span>
                                <span className={`clauseIntel__level clauseIntel__level--${selectedAssessment.risk_level}`}>
                                  {selectedAssessment.risk_level.toUpperCase()} RISK
                                </span>
                              </div>
                              <div className="clauseIntel__score">
                                <div className="clauseIntel__scoreBar">
                                  <div className="clauseIntel__scoreFill" style={{ width: `${selectedAssessment.risk_score}%`, background: selectedAssessment.risk_level === "high" ? "var(--risk-high)" : selectedAssessment.risk_level === "medium" ? "var(--risk-medium)" : "var(--risk-low)" }} />
                                </div>
                                <span className="clauseIntel__scoreNum">{selectedAssessment.risk_score}/100</span>
                              </div>
                              <div className="clauseIntel__section">
                                <div className="clauseIntel__sectionTitle">AI Assessment</div>
                                <p className="clauseIntel__text">{selectedAssessment.reason}</p>
                              </div>
                              {selectedAssessment.deviation && (
                                <div className="clauseIntel__section">
                                  <div className="clauseIntel__sectionTitle">Deviation from Standard</div>
                                  <p className="clauseIntel__text">{selectedAssessment.deviation}</p>
                                </div>
                              )}
                              {selectedAssessment.recommendation && (
                                <div className="clauseIntel__section">
                                  <div className="clauseIntel__sectionTitle">Recommendation</div>
                                  <p className="clauseIntel__text clauseIntel__text--rec">{selectedAssessment.recommendation}</p>
                                </div>
                              )}
                              {selectedAssessment.standard_clause && (
                                <div className="clauseIntel__section">
                                  <div className="clauseIntel__sectionTitle">Standard Language (Playbook)</div>
                                  <p className="clauseIntel__text clauseIntel__text--standard">{selectedAssessment.standard_clause}</p>
                                </div>
                              )}
                              {selectedAssessment.chunk_id && (
                                <button type="button" className="btn btn--sm btn--primary" style={{ marginTop: 12 }} onClick={() => {
                                  jumpToClauseGroup(selectedAssessment.clause_type);
                                  const iframe = document.querySelector<HTMLIFrameElement>(".pdfViewer__frame");
                                  const chunk = chunks.find(c => c.chunk_id === selectedAssessment.chunk_id);
                                  if (chunk?.page && iframe?.contentWindow) {
                                    iframe.contentWindow.postMessage({ type: "navigate", payload: { page: chunk.page } }, "*");
                                  }
                                }}>
                                  View in Document
                                </button>
                              )}
                              <div className="clauseIntel__annotate">
                                <button type="button" className="annotateBtn" onClick={() => { setAnnotatingClause(annotatingClause === selectedAssessment.clause_type ? null : selectedAssessment.clause_type); setAnnotationText(savedAnnotations[selectedAssessment.clause_type] || ""); }}>
                                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 10l1-3.5L8.5 1 11 3.5 5.5 9z" stroke="currentColor" strokeWidth="1" strokeLinejoin="round"/><path d="M2 10h2.5" stroke="currentColor" strokeWidth="1" strokeLinecap="round"/></svg>
                                  {savedAnnotations[selectedAssessment.clause_type] ? "Edit Note" : "Add Note"}
                                </button>
                                <button type="button" className="annotateBtn" onClick={() => showToast("Suggest Edit: coming soon — redline editing will be available in a future release")}>
                                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M6 1v10M1 6h10" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/></svg>
                                  Suggest Edit
                                </button>
                              </div>
                              {annotatingClause === selectedAssessment.clause_type && (
                                <div className="annotateInline">
                                  <textarea
                                    className="annotateInline__input"
                                    placeholder="Add your notes, corrections, or suggested language..."
                                    value={annotationText}
                                    onChange={e => setAnnotationText(e.target.value)}
                                  />
                                  <div className="annotateInline__bar">
                                    <button type="button" className="btn btn--sm" onClick={() => setAnnotatingClause(null)}>Cancel</button>
                                    <button type="button" className="btn btn--sm btn--primary" onClick={() => {
                                      setSavedAnnotations(prev => ({ ...prev, [selectedAssessment.clause_type]: annotationText }));
                                      setAnnotatingClause(null);
                                      showToast("Note saved");
                                    }}>Save Note</button>
                                  </div>
                                </div>
                              )}
                              {savedAnnotations[selectedAssessment.clause_type] && annotatingClause !== selectedAssessment.clause_type && (
                                <div className="clauseIntel__section" style={{ marginTop: 8 }}>
                                  <div className="clauseIntel__sectionTitle">Your Note</div>
                                  <p className="clauseIntel__text" style={{ fontStyle: "italic", background: "var(--highlight-clause)", padding: "8px 10px", borderRadius: 6 }}>{savedAnnotations[selectedAssessment.clause_type]}</p>
                                </div>
                              )}
                            </div>
                          ) : analysisPhase && analysisProgress < 100 ? (
                            <div className="reviewLoading">
                              <div className="reviewLoading__icon">
                                <div className="analysisBar__spinner" />
                              </div>
                              <div className="reviewLoading__text">
                                <strong>Analysis in progress</strong>
                                <span>{analysisPhase}</span>
                              </div>
                              <div className="reviewLoading__bar">
                                <div className="reviewLoading__barFill" style={{ width: `${analysisProgress}%` }} />
                              </div>
                              <p className="reviewLoading__hint">Review details will appear here once analysis completes.</p>
                            </div>
                          ) : (
                            <>
                              {/* ── Collapse / Expand All ── */}
                              <div className="reviewCollapseBar">
                                <button type="button" className="reviewCollapseBar__btn" onClick={() => setCollapsed({ summary: false, risk: false, missing: false, compliance: false, keywords: false })}>
                                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 4l4 4 4-4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>
                                  Expand All
                                </button>
                                <button type="button" className="reviewCollapseBar__btn" onClick={() => setCollapsed({ summary: true, risk: true, missing: true, compliance: true, keywords: true })}>
                                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M4 2l4 4-4 4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>
                                  Collapse All
                                </button>
                              </div>

                              {/* ── Section 1: AI Summary and Decision (collapsible) ── */}
                              <div className="collapsibleSection collapsibleSection--summary">
                                <button type="button" className="collapsibleSection__header collapsibleSection__header--summary" onClick={() => setCollapsed(p => ({ ...p, summary: !p.summary }))}>
                                  <svg className={`collapsibleSection__chevron${collapsed.summary ? "" : " collapsibleSection__chevron--open"}`} width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M5.5 3l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                                  <span className="collapsibleSection__title">AI Summary &amp; Decision</span>
                                  <span className="sectionInfo" onClick={e => { e.stopPropagation(); setOpenSectionInfo(openSectionInfo === "summary" ? null : "summary"); }}>
                                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.2"/><path d="M8 7v4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/><circle cx="8" cy="5" r="0.7" fill="currentColor"/></svg>
                                  </span>
                                  {aiSummary && <span className="collapsibleSection__badge collapsibleSection__badge--ok">&#10003; Generated</span>}
                                </button>
                                {openSectionInfo === "summary" && <div className="sectionInfo__popover"><button type="button" className="sectionInfo__close" onClick={() => setOpenSectionInfo(null)}>&times;</button>{SECTION_INFO.summary}</div>}
                                {!collapsed.summary && (
                                <div className="reviewSummaryCard__wrap">
                                <div className="reviewSummaryCard__aiSection">
                                  {aiSummary ? (
                                    <p className="reviewSummaryCard__text">{aiSummary}</p>
                                  ) : (
                                    <p className="reviewSummaryCard__placeholder">
                                      {clauseAssessments.length > 0
                                        ? "Click \u201cGenerate Summary\u201d to create an AI executive overview."
                                        : "Run risk assessment first, then generate a summary."}
                                    </p>
                                  )}
                                  <div className="reviewSummaryCard__stats">
                                    <span title="Total clause types detected by AI">{clauseAssessments.length} Clauses Detected</span>
                                    <span title="Required clauses from the Clause Library that were not found">{clauseGaps.filter(c => c.required && c.status === "missing").length} Missing Required</span>
                                    <span title="Clauses where AI assigned a risk level of High">{clauseAssessments.filter(a => a.risk_level === "high").length} High Risk</span>
                                    <span title="Average of all individual clause risk scores (0-100). Lower is better.">{overallScore !== null ? `Score: ${overallScore}/100` : "Score: \u2014"}</span>
                                  </div>
                                  {clauseAssessments.length > 0 && !aiSummary && (
                                    <button type="button" className="btn btn--sm btn--primary" disabled={summaryLoading} onClick={async () => {
                                      if (!selectedContract) return;
                                      setSummaryLoading(true);
                                      try {
                                        const resp = await generateReviewSummary(selectedContract.contract_id);
                                        setAiSummary(resp.ai_summary || "");
                                        setOverallScore(resp.overall_score ?? null);
                                        showToast("AI summary generated");
                                      } catch { showToast("Failed to generate summary."); }
                                      setSummaryLoading(false);
                                    }}>{summaryLoading ? "Generating…" : "Generate Summary"}</button>
                                  )}
                                </div>
                                <div className="reviewSummaryCard__decisionSection">
                                  <div className="reviewSummaryCard__decisionLabel">Reviewer Decision</div>
                                  <div className="reviewSummaryCard__decisionBtns">
                                    {(["approve", "request_changes", "reject"] as const).map(d => {
                                      const labels: Record<string, string> = { approve: "Approve", request_changes: "Request Changes", reject: "Reject" };
                                      const cls = d === "approve" ? "btn--approve" : d === "reject" ? "btn--reject" : "btn--changes";
                                      return (
                                        <button key={d} type="button" className={`btn btn--sm reviewDecisionBtn ${cls}${reviewDecision === d ? " reviewDecisionBtn--active" : ""}`} disabled={savingDecision} onClick={async () => {
                                          if (!selectedContract) return;
                                          setSavingDecision(true);
                                          try {
                                            const resp = await saveReviewDecision(selectedContract.contract_id, d, reviewerNotes || undefined);
                                            setReviewDecision(resp.decision);
                                            setReviewDecidedAt(resp.decided_at);
                                            setReviewDecidedBy(resp.decided_by);
                                            showToast(`Decision: ${labels[d]}`);
                                          } catch { showToast("Failed to save decision."); }
                                          setSavingDecision(false);
                                        }}>{labels[d]}</button>
                                      );
                                    })}
                                  </div>
                                  <textarea className="reviewSummaryCard__notes" placeholder="Reviewer notes…" value={reviewerNotes} onChange={e => setReviewerNotes(e.target.value)} onBlur={async () => {
                                    if (!selectedContract || !reviewerNotes) return;
                                    try { await saveReviewDecision(selectedContract.contract_id, reviewDecision, reviewerNotes); } catch { /* silent */ }
                                  }} />
                                  {reviewDecidedAt && (
                                    <div className="reviewSummaryCard__meta">
                                      {reviewDecision !== "pending" ? `${reviewDecision === "approve" ? "Approved" : reviewDecision === "reject" ? "Rejected" : "Changes Requested"} by ${reviewDecidedBy || "analyst"} on ${new Date(reviewDecidedAt).toLocaleDateString()}` : ""}
                                    </div>
                                  )}
                                </div>
                                </div>
                                )}
                              </div>

                              {/* ── Section 2: Risk Overview (collapsible) ── */}
                              <div className="collapsibleSection">
                                <button type="button" className="collapsibleSection__header" onClick={() => setCollapsed(p => ({ ...p, risk: !p.risk }))}>
                                  <svg className={`collapsibleSection__chevron${collapsed.risk ? "" : " collapsibleSection__chevron--open"}`} width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M5.5 3l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                                  <span className="collapsibleSection__title">Risk Overview</span>
                                  <span className="sectionInfo" onClick={e => { e.stopPropagation(); setOpenSectionInfo(openSectionInfo === "risk" ? null : "risk"); }}>
                                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.2"/><path d="M8 7v4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/><circle cx="8" cy="5" r="0.7" fill="currentColor"/></svg>
                                  </span>
                                  {clauseAssessments.length > 0 && (
                                    <span className="collapsibleSection__badge collapsibleSection__badge--risk">{clauseAssessments.filter(a => a.risk_level === "high").length} High Risk</span>
                                  )}
                                </button>
                                {openSectionInfo === "risk" && <div className="sectionInfo__popover"><button type="button" className="sectionInfo__close" onClick={() => setOpenSectionInfo(null)}>&times;</button>{SECTION_INFO.risk}</div>}
                                {!collapsed.risk && (
                                  <div className="collapsibleSection__body">
                                    <div className="panelSection__topBar">
                                      <p className="panelSection__hint">Click a clause type to highlight it in the PDF. Click the chevron for full assessment.</p>
                                      <div className="panelSection__topBarActions">
                                        <label className="panelSection__toggle"><input type="checkbox" checked={hideLowRisk} onChange={e => setHideLowRisk(e.target.checked)} /> <span>Hide Low Risk</span></label>
                                        {clauseAssessments.length === 0 && clauseGroups.length > 0 && (
                                          <button type="button" className="btn btn--sm btn--primary" disabled={assessmentRunning} onClick={async () => {
                                            if (!selectedContract) return;
                                            setAssessmentRunning(true);
                                            try {
                                              const resp = await runClauseAssessments(selectedContract.contract_id);
                                              setClauseAssessments((resp.assessments || []) as ClauseAssessment[]);
                                              showToast(`Assessed ${resp.assessments?.length || 0} clauses`);
                                            } catch { showToast("Risk assessment failed. Please try again."); }
                                            setAssessmentRunning(false);
                                          }}>{assessmentRunning ? "Assessing…" : "Run Risk Assessment"}</button>
                                        )}
                                      </div>
                                    </div>

                                    {clauseAssessments.length > 0 && (
                                      <div className="riskSummaryBar">
                                        <span className="riskSummaryBar__item riskSummaryBar__item--high">{clauseAssessments.filter(a => a.risk_level === "high").length} High</span>
                                        <span className="riskSummaryBar__item riskSummaryBar__item--medium">{clauseAssessments.filter(a => a.risk_level === "medium").length} Medium</span>
                                        <span className="riskSummaryBar__item riskSummaryBar__item--low">{clauseAssessments.filter(a => a.risk_level === "low").length} Low</span>
                                      </div>
                                    )}

                                    <div className="clauseList">
                                      {clauseGroups
                                        .map(g => {
                                          const assessment = clauseAssessments.find(a => a.clause_type === g.key);
                                          return { ...g, assessment };
                                        })
                                        .filter(g => !hideLowRisk || g.assessment?.risk_level !== "low")
                                        .sort((a, b) => (b.assessment?.risk_score ?? -1) - (a.assessment?.risk_score ?? -1))
                                        .map(g => {
                                          const dotClass = g.key.includes("term_and") ? "term" : g.key.includes("terminat") ? "termination" : g.key.includes("liab") ? "liability" : g.key.includes("payment") ? "payment" : g.key.includes("confid") ? "confidentiality" : g.key.includes("intellect") ? "ip" : "governing";
                                          const isActive = activeClauseGroup === g.key;
                                          return (
                                            <div key={g.key} className={`clauseItemRow${isActive ? " clauseItemRow--active" : ""}`}>
                                              <button type="button" className="clauseItem clauseItem--row" onClick={() => jumpToClauseGroup(g.key)}>
                                                <span className="clauseItem__left">
                                                  <span className={`clauseItem__dot clauseItem__dot--${dotClass}`} />
                                                  <span className="clauseItem__name">{g.name}</span>
                                                  {CLAUSE_TOOLTIPS[g.key] && (
                                                    <span className="clauseItem__info" title={CLAUSE_TOOLTIPS[g.key]}>
                                                      <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><circle cx="6" cy="6" r="5" stroke="currentColor" strokeWidth="1"/><path d="M6 5.2V8.5" stroke="currentColor" strokeWidth="1" strokeLinecap="round"/><circle cx="6" cy="3.7" r="0.5" fill="currentColor"/></svg>
                                                    </span>
                                                  )}
                                                </span>
                                                <span className="clauseItem__right">
                                                  {g.assessment && (
                                                    <span className={`clauseItem__riskBadge clauseItem__riskBadge--${g.assessment.risk_level}`} title={`${g.assessment.risk_level === "high" ? "High" : g.assessment.risk_level === "medium" ? "Medium" : "Low"} Risk: ${g.assessment.risk_score}/100 — AI-assessed risk for this clause type`}>
                                                      {g.assessment.risk_level === "high" ? "High" : g.assessment.risk_level === "medium" ? "Med" : "Low"}
                                                      <span className="clauseItem__riskScore">{g.assessment.risk_score}</span>
                                                    </span>
                                                  )}
                                                  <span className="clauseItem__badge" title="Number of text sections containing this clause type">{g.items.length}</span>
                                                </span>
                                              </button>
                                              {g.assessment && (
                                                <button type="button" className="clauseItem__intelBtn" title="View risk detail" onClick={() => setSelectedAssessment(g.assessment!)}>
                                                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M5.5 3l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                                                </button>
                                              )}
                                            </div>
                                          );
                                        })}
                                      {clauseGroups.length === 0 && <p className="panelSection__empty">Run analysis to detect clause types.</p>}
                                    </div>
                                  </div>
                                )}
                              </div>

                              {/* ── Section 3: Missing Clauses (collapsible) ── */}
                              {(() => {
                                const missingRequired = clauseGaps.filter(c => c.required && c.status === "missing");
                                const hasMissing = missingRequired.length > 0;
                                return (
                                  <div className="collapsibleSection">
                                    <button type="button" className="collapsibleSection__header" onClick={() => setCollapsed(p => ({ ...p, missing: !p.missing }))}>
                                      <svg className={`collapsibleSection__chevron${collapsed.missing ? "" : " collapsibleSection__chevron--open"}`} width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M5.5 3l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                                      <span className="collapsibleSection__title">Missing Clauses</span>
                                      <span className="sectionInfo" onClick={e => { e.stopPropagation(); setOpenSectionInfo(openSectionInfo === "missing" ? null : "missing"); }}>
                                        <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.2"/><path d="M8 7v4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/><circle cx="8" cy="5" r="0.7" fill="currentColor"/></svg>
                                      </span>
                                      {hasMissing ? (
                                        <span className="collapsibleSection__badge collapsibleSection__badge--warn">{missingRequired.length} Missing</span>
                                      ) : clauseGaps.length > 0 ? (
                                        <span className="collapsibleSection__badge collapsibleSection__badge--ok">&#10003; All Present</span>
                                      ) : null}
                                    </button>
                                    {openSectionInfo === "missing" && <div className="sectionInfo__popover"><button type="button" className="sectionInfo__close" onClick={() => setOpenSectionInfo(null)}>&times;</button>{SECTION_INFO.missing}</div>}
                                    {!collapsed.missing && (
                                      <div className="collapsibleSection__body">
                                        {hasMissing ? (
                                          <div className="clauseLib__warning">
                                            <strong>&#9888; {missingRequired.length} required clause{missingRequired.length > 1 ? "s were" : " was"} not detected</strong>
                                            <div className="missingClausesList">
                                              {missingRequired.map(c => {
                                                const libEntry = clauseLib.find(cl => cl.name.toLowerCase().replace(/[\s_]+/g, "_") === c.clause_key || cl.name.toLowerCase() === c.name.toLowerCase());
                                                return (
                                                  <div key={c.clause_key} className="missingClauseCard">
                                                    <div className="missingClauseCard__header">
                                                      <strong>{c.name}</strong>
                                                    </div>
                                                    <p className="missingClauseCard__desc">{c.description}</p>
                                                    {libEntry?.standard_language && (
                                                      <button type="button" className="btn btn--sm missingClauseCard__copyBtn" onClick={() => { navigator.clipboard.writeText(libEntry.standard_language!); showToast("Standard clause copied to clipboard"); }}>
                                                        <svg width="12" height="12" viewBox="0 0 14 14" fill="none"><rect x="4.5" y="4.5" width="7" height="7" rx="1.2" stroke="currentColor" strokeWidth="1.2"/><path d="M9.5 4.5V3.3A1.3 1.3 0 008.2 2H3.3A1.3 1.3 0 002 3.3v4.9a1.3 1.3 0 001.3 1.3h1.2" stroke="currentColor" strokeWidth="1.2"/></svg>
                                                        Copy Standard Clause
                                                      </button>
                                                    )}
                                                  </div>
                                                );
                                              })}
                                            </div>
                                          </div>
                                        ) : clauseGaps.length > 0 ? (
                                          <p className="panelSection__empty" style={{ color: "var(--risk-low)" }}>&#10003; All required clauses were detected in this contract.</p>
                                        ) : (
                                          <p className="panelSection__empty">Run analysis to check for missing clauses.</p>
                                        )}
                                      </div>
                                    )}
                                  </div>
                                );
                              })()}

                              {/* ── Section 4: Compliance Checklist (collapsible) ── */}
                              <div className="collapsibleSection">
                                <button type="button" className="collapsibleSection__header" onClick={() => setCollapsed(p => ({ ...p, compliance: !p.compliance }))}>
                                  <svg className={`collapsibleSection__chevron${collapsed.compliance ? "" : " collapsibleSection__chevron--open"}`} width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M5.5 3l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                                  <span className="collapsibleSection__title">Compliance Checklist</span>
                                  <span className="sectionInfo" onClick={e => { e.stopPropagation(); setOpenSectionInfo(openSectionInfo === "compliance" ? null : "compliance"); }}>
                                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.2"/><path d="M8 7v4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/><circle cx="8" cy="5" r="0.7" fill="currentColor"/></svg>
                                  </span>
                                  {clauseGaps.length > 0 && (
                                    <span className="collapsibleSection__badge">{clauseGaps.filter(c => c.status === "detected").length}/{clauseGaps.length}</span>
                                  )}
                                </button>
                                {openSectionInfo === "compliance" && <div className="sectionInfo__popover"><button type="button" className="sectionInfo__close" onClick={() => setOpenSectionInfo(null)}>&times;</button>{SECTION_INFO.compliance}</div>}
                                {!collapsed.compliance && (
                                  <div className="collapsibleSection__body">
                                    {clauseGaps.length === 0 ? (
                                      <p className="panelSection__empty">Run analysis to detect clause types and compliance gaps.</p>
                                    ) : (
                                      <>
                                        <div className="clauseLib__stats clauseLib__stats--interactive">
                                          <button type="button" className={`clauseLib__stat clauseLib__stat--all${complianceFilter === "all" ? " clauseLib__stat--active" : ""}`} onClick={() => setComplianceFilter("all")}>All: {clauseGaps.length}</button>
                                          <button type="button" className={`clauseLib__stat clauseLib__stat--detected${complianceFilter === "detected" ? " clauseLib__stat--active" : ""}`} title="Clause types successfully matched in the document" onClick={() => setComplianceFilter(complianceFilter === "detected" ? "all" : "detected")}>Detected: {clauseGaps.filter(c => c.status === "detected").length}</button>
                                          <button type="button" className={`clauseLib__stat clauseLib__stat--missing${complianceFilter === "missing" ? " clauseLib__stat--active" : ""}`} title="Required clauses not found in the document" onClick={() => setComplianceFilter(complianceFilter === "missing" ? "all" : "missing")}>Missing: {clauseGaps.filter(c => c.status === "missing").length}</button>
                                          <button type="button" className={`clauseLib__stat clauseLib__stat--review${complianceFilter === "needs_review" ? " clauseLib__stat--active" : ""}`} title="Detected clauses that have not yet been accepted by a reviewer" onClick={() => setComplianceFilter(complianceFilter === "needs_review" ? "all" : "needs_review")}>Needs Review: {clauseGaps.filter(c => (clauseReviewStatus[c.clause_key] || c.review_status) === "needs_review" && c.status === "detected").length}</button>
                                        </div>
                                        <div className="clauseLibCards">
                                          {clauseGaps.filter(gap => {
                                            if (complianceFilter === "all") return true;
                                            if (complianceFilter === "detected") return gap.status === "detected";
                                            if (complianceFilter === "missing") return gap.status === "missing";
                                            if (complianceFilter === "needs_review") return (clauseReviewStatus[gap.clause_key] || gap.review_status) === "needs_review" && gap.status === "detected";
                                            return true;
                                          }).map(gap => {
                                            const rStatus = clauseReviewStatus[gap.clause_key] || gap.review_status;
                                            return (
                                              <div key={gap.clause_key} className={`clauseLibCard clauseLibCard--${gap.status}`}>
                                                <div className="clauseLibCard__header">
                                                  <span className={`clauseLibCard__dot clauseLibCard__dot--${gap.status}`} />
                                                  <span className="clauseLibCard__name">{gap.name}</span>
                                                  {gap.required && <span className="clauseLibCard__req">Required</span>}
                                                  <span className={`clauseLibCard__status clauseLibCard__status--${gap.status}`}>
                                                    {gap.status === "detected" ? `Detected (${gap.count})` : "Not Detected"}
                                                  </span>
                                                </div>
                                                <div className="clauseLibCard__desc">{gap.description}</div>
                                                {gap.excerpts.length > 0 && (
                                                  <div className="clauseLibCard__excerpt">{gap.excerpts[0].slice(0, 160)}{gap.excerpts[0].length > 160 ? "…" : ""}</div>
                                                )}
                                                <div className="clauseLibCard__actions">
                                                  {gap.status === "detected" && (
                                                    <>
                                                      <button type="button" className={`btn btn--sm ${rStatus === "accepted" ? "btn--primary" : ""}`} onClick={() => setClauseReviewStatus(prev => ({ ...prev, [gap.clause_key]: "accepted" }))}>{rStatus === "accepted" ? "\u2713 Accepted" : "Accept"}</button>
                                                      <button type="button" className="btn btn--sm" onClick={() => jumpToClauseGroup(gap.clause_key)}>View in Document</button>
                                                      {gap.excerpts[0] && (
                                                        <button type="button" className="btn btn--sm" disabled={explainLoading} onClick={async () => {
                                                          if (!selectedContract) return;
                                                          setExplainLoading(true);
                                                          try {
                                                            const resp = await explainClause(selectedContract.contract_id, gap.excerpts[0]);
                                                            setExplainText(resp.explanation || "No explanation available.");
                                                            const act = await getActivity(selectedContract.contract_id);
                                                            setActivity((act.activity || []) as ActivityItem[]);
                                                          } catch { setExplainText("Failed to generate explanation."); }
                                                          setExplainLoading(false);
                                                        }}>{explainLoading ? "Analyzing…" : "AI Explain"}</button>
                                                      )}
                                                      {gap.excerpts[0] && (
                                                        <>
                                                          <button type="button" className="btn btn--sm" onClick={() => setInlineCompareKey(inlineCompareKey === gap.clause_key ? null : gap.clause_key)}>
                                                            {inlineCompareKey === gap.clause_key ? "Hide Compare" : "Compare Inline"}
                                                          </button>
                                                          <button type="button" className="btn btn--sm" disabled={playbookLoading} onClick={async () => {
                                                            if (!selectedContract) return;
                                                            setPlaybookLoading(true);
                                                            try {
                                                              const resp = await playbookCompare(selectedContract.contract_id, gap.clause_key, gap.excerpts[0]);
                                                              setPlaybookData(resp);
                                                            } catch { setPlaybookData(null); showToast("Playbook comparison failed."); }
                                                            setPlaybookLoading(false);
                                                          }}>{playbookLoading ? "Comparing…" : "Full Compare"}</button>
                                                        </>
                                                      )}
                                                    </>
                                                  )}
                                                  {gap.status === "missing" && (
                                                    <span className="clauseLibCard__missingNote">&#9888; Consider adding this clause.</span>
                                                  )}
                                                </div>
                                                {explainText && rStatus !== "accepted" && gap.excerpts[0] && (
                                                  <div className="clauseLibCard__explain">{explainText}</div>
                                                )}
                                                {inlineCompareKey === gap.clause_key && gap.excerpts[0] && (() => {
                                                  const libEntry = clauseLib.find(cl => cl.name.toLowerCase().replace(/[\s_]+/g, "_") === gap.clause_key || cl.name.toLowerCase() === gap.name.toLowerCase());
                                                  const stdText = libEntry?.standard_language || "No standard language available in the Clause Library.";
                                                  const vendorText = gap.excerpts[0];
                                                  const diffs = libEntry?.standard_language ? wordDiff(vendorText, stdText) : [];
                                                  return (
                                                    <div className="inlineCompare">
                                                      <div className="inlineCompare__col">
                                                        <div className="inlineCompare__label inlineCompare__label--vendor">Vendor Text</div>
                                                        <div className="inlineCompare__text">
                                                          {diffs.length > 0 ? diffs.filter(d => d.type !== "add").map((d, i) => (
                                                            <span key={i} className={d.type === "del" ? "inlineCompare__del" : ""}>{d.text} </span>
                                                          )) : vendorText}
                                                        </div>
                                                      </div>
                                                      <div className="inlineCompare__col">
                                                        <div className="inlineCompare__label inlineCompare__label--standard">Standard</div>
                                                        <div className="inlineCompare__text">
                                                          {diffs.length > 0 ? diffs.filter(d => d.type !== "del").map((d, i) => (
                                                            <span key={i} className={d.type === "add" ? "inlineCompare__add" : ""}>{d.text} </span>
                                                          )) : stdText}
                                                        </div>
                                                      </div>
                                                    </div>
                                                  );
                                                })()}
                                              </div>
                                            );
                                          })}
                                        </div>
                                      </>
                                    )}
                                  </div>
                                )}
                              </div>

                              {/* ── Section 5: Keyword Risk Flags (collapsible) ── */}
                              <div className="collapsibleSection">
                                <button type="button" className="collapsibleSection__header" onClick={() => setCollapsed(p => ({ ...p, keywords: !p.keywords }))}>
                                  <svg className={`collapsibleSection__chevron${collapsed.keywords ? "" : " collapsibleSection__chevron--open"}`} width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M5.5 3l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                                  <span className="collapsibleSection__title">Keyword Risk Flags</span>
                                  <span className="sectionInfo" onClick={e => { e.stopPropagation(); setOpenSectionInfo(openSectionInfo === "keywords" ? null : "keywords"); }}>
                                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.2"/><path d="M8 7v4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/><circle cx="8" cy="5" r="0.7" fill="currentColor"/></svg>
                                  </span>
                                  {risks.length > 0 && (
                                    <span className="collapsibleSection__badge collapsibleSection__badge--warn">{risks.length}</span>
                                  )}
                                </button>
                                {openSectionInfo === "keywords" && <div className="sectionInfo__popover"><button type="button" className="sectionInfo__close" onClick={() => setOpenSectionInfo(null)}>&times;</button>{SECTION_INFO.keywords}</div>}
                                {!collapsed.keywords && (
                                  <div className="collapsibleSection__body">
                                    {risks.length > 0 ? (
                                      <>
                                        <p className="panelSection__hint" style={{ marginBottom: 8 }}>Rule-based keyword flags — separate from AI clause assessment for defense-in-depth.</p>
                                        {risks.map(r => (
                                          <div key={r.risk_id} className={`riskCard riskCard--${riskTone(r.severity)}`}>
                                            <span className="riskCard__type">{prettify(r.risk_type)}</span>
                                            <span className="riskCard__reason">{r.reason}</span>
                                          </div>
                                        ))}
                                      </>
                                    ) : (
                                      <p className="panelSection__empty">No keyword risk flags detected.</p>
                                    )}
                                  </div>
                                )}
                              </div>
                            </>
                          )}
                        </div>
                      )}

                      {/* ── KEY INFO ── */}
                      {panelTab === "keyinfo" && (
                        <div className="panelSection">
                          {summaryView.entries.length === 0 ? (
                            <p className="panelSection__empty">Run analysis to extract key contract data.</p>
                          ) : (
                            <div className="keyInfoPanel">
                              {summaryView.entries.slice(0, 12).map(e => (
                                <div key={e.key} className="keyInfoRow keyInfoRow--panel">
                                  <div className="keyInfoRow__label">{e.label}</div>
                                  <div className="keyInfoRow__value">{e.value}</div>
                                </div>
                              ))}
                            </div>
                          )}
                          {risks.length > 0 && (
                            <div style={{ marginTop: 16 }}>
                              <div className="panelSection__subhead">Risk Indicators</div>
                              {risks.map(r => (
                                <div key={r.risk_id} className={`riskCard riskCard--${riskTone(r.severity)}`}>
                                  <span className="riskCard__type">{prettify(r.risk_type)}</span>
                                  <span className="riskCard__reason">{r.reason}</span>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      )}

                    </div>
                  </div>
                </div>
              )}

              {/* ── TAB: LIFECYCLE ── */}
              {detailTab === "lifecycle" && (() => {
                const stages = ["Draft", "In Review", "Signed", "Active", "Expiring", "Renewed"];
                const currentStageIdx = 3; // Active
                const contractDate = selectedContract?.agreement_date || selectedContract?.created_at;
                const startDate = contractDate ? new Date(contractDate) : new Date();
                const today = new Date();
                const daysSinceStart = Math.max(0, Math.floor((today.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24)));

                // Build visual timeline events from all available data
                const events: { date: string; label: string; desc: string; type: "start" | "milestone" | "warn" | "danger" | "info"; position: number }[] = [];
                const totalDays = 365 * 2; // assume 2-year horizon
                const addEvent = (date: string | null, label: string, desc: string, type: "start" | "milestone" | "warn" | "danger" | "info") => {
                  if (!date) return;
                  const d = new Date(date);
                  if (isNaN(d.getTime())) {
                    events.push({ date, label, desc, type, position: -1 });
                    return;
                  }
                  const days = Math.floor((d.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24));
                  events.push({ date: d.toLocaleDateString(), label, desc, type, position: Math.max(0, Math.min(100, (days / totalDays) * 100)) });
                };

                addEvent(contractDate || null, "Effective Date", timeline.effective || "Contract start", "start");
                if (timeline.renewal) addEvent(null, "Renewal Terms", timeline.renewal, "warn");
                if (timeline.termination) addEvent(null, "Termination", timeline.termination, "danger");
                if (timeline.governingLaw) addEvent(null, "Governing Law", timeline.governingLaw, "info");

                const todayPosition = Math.max(0, Math.min(100, (daysSinceStart / totalDays) * 100));

                // Risk profile data for mini chart
                const riskCategories = Object.entries(categoryScores);

                return (
                <div className="tabBody">
                  <div className="lcTab">
                    {/* Pipeline stages */}
                    <div className="lcPipeline">
                      {stages.map((stage, i) => (
                        <div key={stage} className={`lcPipeline__stage ${i < currentStageIdx ? "lcPipeline__stage--done" : i === currentStageIdx ? "lcPipeline__stage--active" : "lcPipeline__stage--future"}`}>
                          <div className="lcPipeline__dot">{i < currentStageIdx ? "\u2713" : i === currentStageIdx ? "\u25CF" : ""}</div>
                          <div className="lcPipeline__label">{stage}</div>
                          {i < stages.length - 1 && <div className={`lcPipeline__line ${i < currentStageIdx ? "lcPipeline__line--done" : ""}`} />}
                        </div>
                      ))}
                    </div>

                    {daysSinceStart > 275 && (
                      <div className="expiryAlert">
                        <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 1.33l6.67 11.34H1.33L8 1.33z" stroke="#f59e0b" strokeWidth="1.2"/><path d="M8 6v3M8 11h.01" stroke="#f59e0b" strokeWidth="1.3" strokeLinecap="round"/></svg>
                        <span>This contract is approaching its renewal window ({Math.max(0, 365 - daysSinceStart)} days remaining). Review terms and initiate renewal process.</span>
                      </div>
                    )}

                    <div className="lcGrid">
                      {/* Visual Timeline Bar */}
                      <div className="lcCard lcCard--wide">
                        <div className="lcCard__title">Contract Timeline</div>
                        <div className="lcTimeline">
                          <div className="lcTimeline__bar">
                            <div className="lcTimeline__elapsed" style={{ width: `${todayPosition}%` }} />
                            <div className="lcTimeline__today" style={{ left: `${todayPosition}%` }}>
                              <div className="lcTimeline__todayLine" />
                              <div className="lcTimeline__todayLabel">Today</div>
                            </div>
                            {events.filter(e => e.position >= 0).map((e, i) => (
                              <div key={i} className={`lcTimeline__marker lcTimeline__marker--${e.type}`} style={{ left: `${e.position}%` }} title={`${e.label}: ${e.desc}`}>
                                <div className="lcTimeline__markerDot" />
                              </div>
                            ))}
                          </div>
                          <div className="lcTimeline__labels">
                            <span>{startDate.toLocaleDateString()}</span>
                            <span style={{ color: "var(--text-muted)" }}>2-year horizon</span>
                            <span>{new Date(startDate.getTime() + totalDays * 86400000).toLocaleDateString()}</span>
                          </div>
                        </div>
                        <div className="lcTimeline__stats">
                          <div className="lcStat">
                            <div className="lcStat__value">{daysSinceStart}</div>
                            <div className="lcStat__label">Days Active</div>
                          </div>
                          <div className="lcStat">
                            <div className="lcStat__value">{Math.max(0, totalDays - daysSinceStart)}</div>
                            <div className="lcStat__label">Days Remaining (est.)</div>
                          </div>
                          <div className="lcStat">
                            <div className={`lcStat__value ${overallRisk >= 75 ? "lcStat__value--danger" : overallRisk >= 45 ? "lcStat__value--warn" : "lcStat__value--ok"}`}>{riskLevel}</div>
                            <div className="lcStat__label">Risk Level</div>
                          </div>
                          <div className="lcStat">
                            <div className="lcStat__value">{chunks.length}</div>
                            <div className="lcStat__label">Sections Analyzed</div>
                          </div>
                        </div>
                      </div>

                      {/* Key Dates & Milestones */}
                      <div className="lcCard">
                        <div className="lcCard__title">Key Dates & Milestones</div>
                        <div className="lcEvents">
                          {events.length === 0 && <p style={{ fontSize: 13, color: "var(--text-muted)" }}>Run analysis to extract timeline data.</p>}
                          {events.map((e, i) => (
                            <div key={i} className={`lcEvent lcEvent--${e.type}`}>
                              <div className="lcEvent__line">
                                <div className="lcEvent__dot" />
                                {i < events.length - 1 && <div className="lcEvent__connector" />}
                              </div>
                              <div className="lcEvent__content">
                                <div className="lcEvent__label">{e.label}</div>
                                <div className="lcEvent__desc">{e.desc}</div>
                                {e.date && e.position >= 0 && <div className="lcEvent__date">{e.date}</div>}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>

                      {/* Risk Profile over Categories */}
                      <div className="lcCard">
                        <div className="lcCard__title">Risk Profile by Category</div>
                        <div className="lcRiskBars">
                          {riskCategories.map(([cat, score]) => (
                            <div key={cat} className="lcRiskBar">
                              <div className="lcRiskBar__header">
                                <span className="lcRiskBar__label">{cat}</span>
                                <span className="lcRiskBar__score">{score}/100</span>
                              </div>
                              <div className="lcRiskBar__track">
                                <div className={`lcRiskBar__fill ${score >= 60 ? "lcRiskBar__fill--high" : score >= 35 ? "lcRiskBar__fill--med" : "lcRiskBar__fill--low"}`} style={{ width: `${score}%` }} />
                              </div>
                            </div>
                          ))}
                        </div>
                        {risks.length > 0 && (
                          <div className="lcRisks">
                            <div className="lcCard__subtitle">Active Risk Flags</div>
                            {risks.slice(0, 4).map(r => (
                              <div key={r.risk_id} className={`lcRiskFlag lcRiskFlag--${riskTone(r.severity)}`}>
                                <span className="lcRiskFlag__sev">{r.severity}</span>
                                <span className="lcRiskFlag__reason">{r.reason}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>

                      {/* Obligations & Key Terms */}
                      <div className="lcCard lcCard--wide">
                        <div className="lcCard__title">Obligations & Key Terms</div>
                        <div className="lcObligations">
                          {summaryView.entries.filter(e => ["payment_terms", "renewal", "renewal_terms", "liability", "indemnification", "term", "effective_date", "termination_rights", "termination", "governing_law"].includes(e.key)).map(e => (
                            <div key={e.key} className="lcObligation">
                              <div className="lcObligation__label">{e.label}</div>
                              <div className="lcObligation__value">{e.value}</div>
                            </div>
                          ))}
                          {summaryView.entries.filter(e => ["payment_terms", "renewal", "renewal_terms", "liability", "indemnification", "term", "effective_date", "termination_rights", "termination", "governing_law"].includes(e.key)).length === 0 && (
                            <p style={{ fontSize: 13, color: "var(--text-muted)" }}>Run analysis to extract key obligations and terms.</p>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
                );
              })()}

              {/* ── TAB: ANALYTICS ── */}
              {detailTab === "analytics" && (
                <div className="tabBody">
                  <div className="analyticsTab">
                    <div className="analyticsCard">
                      <div className="analyticsCard__title">Overall Risk Score</div>
                      {risks.length === 0 ? (
                        <p style={{ fontSize: 13, color: "var(--text-muted)" }}>Run analysis to compute risk score.</p>
                      ) : (
                        <div className="riskGauge">
                          <div className={`riskGauge__circle riskGauge__circle--${riskTone(riskLevel)}`}>{overallRisk}</div>
                          <div><div className="riskGauge__label">{riskLevel} Risk</div><div className="riskGauge__sub">{risks.length} issue{risks.length !== 1 ? "s" : ""} flagged</div></div>
                        </div>
                      )}
                    </div>
                    <div className="analyticsCard">
                      <div className="analyticsCard__title">Risk by Category</div>
                      {risks.length === 0 ? (
                        <p style={{ fontSize: 13, color: "var(--text-muted)" }}>No risk data yet.</p>
                      ) : (
                        <div className="catBars">
                          {Object.entries(categoryScores).map(([label, val]) => (
                            <div key={label} className="catBar">
                              <span className="catBar__label">{label}</span>
                              <div className="catBar__track"><div className={`catBar__fill ${barClass(val)}`} style={{ width: `${Math.min(val, 100)}%` }} /></div>
                              <span className="catBar__value">{val}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                    <div className="analyticsCard">
                      <div className="analyticsCard__title">Flagged Risks</div>
                      {risks.length === 0 ? (
                        <p style={{ fontSize: 13, color: "var(--text-muted)" }}>No flagged risks.</p>
                      ) : risks.map(r => (
                        <div key={r.risk_id} className={`riskCard riskCard--${riskTone(r.severity)}`}>
                          <span className="riskCard__type">{prettify(r.risk_type)}</span>
                          <span className="riskCard__reason">{r.reason}</span>
                        </div>
                      ))}
                    </div>
                    <div className="analyticsCard">
                      <div className="analyticsCard__title">Recommended Actions</div>
                      <ul className="actionList">
                        {actionItems.map(a => (
                          <li key={a} className="actionList__item">
                            <span className="actionList__bullet" />
                            <span>{a}</span>
                          </li>
                        ))}
                      </ul>
                      <div className="workflowBtns">
                        <button type="button" className="btn btn--primary btn--sm" onClick={() => showToast("Routed to Legal Review — assigned to external counsel queue.")}>Route to Legal</button>
                        <button type="button" className="btn btn--sm" onClick={() => showToast("Task created in procurement tracker: Review renewal terms for " + selectedContract.filename)}>Create Task</button>
                        <button type="button" className="btn btn--sm" onClick={() => showToast("Calendar event added: Contract renewal reminder — 90 days before expiry.")}>Add to Calendar</button>
                        <button type="button" className="btn btn--sm" onClick={() => showToast("Summary shared with stakeholders via email.")}>Share Summary</button>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* ── TAB: COMMENTS ── */}
              {detailTab === "comments" && (
                <div className="tabBody commentsTab">
                  <div className="commentsTab__form">
                    <textarea
                      className="commentsTab__input"
                      placeholder="Add a comment about this contract..."
                      value={newComment}
                      onChange={e => setNewComment(e.target.value)}
                      rows={3}
                    />
                    <button
                      type="button"
                      className="btn btn--primary btn--sm"
                      disabled={!newComment.trim()}
                      onClick={async () => {
                        if (!newComment.trim() || !selectedContract) return;
                        await postComment(selectedContract.contract_id, newComment.trim());
                        setNewComment("");
                        const cmt = await getComments(selectedContract.contract_id);
                        setComments((cmt.comments || []) as CommentItem[]);
                        const act = await getActivity(selectedContract.contract_id);
                        setActivity((act.activity || []) as ActivityItem[]);
                      }}
                    >Post Comment</button>
                  </div>
                  {comments.length === 0 ? (
                    <div className="emptyState">No comments yet. Be the first to add a note.</div>
                  ) : (
                    <div className="commentsList">
                      {comments.map(c => (
                        <div key={c.comment_id} className="commentCard">
                          <div className="commentCard__header">
                            <span className="commentCard__avatar">{c.author[0]}</span>
                            <span className="commentCard__author">{c.author}</span>
                            <span className="commentCard__time">{new Date(c.created_at).toLocaleString()}</span>
                          </div>
                          <div className="commentCard__text">{c.text}</div>
                          {c.chunk_id && <span className="commentCard__ref">Re: section {c.chunk_id}</span>}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* ── TAB: ACTIVITY ── */}
              {detailTab === "activity" && (
                <div className="tabBody activityTab">
                  {activity.length === 0 ? (
                    <div className="emptyState">No activity recorded yet.</div>
                  ) : (
                    <div className="activityFeed">
                      {activity.map(a => {
                        const icons: Record<string, string> = { contract_uploaded: "\u25B7", analysis_completed: "\u25CE", comment_added: "\u25E6", ai_explain: "\u25C7", clause_risk_assessment: "\u25C6", sentinel_review: "\u25C9" };
                        return (
                          <div key={a.activity_id} className="activityItem">
                            <span className="activityItem__icon">{icons[a.action] || "📌"}</span>
                            <div className="activityItem__content">
                              <div className="activityItem__action">
                                <strong>{a.actor}</strong>{" "}
                                {a.action === "contract_uploaded" ? "uploaded this contract" :
                                 a.action === "analysis_completed" ? "ran contract analysis" :
                                 a.action === "comment_added" ? "added a comment" :
                                 a.action === "ai_explain" ? "used AI Assist to explain a clause" :
                                 a.action.replace(/_/g, " ")}
                              </div>
                              {a.details && <div className="activityItem__details">{a.details}</div>}
                              <div className="activityItem__time">{new Date(a.created_at).toLocaleString()}</div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ═══ FLOATING AI PANEL ═══ */}
      {showAI && view === "detail" && (
        <div className="aiOverlay">
          <div className="aiOverlay__header">
            <div className="aiOverlay__headerLeft">
              <div className="aiOverlay__icon">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 1l2 4 4.5.7-3.3 3.1.8 4.5L8 11.2 3.9 13.3l.8-4.5L1.5 5.7 6 5z" fill="currentColor"/></svg>
              </div>
              <span className="aiOverlay__title">Ask AI</span>
            </div>
            <div className="aiOverlay__headerActions">
              <button type="button" className="aiOverlay__headerBtn" title="Clear chat" onClick={() => setThread([])}>
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M2 4h10M5 4V2.5A.5.5 0 015.5 2h3a.5.5 0 01.5.5V4M11 4v7.5a1 1 0 01-1 1H4a1 1 0 01-1-1V4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/></svg>
              </button>
              <button type="button" className="aiOverlay__close" onClick={() => setShowAI(false)}>
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg>
              </button>
            </div>
          </div>

          {/* Highlight quick actions */}
          <div className="aiActions">
            <button type="button" className={`aiActionBtn${highlightMode === "clauses" ? " aiActionBtn--active" : ""}`} onClick={() => toggleHighlight("clauses")}>
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><rect x="1" y="1" width="10" height="10" rx="2" stroke="currentColor" strokeWidth="1"/><path d="M3 4h6M3 6h4M3 8h5" stroke="currentColor" strokeWidth="0.9" strokeLinecap="round"/></svg>
              Clauses
            </button>
            <button type="button" className={`aiActionBtn${highlightMode === "parties" ? " aiActionBtn--active" : ""}`} onClick={() => toggleHighlight("parties")}>
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><circle cx="4" cy="4" r="2" stroke="currentColor" strokeWidth="1"/><circle cx="8" cy="4" r="2" stroke="currentColor" strokeWidth="1"/><path d="M1 10c0-2 1.5-3 3-3s3 1 3 3M5 10c0-2 1.5-3 3-3s3 1 3 3" stroke="currentColor" strokeWidth="1"/></svg>
              Parties
            </button>
            <button type="button" className={`aiActionBtn${highlightMode === "risks" ? " aiActionBtn--active" : ""}`} onClick={() => toggleHighlight("risks")}>
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M6 1l5 9H1z" stroke="currentColor" strokeWidth="1" strokeLinejoin="round"/><path d="M6 5v2M6 8.5v.5" stroke="currentColor" strokeWidth="1" strokeLinecap="round"/></svg>
              Risks
            </button>
            <button type="button" className={`aiActionBtn${highlightMode === "dates" ? " aiActionBtn--active" : ""}`} onClick={() => toggleHighlight("dates")}>
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><rect x="1" y="2" width="10" height="9" rx="1.5" stroke="currentColor" strokeWidth="1"/><path d="M1 5h10M4 1v2M8 1v2" stroke="currentColor" strokeWidth="1" strokeLinecap="round"/></svg>
              Dates
            </button>
          </div>

          {/* Chat body */}
          <div className="aiOverlay__body">
            {thread.length === 0 && (
              <div className="aiChat__welcome">
                <div className="aiChat__welcomeIcon">
                  <svg width="32" height="32" viewBox="0 0 32 32" fill="none"><rect width="32" height="32" rx="8" fill="var(--accent-bg)"/><path d="M16 8l3 5 5.5 1-4 3.8 1 5.5L16 20.5l-5.5 2.8 1-5.5-4-3.8 5.5-1z" fill="var(--accent)" opacity="0.7"/></svg>
                </div>
                <div className="aiChat__welcomeText">Ask anything about this contract. I can summarize, find clauses, explain risks, and answer specific questions.</div>
                <div className="chatMsg__chips">
                  {(suggestedQs.length > 0 ? suggestedQs.slice(0, 4) : [
                    "Summarize this contract",
                    "List the main risks",
                    "What are the key dates?",
                    "Payment terms and conditions?"
                  ]).map(q => (
                    <button key={q} type="button" className="chatChip" onClick={() => void runPrompt(q)}>
                      {compact(q, 55)}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {thread.map(msg => (
              <div key={msg.id} className={`chatMsg chatMsg--${msg.role === "user" ? "user" : "ai"}`}>
                {msg.role === "ai" && <div className="chatMsg__avatar"><svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 1l2 3.5 4 .6-2.9 2.8.7 3.9L7 9.8 3.2 11.8l.7-3.9L1 5.1l4-.6z" fill="currentColor"/></svg></div>}
                <div className="chatMsg__content">
                  <div className="chatMsg__bubble chatMsg__bubble--md" dangerouslySetInnerHTML={{ __html: msg.text
                    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
                    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
                    .replace(/\n{2,}/g, "<br/><br/>")
                    .replace(/\n/g, "<br/>")
                  }} />
                  {msg.intent && (
                    <div className="chatMsg__intent" title={msg.intent.reasoning}>
                      <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M5 1v3L7.5 5.5 5 8V5H2.5" stroke="currentColor" strokeWidth="0.9" strokeLinecap="round" strokeLinejoin="round"/></svg>
                      Routed: {msg.intent.tasks.map(t => t === "qa" ? "Q&A" : t === "risk" ? "Risk Scan" : t === "summary" ? "Summarize" : t === "compare" ? "Compare" : t === "explain" ? "Explain" : t).join(" → ")}
                    </div>
                  )}
                  {msg.sources && msg.sources.length > 0 && (
                    <div className="chatMsg__sources">
                      <button type="button" className="chatMsg__sourcesToggle" onClick={() => setExpandedSources(expandedSources === msg.id ? null : msg.id)}>
                        <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><rect x="1" y="1.5" width="10" height="9" rx="1.5" stroke="currentColor" strokeWidth="1"/><path d="M3 4h6M3 6.5h4" stroke="currentColor" strokeWidth="0.8" strokeLinecap="round"/></svg>
                        {msg.sources.length} source{msg.sources.length > 1 ? "s" : ""}
                        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" style={{ transform: expandedSources === msg.id ? "rotate(180deg)" : "none", transition: "transform 0.15s" }}><path d="M2.5 3.5L5 6l2.5-2.5" stroke="currentColor" strokeWidth="1" strokeLinecap="round"/></svg>
                      </button>
                      {expandedSources === msg.id && (
                        <div className="chatMsg__sourcesList">
                          {msg.sources.map(src => (
                            <button
                              type="button"
                              key={src.chunkId}
                              className="chatMsg__sourceCard"
                              onClick={() => {
                                setActiveClauseGroup(null);
                                setHighlightMode(null);
                                const allSources = msg.sources!.map(s => ({ chunkId: s.chunkId, text: s.text, page: s.page, section: s.section }));
                                setAskAiSources(allSources);
                                const focusIdx = allSources.findIndex(s => s.chunkId === src.chunkId);
                                setAskAiFocusIdx(focusIdx >= 0 ? focusIdx : 0);
                                scrollToChunkRef.current = src.chunkId;
                                if (src.page) {
                                  const iframe = document.querySelector<HTMLIFrameElement>(".pdfViewer__frame");
                                  iframe?.contentWindow?.postMessage({ type: "navigate", payload: { page: src.page } }, "*");
                                }
                              }}
                            >
                              <div className="chatMsg__sourceHeader">
                                <span className="chatMsg__sourceIdx">{src.idx}</span>
                                <span className="chatMsg__sourceTitle">{src.section || selectedContract?.filename || "Document"}</span>
                                {src.page != null && <span className="chatMsg__sourcePage">p.{src.page}</span>}
                              </div>
                              {src.text && <div className="chatMsg__sourceText">{src.text.slice(0, 160)}{src.text.length > 160 ? "..." : ""}</div>}
                              {!src.text && <div className="chatMsg__sourceText" style={{ fontStyle: "italic", opacity: 0.6 }}>Click to view in document</div>}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            ))}
            {loading && loadingLabel === "analyze" && (
              <div className="chatMsg chatMsg--ai">
                <div className="chatMsg__avatar"><svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 1l2 3.5 4 .6-2.9 2.8.7 3.9L7 9.8 3.2 11.8l.7-3.9L1 5.1l4-.6z" fill="currentColor"/></svg></div>
                <div className="chatMsg__content"><div className="chatMsg__bubble"><div className="loadingDots"><span /><span /><span /></div></div></div>
              </div>
            )}
          </div>

          {/* Search scope bar */}
          <div className="aiOverlay__scope">
            <span className="aiOverlay__scopeLabel">Search</span>
            <button type="button" className={`aiOverlay__scopeBtn${chatScope === "all" ? " aiOverlay__scopeBtn--active" : ""}`} onClick={() => setChatScope("all")}>All Documents</button>
            <button type="button" className={`aiOverlay__scopeBtn${chatScope === "document" ? " aiOverlay__scopeBtn--active" : ""}`} onClick={() => setChatScope("document")}>This Document</button>
          </div>

          {/* Selected document chip */}
          {chatScope === "document" && selectedContract && (
            <div className="aiOverlay__docChip">
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M7 1H3a1.5 1.5 0 00-1.5 1.5v7A1.5 1.5 0 003 11h6a1.5 1.5 0 001.5-1.5V4.5z" stroke="currentColor" strokeWidth="1"/><path d="M7 1v3.5h3.5" stroke="currentColor" strokeWidth="1"/></svg>
              <span className="aiOverlay__docChipName">{selectedContract.filename}</span>
            </div>
          )}

          {/* Quick question chips when chat is empty */}
          {thread.length === 0 && (
            <div className="aiOverlay__quickQs">
              {["What are the key risks?", "Summarize the payment terms", "Explain the termination clause"].map(q => (
                <button key={q} type="button" className="aiOverlay__quickQ" onClick={() => void runPrompt(q)}>{q}</button>
              ))}
            </div>
          )}

          {/* Footer input */}
          <div className="aiOverlay__footer">
            <div className="aiOverlay__inputHint">
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M5 1v3L7.5 5.5 5 8V5H2.5" stroke="currentColor" strokeWidth="0.8" strokeLinecap="round" strokeLinejoin="round"/></svg>
              AI routes your question to the right specialist agent automatically
            </div>
            <div className={`aiOverlay__inputWrap${thread.length === 0 ? " aiOverlay__inputWrap--prominent" : ""}`}>
              <input
                className="aiOverlay__input"
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder={thread.length === 0 ? "Ask a question about this contract\u2026" : "Follow up\u2026"}
                onKeyDown={e => { if (e.key === "Enter" && canRun && query.trim()) void runPrompt(query); }}
                autoFocus
              />
              <button type="button" className="aiOverlay__send" disabled={!canRun || !query.trim()} onClick={() => void runPrompt(query)}>
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M14 2L7 9M14 2l-4.5 12-2.3-5.2L2 5.5z" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ═══ DEBUG / TRACE MODE OVERLAY ═══ */}
      {showDebug && selectedContract && (
        <div className="debugOverlay">
          <div className="debugOverlay__panel">
            <div className="debugOverlay__header">
              <div className="debugOverlay__headerLeft">
                <svg width="18" height="18" viewBox="0 0 18 18" fill="none"><path d="M9 1v3m0 10v3M1 9h3m10 0h3M3.93 3.93l2.12 2.12m5.9 5.9l2.12 2.12M3.93 14.07l2.12-2.12m5.9-5.9l2.12-2.12" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/><circle cx="9" cy="9" r="3" stroke="currentColor" strokeWidth="1.3"/></svg>
                <h2>Debug / Trace Mode</h2>
              </div>
              <button type="button" className="debugOverlay__close" onClick={() => setShowDebug(false)}>&times;</button>
            </div>

            <div className="debugOverlay__subheader">
              <span className="debugOverlay__filename">{selectedContract.filename}</span>
              <span className="debugOverlay__id">{selectedContract.contract_id}</span>
              <span className="debugOverlay__date">Uploaded {new Date(selectedContract.created_at).toLocaleString()}</span>
            </div>

            {debugLoading ? (
              <div className="debugOverlay__loading">
                <div className="debugOverlay__spinner" />
                <span>Loading trace data...</span>
              </div>
            ) : (
              <div className="debugTimeline">
                {debugSteps.map((s) => (
                  <div key={s.step} className={`debugStep debugStep--${s.status}`}>
                    <div className="debugStep__line">
                      <div className={`debugStep__dot debugStep__dot--${s.status}`}>
                        {s.status === "complete" ? (
                          <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M3 6.5l2 2 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                        ) : s.status === "error" ? (
                          <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M4 4l4 4M8 4l-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
                        ) : s.status === "warning" ? (
                          <span style={{ fontSize: 10, fontWeight: 700 }}>!</span>
                        ) : (
                          <span style={{ fontSize: 9 }}>{s.step}</span>
                        )}
                      </div>
                    </div>
                    <div className="debugStep__content">
                      <div className="debugStep__header">
                        <span className="debugStep__num">Step {s.step}</span>
                        <span className="debugStep__name">{s.name}</span>
                        <span className={`debugStep__badge debugStep__badge--${s.status}`}>{s.status}</span>
                      </div>
                      {s.ts && s.ts.includes("T") && (
                        <div className="debugStep__ts">{new Date(s.ts).toLocaleString()}</div>
                      )}
                      <div className="debugStep__details">
                        {Object.entries(s.details).map(([k, v]) => (
                          <div key={k} className="debugStep__detail">
                            <span className="debugStep__detailKey">{prettify(k)}</span>
                            <span className="debugStep__detailVal">{typeof v === "object" ? JSON.stringify(v) : String(v)}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                ))}
                {debugSteps.length === 0 && (
                  <div className="debugOverlay__empty">
                    <p>No trace data available. Run analysis first to generate trace events.</p>
                    <button type="button" className="btn btn--primary btn--sm" onClick={loadDebugTrace}>Reload Trace</button>
                  </div>
                )}
              </div>
            )}

            <div className="debugOverlay__footer">
              <span className="debugOverlay__footerText">{debugSteps.length} steps traced</span>
              <button type="button" className="btn btn--sm" onClick={loadDebugTrace}>Refresh</button>
            </div>
          </div>
        </div>
      )}

      {/* ═══ PLAYBOOK COMPARE OVERLAY ═══ */}
      {playbookData && (
        <div className="playbookOverlay">
          <div className="playbookOverlay__panel">
            <div className="playbookOverlay__header">
              <h2>Playbook Comparison</h2>
              <button type="button" className="playbookOverlay__close" onClick={() => setPlaybookData(null)}>&times;</button>
            </div>
            <div className="playbookOverlay__body">
              <div className="playbookOverlay__col">
                <div className="playbookOverlay__colTitle playbookOverlay__colTitle--vendor">Vendor Clause</div>
                <div className="playbookOverlay__text">{playbookData.vendor_clause}</div>
              </div>
              <div className="playbookOverlay__col">
                <div className="playbookOverlay__colTitle playbookOverlay__colTitle--playbook">Playbook Standard</div>
                <div className="playbookOverlay__text">{playbookData.playbook_clause}</div>
              </div>
            </div>
            {playbookData.summary && <div className="playbookOverlay__summary">{playbookData.summary}</div>}
            {playbookData.deviations.length > 0 && (
              <div className="playbookOverlay__deviations">
                <div className="playbookOverlay__devTitle">Deviations Found</div>
                {playbookData.deviations.map((d, i) => (
                  <div key={i} className={`playbookOverlay__dev playbookOverlay__dev--${d.type}`}>
                    <span className="playbookOverlay__devType">{d.type}</span>
                    <span>{d.description}</span>
                  </div>
                ))}
              </div>
            )}
            <div className="playbookOverlay__risk">Overall Risk: <span className={`playbookOverlay__riskBadge playbookOverlay__riskBadge--${playbookData.risk_level}`}>{playbookData.risk_level}</span></div>
          </div>
        </div>
      )}

      {/* ═══ TOAST ═══ */}
      {toast && (
        <div className="toast" role="alert">
          <span className="toast__icon">&#10003;</span>
          <span>{toast}</span>
        </div>
      )}
    </>
  );
}
