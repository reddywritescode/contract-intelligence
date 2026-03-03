const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "/api/v1";

const NGROK_HEADERS: Record<string, string> = {
  "ngrok-skip-browser-warning": "true",
};

async function safeFetch(input: RequestInfo | URL, init?: RequestInit) {
  try {
    const headers = { ...NGROK_HEADERS, ...(init?.headers as Record<string, string>) };
    return await fetch(input, { ...init, headers });
  } catch (err) {
    const message = err instanceof Error ? err.message : "network error";
    throw new Error(`API fetch failed (${API_BASE}). ${message}`);
  }
}

async function longFetch(input: RequestInfo | URL, init?: RequestInit) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5 * 60 * 1000);
  try {
    const headers = { ...NGROK_HEADERS, ...(init?.headers as Record<string, string>) };
    return await fetch(input, { ...init, headers, signal: controller.signal });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new Error("Request timed out after 5 minutes");
    }
    const message = err instanceof Error ? err.message : "network error";
    throw new Error(`API fetch failed. ${message}`);
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function ingestContract(file: File) {
  const form = new FormData();
  form.append("file", file);
  const res = await longFetch(`${API_BASE}/contracts/ingest`, { method: "POST", body: form });
  if (!res.ok) throw new Error(`Ingest failed: ${res.status}`);
  return res.json();
}

export async function analyzeContract(contractId: string, payload: { mode: "review" | "agent"; tasks: string[]; question?: string }) {
  const res = await longFetch(`${API_BASE}/contracts/${contractId}/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!res.ok) throw new Error(`Analyze failed: ${res.status}`);
  return res.json();
}

export async function askAI(contractId: string, question: string) {
  const res = await longFetch(`${API_BASE}/contracts/${contractId}/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question }),
  });
  if (!res.ok) throw new Error(`Ask failed: ${res.status}`);
  return res.json();
}

export async function approveRun(runId: string, approved: boolean) {
  const res = await safeFetch(`${API_BASE}/runs/${runId}/approve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ approved })
  });
  if (!res.ok) throw new Error(`Approve failed: ${res.status}`);
  return res.json();
}

export async function getTrace(runId: string) {
  const res = await safeFetch(`${API_BASE}/runs/${runId}/trace`);
  if (!res.ok) throw new Error(`Trace failed: ${res.status}`);
  return res.json();
}

export async function listContracts(filters?: Record<string, string>) {
  const params = new URLSearchParams();
  if (filters) {
    for (const [k, v] of Object.entries(filters)) {
      if (v) params.set(k, v);
    }
  }
  const qs = params.toString();
  const res = await safeFetch(`${API_BASE}/contracts${qs ? `?${qs}` : ""}`);
  if (!res.ok) throw new Error(`List contracts failed: ${res.status}`);
  return res.json();
}

export async function listRuns(contractId: string) {
  const res = await safeFetch(`${API_BASE}/contracts/${contractId}/runs`);
  if (!res.ok) throw new Error(`List runs failed: ${res.status}`);
  return res.json();
}

export async function getRun(runId: string) {
  const res = await safeFetch(`${API_BASE}/runs/${runId}`);
  if (!res.ok) throw new Error(`Run fetch failed: ${res.status}`);
  return res.json();
}

export function getContractFileUrl(contractId: string) {
  return `${API_BASE}/contracts/${contractId}/file`;
}

export async function getChunks(contractId: string) {
  const res = await safeFetch(`${API_BASE}/contracts/${contractId}/chunks`);
  if (!res.ok) throw new Error(`Chunks failed: ${res.status}`);
  return res.json();
}

export async function getHighlights(contractId: string) {
  const res = await safeFetch(`${API_BASE}/contracts/${contractId}/highlights`);
  if (!res.ok) throw new Error(`Highlights failed: ${res.status}`);
  return res.json();
}

export async function getSuggestedQuestions(contractId: string) {
  const res = await safeFetch(`${API_BASE}/contracts/${contractId}/suggested-questions`);
  if (!res.ok) throw new Error(`Question generation failed: ${res.status}`);
  return res.json();
}

export async function getComments(contractId: string) {
  const res = await safeFetch(`${API_BASE}/contracts/${contractId}/comments`);
  if (!res.ok) throw new Error(`Comments failed: ${res.status}`);
  return res.json();
}

export async function postComment(contractId: string, text: string, chunkId?: string) {
  const res = await safeFetch(`${API_BASE}/contracts/${contractId}/comments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, chunk_id: chunkId || null, author: "User" }),
  });
  if (!res.ok) throw new Error(`Post comment failed: ${res.status}`);
  return res.json();
}

export async function getActivity(contractId: string) {
  const res = await safeFetch(`${API_BASE}/contracts/${contractId}/activity`);
  if (!res.ok) throw new Error(`Activity failed: ${res.status}`);
  return res.json();
}

