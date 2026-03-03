"use client";

import { useEffect, useMemo, useRef } from "react";

type ChunkLike = { chunk_id: string; text: string; section?: string; page?: number | null };
type HighlightMode = null | "clauses" | "risks" | "parties" | "dates";
type RiskAnnotation = { chunk_id: string; risk_level: string; risk_score: number; clause_type: string };
type AssessmentLike = { risk_level: string; risk_score: number; reason: string; clause_type: string } | null;

type Props = {
  fileUrl: string;
  chunks: ChunkLike[];
  highlightedList: ChunkLike[];
  highlightMode: HighlightMode;
  highlightIndex: number;
  highlightTotal: number;
  onPrev: () => void;
  onNext: () => void;
  contractName: string;
  riskAnnotations?: RiskAnnotation[];
  onChunkClick?: (chunkId: string) => void;
  categoryColor?: string;
  activeGroupName?: string;
  activeAssessment?: AssessmentLike;
  onBadgeClick?: (clauseType: string) => void;
  pulse?: boolean;
};

const modeLabels: Record<string, string> = {
  clauses: "Clause",
  risks: "Risk",
  parties: "Party",
  dates: "Date",
};

const modeDotColors: Record<string, string> = {
  clauses: "#f59e0b",
  risks: "#ef4444",
  parties: "#3b82f6",
  dates: "#22c55e",
};

const RISK_BADGE_COLORS: Record<string, string> = {
  high: "#ef4444",
  medium: "#f59e0b",
  low: "#22c55e",
};

