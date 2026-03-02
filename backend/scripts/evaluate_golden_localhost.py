from __future__ import annotations

import json
import math
import re
from dataclasses import asdict, dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

import httpx

API = "http://127.0.0.1:8000/api/v1"
ROOT = Path(__file__).resolve().parents[2]
DATA_DIR = ROOT / "evalaution" / "data"
RUNS_DIR = ROOT / "evalaution" / "runs"
QUERIES_FILE = ROOT / "evalaution" / "golden_queries.json"


def _extract_text(path: Path) -> str:
    ext = path.suffix.lower()
    raw = path.read_bytes()
    if ext == ".pdf":
        try:
            from pypdf import PdfReader
            from io import BytesIO

            reader = PdfReader(BytesIO(raw))
            return "\n".join([(p.extract_text() or "") for p in reader.pages])
        except Exception:
            return ""

    text = raw.decode("utf-8", errors="ignore")
    text = re.sub(r"<script.*?>.*?</script>", " ", text, flags=re.I | re.S)
    text = re.sub(r"<style.*?>.*?</style>", " ", text, flags=re.I | re.S)
    text = re.sub(r"<[^>]+>", " ", text)
    text = re.sub(r"\s+", " ", text)
    return text


def _facet_present(text: str, keywords: list[str], min_hits: int) -> bool:
    t = text.lower()
    hits = 0
    for kw in keywords:
        hits += t.count(kw.lower())
    return hits >= min_hits


def _tokenize(text: str) -> set[str]:
    return set(re.findall(r"[a-zA-Z]{3,}", text.lower()))


def _semantic_overlap(a: str, b: str) -> float:
    ta = _tokenize(a)
    tb = _tokenize(b)
    if not ta or not tb:
        return 0.0
    inter = len(ta.intersection(tb))
    return inter / math.sqrt(len(ta) * len(tb))


@dataclass
class FacetResult:
    facet: str
    question: str
    expected_present: bool
    keyword_match: float
    semantic_match: float
    heuristic_pass: bool
    citations: int
    insufficient_evidence: bool


@dataclass
class DocResult:
    file: str
    contract_id: str
    run_id: str
    aggregate_run_id: str
    facet_results: list[FacetResult]
    aggregate_keyword_coverage: float
    ok: bool


def _ask(client: httpx.Client, contract_id: str, question: str) -> dict[str, Any]:
    resp = client.post(
        f"{API}/contracts/{contract_id}/analyze",
        json={"mode": "review", "tasks": ["qa"], "question": question},
        timeout=180.0,
    )
    resp.raise_for_status()
    return resp.json()


def evaluate() -> dict[str, Any]:
    RUNS_DIR.mkdir(parents=True, exist_ok=True)

    spec = json.loads(QUERIES_FILE.read_text())
    facets = spec["facets"]
    aggregate_query = spec["aggregate_query"]

    files = [p for p in (sorted(DATA_DIR.rglob("*.shtml")) + sorted(DATA_DIR.rglob("*.pdf"))) if p.name != "index.shtml"]
    doc_results: list[DocResult] = []

    with httpx.Client(timeout=180.0) as client:
        for path in files:
            with path.open("rb") as f:
                ingest = client.post(
                    f"{API}/contracts/ingest",
                    files={"file": (path.name, f, "application/octet-stream")},
                )
            ingest.raise_for_status()
            contract_id = ingest.json()["contract_id"]

            text = _extract_text(path)
            facet_results: list[FacetResult] = []
            last_run_id = ""

            for facet in facets:
                expected = _facet_present(text, facet["keywords"], int(facet.get("min_hits", 1)))
                out = _ask(client, contract_id, facet["question"])
                last_run_id = out["run_id"]
                answer = (out.get("answer") or "").lower()
                citations = len(out.get("answer_citations") or [])
                insufficient = "insufficient_evidence" in answer

                matched = sum(1 for k in facet["keywords"] if k.lower() in answer)
                keyword_score = matched / max(1, len(facet["keywords"]))
                semantic_score = _semantic_overlap(" ".join(facet["keywords"]), answer)

                if expected:
                    heuristic_pass = (citations > 0) and (
                        (not insufficient) or keyword_score >= 0.4 or semantic_score >= 0.16
                    )
                else:
                    heuristic_pass = insufficient or keyword_score < 0.4

                facet_results.append(
                    FacetResult(
                        facet=facet["id"],
                        question=facet["question"],
                        expected_present=expected,
                        keyword_match=round(keyword_score, 3),
                        semantic_match=round(semantic_score, 3),
                        heuristic_pass=heuristic_pass,
                        citations=citations,
                        insufficient_evidence=insufficient,
                    )
                )

            agg = _ask(client, contract_id, aggregate_query)
            agg_answer = (agg.get("answer") or "").lower()
            aggregate_hits = 0
            for facet in facets:
                if any(k.lower() in agg_answer for k in facet["keywords"][:2]):
                    aggregate_hits += 1
            aggregate_cov = aggregate_hits / max(1, len(facets))

            avg_sem = sum(x.semantic_match for x in facet_results) / max(1, len(facet_results))
            heur_rate = sum(1 for x in facet_results if x.heuristic_pass) / max(1, len(facet_results))

            ok = (heur_rate >= 0.8) and (aggregate_cov >= 0.5) and (avg_sem >= 0.08)

            doc_results.append(
                DocResult(
                    file=str(path),
                    contract_id=contract_id,
                    run_id=last_run_id,
                    aggregate_run_id=agg["run_id"],
                    facet_results=facet_results,
                    aggregate_keyword_coverage=round(aggregate_cov, 3),
                    ok=ok,
                )
            )

    failed = [d for d in doc_results if not d.ok]

    payload = {
        "timestamp": datetime.utcnow().isoformat() + "Z",
        "api": API,
        "total_docs": len(doc_results),
        "passed_docs": len(doc_results) - len(failed),
        "failed_docs": len(failed),
        "documents": [
            {
                **{k: v for k, v in asdict(d).items() if k != "facet_results"},
                "facet_results": [asdict(f) for f in d.facet_results],
            }
            for d in doc_results
        ],
    }

    out_path = RUNS_DIR / f"golden_eval_{datetime.utcnow().strftime('%Y%m%d_%H%M%S')}.json"
    out_path.write_text(json.dumps(payload, indent=2))
    payload["report_file"] = str(out_path)
    return payload


if __name__ == "__main__":
    result = evaluate()
    print(json.dumps(result, indent=2))
    raise SystemExit(1 if result["failed_docs"] > 0 else 0)
