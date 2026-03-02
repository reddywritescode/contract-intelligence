from __future__ import annotations

import json
import re
from dataclasses import asdict, dataclass
from pathlib import Path
from urllib.parse import urljoin

import httpx

from app.models.schemas import AnalyzeRequest, RunMode, TaskType
from app.services.analysis import run_analysis
from app.services.ingestion import ingest_contract


BASE = "https://contracts.onecle.com"
CATEGORY_PATHS = [
    "/type/2.shtml",   # Employment
    "/type/16.shtml",  # Lease
    "/type/30.shtml",  # Loan
]
PER_CATEGORY = 3


@dataclass
class EvalResult:
    category: str
    source: str
    filename: str
    downloaded: bool
    chunks: int
    ok: bool
    error: str
    run_id: str
    answer_chars: int
    risk_count: int


HREF_RE = re.compile(r'href=["\']([^"\']+)["\']', re.IGNORECASE)


def _fetch(url: str) -> tuple[str, bytes]:
    headers = {
        "User-Agent": "contract-intelligence-eval/1.0 (+local testing)",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    }
    with httpx.Client(timeout=60.0, follow_redirects=True, headers=headers) as client:
        r = client.get(url)
        r.raise_for_status()
        content_type = r.headers.get("content-type", "")
        if "text" not in content_type and "html" not in content_type:
            # still allow; some pages might misreport
            pass
        return r.text, r.content


def _extract_contract_links(category_url: str) -> list[str]:
    html, _ = _fetch(category_url)
    links: list[str] = []
    seen: set[str] = set()

    for m in HREF_RE.finditer(html):
        href = m.group(1).strip()
        if href.startswith("#"):
            continue
        if href.startswith("http"):
            full = href
        elif href.startswith("//"):
            full = "https:" + href
        else:
            full = urljoin(category_url, href)

        if not full.startswith(BASE):
            continue
        if "/type/" in full or "/consumer/" in full or "/industries/" in full or "/alpha/" in full:
            continue
        if not full.endswith(".shtml"):
            continue
        if full.endswith("/index.shtml"):
            continue
        # Prefer deep contract links like /company/contract-name.shtml
        if full.replace(BASE, "").count("/") < 2:
            continue
        if full in seen:
            continue
        seen.add(full)
        links.append(full)

    return links


def evaluate() -> list[EvalResult]:
    outdir = Path("/tmp/contract-intelligence-onecle")
    outdir.mkdir(parents=True, exist_ok=True)

    results: list[EvalResult] = []

    for cat in CATEGORY_PATHS:
        category_url = urljoin(BASE, cat)
        category_name = cat.split("/")[-1]
        try:
            links = _extract_contract_links(category_url)[:PER_CATEGORY]
        except Exception as exc:
            results.append(
                EvalResult(
                    category=category_name,
                    source=category_url,
                    filename="",
                    downloaded=False,
                    chunks=0,
                    ok=False,
                    error=f"category crawl failed: {exc}",
                    run_id="",
                    answer_chars=0,
                    risk_count=0,
                )
            )
            continue

        for link in links:
            filename = link.rstrip("/").split("/")[-1] or "contract.shtml"
            try:
                html, content = _fetch(link)
                local_file = outdir / filename
                local_file.write_bytes(content)

                record = ingest_contract(filename, content)
                response = run_analysis(
                    record.contract_id,
                    AnalyzeRequest(
                        mode=RunMode.AGENT,
                        tasks=[TaskType.SUMMARY, TaskType.QA, TaskType.RISK],
                        question="Identify term, termination, liability, renewal and payment risks.",
                    ),
                )

                results.append(
                    EvalResult(
                        category=category_name,
                        source=link,
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
                        category=category_name,
                        source=link,
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
    print(f"\nTotal: {len(results)} | Success: {len(results)-len(failures)} | Failed: {len(failures)}")
    if failures:
        raise SystemExit(1)
