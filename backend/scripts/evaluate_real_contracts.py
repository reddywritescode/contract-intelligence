from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from pathlib import Path

import httpx

from app.models.schemas import AnalyzeRequest, RunMode, TaskType
from app.services.analysis import run_analysis
from app.services.ingestion import ingest_contract


@dataclass
class EvalResult:
    source: str
    filename: str
    downloaded: bool
    chunks: int
    ok: bool
    error: str
    run_id: str
    answer_chars: int
    risk_count: int


SOURCES = [
    # Public long-form legal agreements (mixed HTML/PDF).
    "https://dam-cdn.atl.orangelogic.com/AssetLink/d44026cgwtf4d5h8x23q84ff20e3vydu.pdf",
    "https://www.atlassian.com/legal/cloud-terms-of-service",
    "https://www.atlassian.com/legal/product-terms",
    "https://www.salesforce.com/company/legal/agreements/",
]


def _download(url: str, outdir: Path) -> tuple[Path, bytes]:
    outdir.mkdir(parents=True, exist_ok=True)
    filename = url.split("/")[-1] or "contract.txt"
    path = outdir / filename

    headers = {"User-Agent": "contract-intelligence-eval/1.0 (local testing)"}
    with httpx.Client(timeout=60.0, follow_redirects=True, headers=headers) as client:
        resp = client.get(url)
        resp.raise_for_status()
        data = resp.content

    path.write_bytes(data)
    return path, data


def evaluate() -> list[EvalResult]:
    outdir = Path("/tmp/contract-intelligence-eval")
    results: list[EvalResult] = []

    for source in SOURCES:
        filename = source.split("/")[-1] or "contract.txt"
        try:
            path, data = _download(source, outdir)
            record = ingest_contract(path.name, data)
            response = run_analysis(
                record.contract_id,
                AnalyzeRequest(
                    mode=RunMode.AGENT,
                    tasks=[TaskType.SUMMARY, TaskType.QA, TaskType.RISK],
                    question="Identify high risk clauses and renewal terms.",
                ),
            )
            results.append(
                EvalResult(
                    source=source,
                    filename=filename,
                    downloaded=True,
                    chunks=len(record.chunks),
                    ok=True,
                    error="",
                    run_id=response.run_id,
                    answer_chars=len(response.answer or ""),
                    risk_count=len(response.risks),
                )
            )
        except Exception as exc:
            results.append(
                EvalResult(
                    source=source,
                    filename=filename,
                    downloaded=False,
                    chunks=0,
                    ok=False,
                    error=str(exc),
                    run_id="",
                    answer_chars=0,
                    risk_count=0,
                )
            )

    return results


if __name__ == "__main__":
    results = evaluate()
    payload = [asdict(r) for r in results]
    print(json.dumps(payload, indent=2))
    failures = [r for r in results if not r.ok]
    if failures:
        raise SystemExit(1)