export async function getClauseGaps(contractId: string) {
  const res = await safeFetch(`${API_BASE}/contracts/${contractId}/clause-gaps`);
  if (!res.ok) throw new Error(`Clause gaps failed: ${res.status}`);
  return res.json();
}

export async function getDashboardInsights() {
  const res = await safeFetch(`${API_BASE}/dashboard/insights`);
  if (!res.ok) throw new Error(`Dashboard insights failed: ${res.status}`);
  return res.json();
}

// ─── Sentinel AI Assistant ─────────────────────────

export async function getSentinelPrompts(category?: string) {
  const qs = category ? `?category=${encodeURIComponent(category)}` : "";
  const res = await safeFetch(`${API_BASE}/sentinel/prompts${qs}`);
  if (!res.ok) throw new Error(`Prompts failed: ${res.status}`);
  return res.json();
}

export async function createSentinelPrompt(data: { name: string; description: string; prompt_text: string; category?: string }) {
  const res = await safeFetch(`${API_BASE}/sentinel/prompts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`Create prompt failed: ${res.status}`);
  return res.json();
}

export async function deleteSentinelPrompt(promptId: string) {
  const res = await safeFetch(`${API_BASE}/sentinel/prompts/${promptId}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`Delete prompt failed: ${res.status}`);
  return res.json();
}

export async function runSentinelReview(data: { contract_id: string; prompt_id?: string; custom_prompt?: string }) {
  const res = await safeFetch(`${API_BASE}/sentinel/review`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`Sentinel review failed: ${res.status}`);
  return res.json();
}

export async function getSentinelSessions(contractId?: string) {
  const qs = contractId ? `?contract_id=${encodeURIComponent(contractId)}` : "";
  const res = await safeFetch(`${API_BASE}/sentinel/sessions${qs}`);
  if (!res.ok) throw new Error(`Sessions failed: ${res.status}`);
  return res.json();
}

export async function getSentinelSession(sessionId: string) {
  const res = await safeFetch(`${API_BASE}/sentinel/sessions/${sessionId}`);
  if (!res.ok) throw new Error(`Session failed: ${res.status}`);
  return res.json();
}

