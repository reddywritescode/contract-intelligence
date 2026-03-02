from __future__ import annotations

import argparse
import json
from dataclasses import asdict, dataclass
from datetime import datetime
from pathlib import Path

import httpx

API = "http://127.0.0.1:8000/api/v1"


@dataclass
class Result:
    file: str
    contract_id: str
    run_id: str
    chunks: int
    trace_events: int
    ok: bool
    error: str


def default_samples(data_dir: Path) -> list[Path]:
    picks = [
        data_dir / "onecle" / "minson-emp-2019-08-12.shtml",
        data_dir / "onecle" / "st-giles-lease-2013-05-13.shtml",
        data_dir / "onecle" / "stearns-ppp-loan-2020-04-16.shtml",
        data_dir / "onecle" / "sveavagen-lease-2013-12-06.shtml",
        data_dir / "pdf" / "onecle-atlassian-terms.pdf",
    ]
    return picks


def run(samples: list[Path]) -> list[Result]:
    out: list[Result] = []
    with httpx.Client(timeout=180.0) as client:
        for p in samples:
            if not p.exists():
                out.append(
                    Result(file=str(p), contract_id="", run_id="", chunks=0, trace_events=0, ok=False, error="missing sample file")
                )
                continue

            try:
                with p.open("rb") as f:
                    ingest = client.post(
                        f"{API}/contracts/ingest",
                        files={"file": (p.name, f, "text/html")},
                    )
                ingest.raise_for_status()
                ingest_data = ingest.json()
                contract_id = ingest_data["contract_id"]

                analyze = client.post(
                    f"{API}/contracts/{contract_id}/analyze",
                    json={
                        "mode": "review",
                        "tasks": ["summary", "qa", "risk"],
                        "question": "List termination, renewal and liability concerns",
                    },
                )
                analyze.raise_for_status()
                analyze_data = analyze.json()
                run_id = analyze_data["run_id"]

                trace = client.get(f"{API}/runs/{run_id}/trace")
                trace.raise_for_status()
                trace_data = trace.json()

                out.append(
                    Result(
                        file=str(p),
                        contract_id=contract_id,
                        run_id=run_id,
                        chunks=int(ingest_data.get("chunks_indexed", 0)),
                        trace_events=len(trace_data.get("events", [])),
                        ok=True,
                        error="",
                    )
                )
            except Exception as exc:
                out.append(
                    Result(
                        file=str(p),
                        contract_id="",
                        run_id="",
                        chunks=0,
                        trace_events=0,
                        ok=False,
                        error=str(exc),
                    )
                )
    return out


def main() -> int:
    root = Path(__file__).resolve().parents[2]
    data_dir = root / "evalaution" / "data"
    runs_dir = root / "evalaution" / "runs"
    runs_dir.mkdir(parents=True, exist_ok=True)

    parser = argparse.ArgumentParser()
    parser.add_argument("--all", action="store_true", help="Evaluate all .shtml files in evalaution/data/onecle")
    args = parser.parse_args()

    if args.all:
        samples = sorted((root / "evalaution" / "data").rglob("*.shtml")) + sorted((root / "evalaution" / "data").rglob("*.pdf"))
    else:
        samples = default_samples(data_dir)
    results = run(samples)

    failed = [x for x in results if not x.ok]
    payload = {
        "timestamp": datetime.utcnow().isoformat() + "Z",
        "api": API,
        "total": len(results),
        "success": len(results) - len(failed),
        "failed": len(failed),
        "results": [asdict(x) for x in results],
    }

    report_file = runs_dir / f"self_eval_{datetime.utcnow().strftime('%Y%m%d_%H%M%S')}.json"
    report_file.write_text(json.dumps(payload, indent=2))

    print(json.dumps(payload, indent=2))
    print(f"\nSaved report: {report_file}")

    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
