"use client";

import { useEffect, useMemo, useRef } from "react";

type ChunkItem = { chunk_id: string; text: string; section?: string; page?: number | null };
type HighlightItem = { chunk_id: string; section?: string; page?: number | null; excerpt?: string };
type HighlightMode = null | "clauses" | "risks" | "parties" | "dates";

type Props = {
  chunks: ChunkItem[];
  highlights: Record<string, HighlightItem[]>;
  highlightedIds: Set<string>;
  highlightMode: HighlightMode;
  currentChunkId: string | null;
  scrollToChunkId: string | null;
  onScrollDone: () => void;
  contractName: string;
  totalChunks: number;
  highlightIndex: number;
  highlightTotal: number;
  onPrev: () => void;
  onNext: () => void;
};

const clauseGroupForChunk = (chunkId: string, highlights: Record<string, HighlightItem[]>): string | null => {
  for (const [group, items] of Object.entries(highlights)) {
    if (items.some(i => i.chunk_id === chunkId)) return group;
  }
  return null;
};

const tagStyleMap: Record<string, string> = {
  term_and_renewal: "docChunk__tag--term",
  termination: "docChunk__tag--termination",
  liability_and_indemnity: "docChunk__tag--liability",
  payment: "docChunk__tag--payment",
  governing_law: "docChunk__tag--governing",
  confidentiality: "docChunk__tag--governing",
  intellectual_property: "docChunk__tag--term",
  force_majeure: "docChunk__tag--termination",
};

const tagLabel: Record<string, string> = {
  term_and_renewal: "Term",
  termination: "Termination",
  liability_and_indemnity: "Liability",
  payment: "Payment",
  confidentiality: "Confidentiality",
  intellectual_property: "IP",
  force_majeure: "Force Majeure",
  governing_law: "Governing Law",
};

function highlightClass(mode: HighlightMode): string {
  switch (mode) {
    case "clauses": return "docChunk--highlighted";
    case "risks": return "docChunk--highlighted-risk";
    case "parties": return "docChunk--highlighted-party";
    case "dates": return "docChunk--highlighted-date";
    default: return "docChunk--highlighted";
  }
}

export default function DocumentViewer({
  chunks, highlights, highlightedIds, highlightMode, currentChunkId,
  scrollToChunkId, onScrollDone, contractName, totalChunks,
  highlightIndex, highlightTotal, onPrev, onNext,
}: Props) {
  const chunkRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  useEffect(() => {
    if (!scrollToChunkId) return;
    const el = chunkRefs.current.get(scrollToChunkId);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      onScrollDone();
    }
  }, [scrollToChunkId, onScrollDone]);

  const clauseMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const [group, items] of Object.entries(highlights)) {
      for (const item of items) m.set(item.chunk_id, group);
    }
    return m;
  }, [highlights]);

  return (
    <div className="docViewer">
      <div className="docViewer__page">
        <div className="docViewer__header">
          <span className="docViewer__docTitle">{contractName}</span>
          <span className="docViewer__docMeta">{totalChunks} sections</span>
        </div>

        {/* Clause navigation bar */}
        {highlightMode && highlightTotal > 0 && (
          <div className="clauseNav">
            <div className="clauseNav__info">
              <strong>{highlightMode === "clauses" ? "Clause" : highlightMode === "risks" ? "Risk" : highlightMode === "parties" ? "Party" : "Date"}</strong>
              <span>{highlightIndex + 1} of {highlightTotal}</span>
            </div>
            <div className="clauseNav__btns">
              <button type="button" className="clauseNav__btn" onClick={onPrev} disabled={highlightTotal <= 1}>&larr; Prev</button>
              <button type="button" className="clauseNav__btn" onClick={onNext} disabled={highlightTotal <= 1}>Next &rarr;</button>
            </div>
          </div>
        )}

        {chunks.length === 0 && (
          <div style={{ padding: "40px 0", textAlign: "center", color: "var(--text-muted)", fontSize: 13 }}>
            No document content loaded.
          </div>
        )}

        {chunks.map(chunk => {
          const isHighlighted = highlightedIds.has(chunk.chunk_id);
          const isCurrent = currentChunkId === chunk.chunk_id;
          const group = clauseMap.get(chunk.chunk_id);
          const tagCls = group ? (tagStyleMap[group] || "docChunk__tag--governing") : null;
          const label = group ? (tagLabel[group] || group.replace(/[_\-]+/g, " ").replace(/\b\w/g, c => c.toUpperCase())) : null;

          let cls = "docChunk";
          if (isHighlighted && highlightMode) cls += ` ${highlightClass(highlightMode)}`;
          if (isCurrent) cls += " docChunk--current";

          return (
            <div
              key={chunk.chunk_id}
              className={cls}
              ref={el => { if (el) chunkRefs.current.set(chunk.chunk_id, el); else chunkRefs.current.delete(chunk.chunk_id); }}
            >
              {chunk.text}
              {group && tagCls && (
                <span className={`docChunk__tag ${tagCls}`}>{label}</span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