export async function explainClause(contractId: string, text: string) {
  const res = await safeFetch(`${API_BASE}/contracts/${contractId}/explain`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error(`Explain failed: ${res.status}`);
  return res.json();
}

// ─── Autopilot Agent ───────────────────────────────

export async function getAutopilotTemplates() {
  const res = await safeFetch(`${API_BASE}/autopilot/templates`);
  if (!res.ok) throw new Error(`Templates failed: ${res.status}`);
  return res.json();
}

export async function getAutopilotTasks(status?: string) {
  const qs = status ? `?status=${encodeURIComponent(status)}` : "";
  const res = await safeFetch(`${API_BASE}/autopilot/tasks${qs}`);
  if (!res.ok) throw new Error(`Tasks failed: ${res.status}`);
  return res.json();
}

export async function getAutopilotTask(taskId: string) {
  const res = await safeFetch(`${API_BASE}/autopilot/tasks/${taskId}`);
  if (!res.ok) throw new Error(`Task failed: ${res.status}`);
  return res.json();
}

export async function createAutopilotTask(data: { title: string; description: string; task_type?: string; scope?: string; contract_id?: string }) {
  const res = await safeFetch(`${API_BASE}/autopilot/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`Create task failed: ${res.status}`);
  return res.json();
}

export async function executeAutopilotTask(taskId: string) {
  const res = await safeFetch(`${API_BASE}/autopilot/tasks/${taskId}/execute`, { method: "POST" });
  if (!res.ok) throw new Error(`Execute task failed: ${res.status}`);
  return res.json();
}

// ─── Clause Risk Assessments ─────────────────────────

export async function getClauseAssessments(contractId: string) {
  const res = await safeFetch(`${API_BASE}/contracts/${contractId}/clause-assessments`);
  if (!res.ok) throw new Error(`Clause assessments failed: ${res.status}`);
  return res.json();
}

export async function runClauseAssessments(contractId: string) {
  const res = await safeFetch(`${API_BASE}/contracts/${contractId}/clause-assessments/run`, { method: "POST" });
  if (!res.ok) throw new Error(`Clause assessment run failed: ${res.status}`);
  return res.json();
}

// ─── Clause Library ──────────────────────────────────

export async function getClauseLibrary(category?: string) {
  const qs = category ? `?category=${encodeURIComponent(category)}` : "";
  const res = await safeFetch(`${API_BASE}/clause-library${qs}`);
  if (!res.ok) throw new Error(`Clause library failed: ${res.status}`);
  return res.json();
}

export async function createClause(data: { name: string; description: string; category?: string; standard_language?: string; risk_notes?: string; required?: boolean }) {
  const res = await safeFetch(`${API_BASE}/clause-library`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
  if (!res.ok) throw new Error(`Create clause failed: ${res.status}`);
  return res.json();
}

export async function updateClause(clauseId: string, data: Record<string, unknown>) {
  const res = await safeFetch(`${API_BASE}/clause-library/${clauseId}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
  if (!res.ok) throw new Error(`Update clause failed: ${res.status}`);
  return res.json();
}

export async function deleteClause(clauseId: string) {
  const res = await safeFetch(`${API_BASE}/clause-library/${clauseId}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`Delete clause failed: ${res.status}`);
  return res.json();
}

// ─── Workflows ───────────────────────────────────────

export async function getWorkflows(contractId?: string, status?: string) {
  const params = new URLSearchParams();
  if (contractId) params.set("contract_id", contractId);
  if (status) params.set("status", status);
  const qs = params.toString();
  const res = await safeFetch(`${API_BASE}/workflows${qs ? `?${qs}` : ""}`);
  if (!res.ok) throw new Error(`Workflows failed: ${res.status}`);
  return res.json();
}

export async function createWorkflow(data: { name: string; contract_id?: string; steps?: { title: string; step_type?: string; assignee?: string; description?: string }[] }) {
  const res = await safeFetch(`${API_BASE}/workflows`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
  if (!res.ok) throw new Error(`Create workflow failed: ${res.status}`);
  return res.json();
}

export async function getWorkflow(workflowId: string) {
  const res = await safeFetch(`${API_BASE}/workflows/${workflowId}`);
  if (!res.ok) throw new Error(`Workflow failed: ${res.status}`);
  return res.json();
}

export async function updateWorkflowStep(workflowId: string, stepId: string, data: { status?: string; assignee?: string }) {
  const res = await safeFetch(`${API_BASE}/workflows/${workflowId}/steps/${stepId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
  if (!res.ok) throw new Error(`Update step failed: ${res.status}`);
  return res.json();
}

// ─── Doc Templates & Generation ──────────────────────

export async function getDocTemplates() {
  const res = await safeFetch(`${API_BASE}/templates`);
  if (!res.ok) throw new Error(`Templates failed: ${res.status}`);
  return res.json();
}

export async function generateFromTemplate(templateId: string, data: { instructions?: string; variables?: Record<string, string>; title?: string }) {
  const res = await safeFetch(`${API_BASE}/templates/${templateId}/generate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
  if (!res.ok) throw new Error(`Generate failed: ${res.status}`);
  return res.json();
}

export async function getGeneratedDocs() {
  const res = await safeFetch(`${API_BASE}/generated-docs`);
  if (!res.ok) throw new Error(`Generated docs failed: ${res.status}`);
  return res.json();
}

// ─── Playbook Compare ────────────────────────────────

export async function playbookCompare(contractId: string, clauseKey: string, vendorText: string) {
  const res = await safeFetch(`${API_BASE}/contracts/${contractId}/playbook-compare`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ clause_key: clauseKey, vendor_text: vendorText }) });
  if (!res.ok) throw new Error(`Playbook compare failed: ${res.status}`);
  return res.json();
}

// ─── Contract Deletion ────────────────────────────────

export async function deleteContract(contractId: string) {
  const res = await safeFetch(`${API_BASE}/contracts/${contractId}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`Delete failed: ${res.status}`);
  return res.json();
}

export async function deleteAllContracts() {
  const res = await safeFetch(`${API_BASE}/contracts`, { method: "DELETE" });
  if (!res.ok) throw new Error(`Delete all failed: ${res.status}`);
  return res.json();
}

// ─── Review Decision & Summary ──────────────────────

export async function getReviewDecision(contractId: string) {
  const res = await safeFetch(`${API_BASE}/contracts/${contractId}/review-decision`);
  if (!res.ok) throw new Error(`Failed to fetch review decision: ${res.status}`);
  return res.json();
}

export async function saveReviewDecision(
  contractId: string,
  decision: string,
  reviewerNotes?: string,
  decidedBy: string = "analyst",
) {
  const res = await safeFetch(`${API_BASE}/contracts/${contractId}/review-decision`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ decision, reviewer_notes: reviewerNotes, decided_by: decidedBy }),
  });
  if (!res.ok) throw new Error(`Failed to save review decision: ${res.status}`);
  return res.json();
}

export async function generateReviewSummary(contractId: string) {
  const res = await safeFetch(`${API_BASE}/contracts/${contractId}/review-summary`, {
    method: "POST",
  });
  if (!res.ok) throw new Error(`Failed to generate review summary: ${res.status}`);
  return res.json();
}