export default function PdfViewer({
  fileUrl, chunks, highlightedList, highlightMode,
  highlightIndex, highlightTotal, onPrev, onNext, contractName,
  riskAnnotations, onChunkClick, categoryColor, activeGroupName,
  activeAssessment, onBadgeClick, pulse,
}: Props) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const readyRef = useRef(false);
  const pendingRef = useRef<(() => void) | null>(null);

  const iframeSrc = useMemo(() => {
    return `/pdfviewer.html?url=${encodeURIComponent(fileUrl)}`;
  }, [fileUrl]);

  useEffect(() => {
    function onMsg(e: MessageEvent) {
      if (e.data?.type === "ready") {
        readyRef.current = true;
        if (pendingRef.current) {
          pendingRef.current();
          pendingRef.current = null;
        }
      }
      if (e.data?.type === "chunkClick" && e.data?.chunkId && onChunkClick) {
        onChunkClick(e.data.chunkId);
      }
      if (e.data?.type === "badgeClick" && e.data?.clauseType && onBadgeClick) {
        onBadgeClick(e.data.clauseType);
      }
    }
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [onChunkClick, onBadgeClick]);

  const sendMessage = (msg: unknown) => {
    const iframe = iframeRef.current;
    if (!iframe?.contentWindow) return;
    if (readyRef.current) {
      iframe.contentWindow.postMessage(msg, "*");
    } else {
      pendingRef.current = () => iframe.contentWindow!.postMessage(msg, "*");
    }
  };

  const currentItem = highlightedList[highlightIndex] ?? null;

  useEffect(() => {
    if (!highlightMode || highlightTotal === 0 || !currentItem) {
      sendMessage({ type: "clear" });
      return;
    }

    const textEntries = highlightedList.map(h => ({
      text: h.text.slice(0, 500),
      page: h.page ?? null,
    }));
    const currentText = currentItem.text.slice(0, 500);

    const riskMap: Record<string, { risk_level: string; risk_score: number; clause_type: string }> = {};
    if (riskAnnotations) {
      for (const ra of riskAnnotations) {
        const chunk = chunks.find(c => c.chunk_id === ra.chunk_id);
        if (chunk) {
          riskMap[chunk.text.slice(0, 500)] = { risk_level: ra.risk_level, risk_score: ra.risk_score, clause_type: ra.clause_type };
        }
      }
    }

    const badgeData = activeAssessment ? {
      risk_level: activeAssessment.risk_level,
      risk_score: activeAssessment.risk_score,
      reason: activeAssessment.reason,
      clause_type: activeAssessment.clause_type,
    } : null;

    sendMessage({
      type: "highlight",
      payload: {
        textEntries,
        texts: textEntries.map(e => e.text),
        focusText: currentText,
        focusPage: currentItem.page || null,
        mode: highlightMode,
        page: currentItem.page || null,
        riskMap,
        categoryColor: categoryColor || null,
        badgeData,
        pulse: !!pulse,
      },
    });
  }, [highlightMode, highlightIndex, highlightTotal, currentItem, riskAnnotations, categoryColor, activeAssessment, pulse]); // eslint-disable-line react-hooks/exhaustive-deps

  const indicatorColor = categoryColor || modeDotColors[highlightMode || "clauses"] || "#f59e0b";
  const indicatorLabel = activeGroupName || (modeLabels[highlightMode || "clauses"] || "Item");
  const riskBadgeColor = activeAssessment ? (RISK_BADGE_COLORS[activeAssessment.risk_level] || "#6b7280") : null;

  return (
    <div className="pdfViewer">
      {highlightMode && highlightTotal > 0 && currentItem && (
        <div className="pdfViewer__nav">
          <div className="pdfViewer__navLeft">
            <span className="pdfViewer__navIndicator" style={{ background: indicatorColor }}>
              {indicatorLabel}
            </span>
            {activeAssessment && riskBadgeColor && (
              <span className="pdfViewer__navRiskPill" style={{ background: riskBadgeColor }} title={`${activeAssessment.risk_level === "high" ? "High" : activeAssessment.risk_level === "medium" ? "Medium" : "Low"} Risk — score ${activeAssessment.risk_score} out of 100`}>
                {activeAssessment.risk_level === "high" ? "High" : activeAssessment.risk_level === "medium" ? "Med" : "Low"} {activeAssessment.risk_score}
              </span>
            )}
            <span className="pdfViewer__navCount">
              Section {highlightIndex + 1} of {highlightTotal}
            </span>
          </div>
          <div className="pdfViewer__navCenter">
            {activeAssessment?.reason ? (
              <span className="pdfViewer__navReason" title={activeAssessment.reason}>
                {activeAssessment.reason.length > 60 ? activeAssessment.reason.slice(0, 58) + "\u2026" : activeAssessment.reason}
              </span>
            ) : (
              <>
                {currentItem.section && (
                  <span className="pdfViewer__navSection">{currentItem.section}</span>
                )}
                {currentItem.page != null && (
                  <span className="pdfViewer__navPage">Page {currentItem.page}</span>
                )}
              </>
            )}
          </div>
          <div className="pdfViewer__navBtns">
            <button type="button" onClick={onPrev} disabled={highlightTotal <= 1}>
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M8.5 3L4.5 7l4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
              Prev
            </button>
            <button type="button" onClick={onNext} disabled={highlightTotal <= 1}>
              Next
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M5.5 3l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
            </button>
          </div>
        </div>
      )}

      {highlightMode && currentItem && (
        <div className="pdfViewer__excerpt" style={{ borderLeftColor: indicatorColor }}>
          <div className="pdfViewer__excerptHeader">
            <span className="pdfViewer__excerptLabel">
              {currentItem.section || (indicatorLabel + " " + (highlightIndex + 1))}
            </span>
            <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
              {activeAssessment && (
                <span className={`pdfViewer__excerptRisk pdfViewer__excerptRisk--${activeAssessment.risk_level}`}>
                  {activeAssessment.risk_level} {activeAssessment.risk_score}
                </span>
              )}
              {currentItem.page != null && <span className="pdfViewer__excerptPage">p.{currentItem.page}</span>}
            </span>
          </div>
          <div className="pdfViewer__excerptText">{currentItem.text.slice(0, 280)}{currentItem.text.length > 280 ? "\u2026" : ""}</div>
        </div>
      )}

      <iframe
        ref={iframeRef}
        src={iframeSrc}
        className="pdfViewer__frame"
        title={contractName}
      />
    </div>
  );
}
