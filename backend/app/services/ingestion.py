from __future__ import annotations

import logging
import re
import uuid
from io import BytesIO
from pathlib import Path

from app.models.schemas import ContractChunk, ContractRecord
from app.services.repository import upsert_contract

logger = logging.getLogger(__name__)

# Patterns that indicate a new contract section (structural detection)
_SECTION_HEADER_RX = re.compile(
    r"^("
    r"\d+\.\s"                           # "1. " "12. "
    r"|\d+\.\d+\s"                       # "1.1 " "3.2 "
    r"|SECTION\s+\d+"                    # "SECTION 1"
    r"|ARTICLE\s+[IVXLCDM\d]+"          # "ARTICLE I" "ARTICLE 3"
    r"|(?:EXHIBIT|SCHEDULE|ANNEX)\s+[A-Z]"  # "EXHIBIT A"
    r"|[A-Z][A-Z ]{3,}(?:\.|:|\n)"      # "GOVERNING LAW." "TERMINATION:"
    r")",
    re.MULTILINE | re.IGNORECASE,
)

MAX_CHUNK_SIZE = 1200
MIN_CHUNK_SIZE = 100

# Minimum paragraphs needed for embedding-based detection to be meaningful
_MIN_PARAGRAPHS_FOR_SEMANTIC = 3
# Floor for similarity threshold to avoid over-splitting highly varied documents
_SIMILARITY_FLOOR = 0.3


# ── Smart paragraph splitting ──────────────────────────────────

_HEADER_LINE_RX = re.compile(
    r"^("
    r"\d+\.\s"
    r"|\d+\.\d+\s"
    r"|SECTION\s+\d+"
    r"|ARTICLE\s+[IVXLCDM\d]+"
    r"|(?:EXHIBIT|SCHEDULE|ANNEX)\s+[A-Z]"
    r"|[A-Z][A-Z ]{3,}(?:\.|:|\s*$)"
    r")",
    re.MULTILINE,
)


def _smart_paragraph_split(text: str) -> list[str]:
    """Split text into paragraphs, handling PDFs that lack double-newlines.

    Strategy: first try double-newline. If that yields very few paragraphs
    for a large document, re-split at lines that look like section headers.
    Page markers [[PAGE:N]] are kept inline so downstream code can resolve pages.
    """
    paras = [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]

    if len(paras) > 5 or len(text) < 500:
        return paras

    lines = text.split("\n")
    result: list[str] = []
    buffer: list[str] = []
    current_page_marker = ""

    for line in lines:
        stripped = line.strip()
        if not stripped:
            continue

        # Absorb page markers — attach to next paragraph
        if stripped.startswith("[[PAGE:"):
            current_page_marker = stripped
            continue

        is_header = _HEADER_LINE_RX.match(stripped) and len(stripped) < 120

        if is_header and buffer:
            result.append("\n".join(buffer))
            buffer = []

        if current_page_marker and not buffer:
            buffer.append(current_page_marker)
            current_page_marker = ""

        buffer.append(stripped)

    if buffer:
        result.append("\n".join(buffer))

    result = [p for p in result if len(p.strip()) > 20]

    if len(result) > len(paras):
        logger.info("Smart split: %d -> %d paragraphs (header-based re-split)", len(paras), len(result))
        return result
    return paras


# ── Cosine similarity (no numpy dependency) ──────────────────────


def _cosine_similarity(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    norm_a = sum(x * x for x in a) ** 0.5
    norm_b = sum(x * x for x in b) ** 0.5
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return dot / (norm_a * norm_b)


# ── Regex-based structural detection (fast, free) ────────────────


def _detect_sections(text: str) -> list[tuple[str, str]]:
    """Split text into (section_title, section_body) pairs using header patterns."""
    lines = text.split("\n")
    sections: list[tuple[str, str]] = []
    current_title = "Preamble"
    current_lines: list[str] = []

    for line in lines:
        stripped = line.strip()
        if not stripped:
            current_lines.append("")
            continue

        if _SECTION_HEADER_RX.match(stripped) and len(stripped) < 120:
            if current_lines:
                body = "\n".join(current_lines).strip()
                if body:
                    sections.append((current_title, body))
            current_title = stripped.rstrip(".:").strip()
            current_lines = []
        else:
            current_lines.append(stripped)

    if current_lines:
        body = "\n".join(current_lines).strip()
        if body:
            sections.append((current_title, body))

    return sections


def _find_regex_boundaries(paragraphs: list[str]) -> set[int]:
    """Return paragraph indices whose first line matches a structural header."""
    boundaries: set[int] = set()
    for i, para in enumerate(paragraphs):
        first_line = para.split("\n")[0].strip()
        if _SECTION_HEADER_RX.match(first_line) and len(first_line) < 120:
            boundaries.add(i)
    return boundaries


# ── Embedding-based semantic detection (topic-shift aware) ───────


def _find_semantic_boundaries(paragraphs: list[str]) -> set[int]:
    """Detect topic-shift boundaries using embedding cosine similarity.

    Embeds each paragraph and identifies points where consecutive
    similarity drops significantly (adaptive threshold: mean - 1*std).
    """
    if len(paragraphs) < _MIN_PARAGRAPHS_FOR_SEMANTIC:
        return set()

    from app.services.embeddings import generate_embeddings_batch

    embed_texts = [p[:500] for p in paragraphs]
    embeddings = generate_embeddings_batch(embed_texts)

    if not embeddings or len(embeddings) < 2:
        return set()

    valid = [e for e in embeddings if e is not None]
    if len(valid) < 2:
        return set()

    similarities: list[float] = []
    for i in range(len(embeddings) - 1):
        if embeddings[i] is None or embeddings[i + 1] is None:
            similarities.append(1.0)
            continue
        similarities.append(_cosine_similarity(embeddings[i], embeddings[i + 1]))

    mean_sim = sum(similarities) / len(similarities)
    variance = sum((s - mean_sim) ** 2 for s in similarities) / len(similarities)
    std_sim = variance ** 0.5
    threshold = max(mean_sim - std_sim, _SIMILARITY_FLOOR)

    return {i + 1 for i, sim in enumerate(similarities) if sim < threshold}


# ── Hybrid detection (regex + semantic, combined) ────────────────


def _infer_section_title(text: str) -> str:
    """Derive a section title from the first line of a paragraph group."""
    line = text.split("\n")[0].strip()
    if _SECTION_HEADER_RX.match(line) and len(line) < 120:
        return line.rstrip(".:").strip()
    if len(line) <= 80:
        return line.rstrip(".:").strip()
    return line[:77].strip() + "..."


def _detect_sections_hybrid(text: str) -> list[tuple[str, str]]:
    """Combined regex structural + embedding semantic section detection.

    Both regex and embedding boundary sets are unioned so we split at
    explicit headers AND at implicit topic shifts.  If the embedding API
    is unavailable the function degrades gracefully to regex-only.
    """
    paragraphs = _smart_paragraph_split(text)

    if not paragraphs:
        return []
    if len(paragraphs) <= 2:
        return [(_infer_section_title(paragraphs[0]), "\n\n".join(paragraphs))]

    regex_boundaries = _find_regex_boundaries(paragraphs)

    try:
        semantic_boundaries = _find_semantic_boundaries(paragraphs)
        logger.info(
            "Hybrid chunking: %d structural + %d semantic boundaries from %d paragraphs",
            len(regex_boundaries), len(semantic_boundaries), len(paragraphs),
        )
    except Exception as exc:
        logger.warning("Embedding-based detection failed, using structural only: %s", exc)
        semantic_boundaries = set()

    all_boundaries = sorted(regex_boundaries | semantic_boundaries | {0})

    sections: list[tuple[str, str]] = []
    for b_idx in range(len(all_boundaries)):
        start = all_boundaries[b_idx]
        end = all_boundaries[b_idx + 1] if b_idx + 1 < len(all_boundaries) else len(paragraphs)
        group = paragraphs[start:end]
        if not group:
            continue

        body = "\n\n".join(group)
        first_line = group[0].split("\n")[0].strip()

        if _SECTION_HEADER_RX.match(first_line) and len(first_line) < 120:
            title = first_line.rstrip(".:").strip()
        else:
            # Scan group for a structural header to use as title
            title = ""
            for para in group:
                fl = para.split("\n")[0].strip()
                if _SECTION_HEADER_RX.match(fl) and len(fl) < 120:
                    title = fl.rstrip(".:").strip()
                    break
            if not title:
                title = _infer_section_title(group[0])

        sections.append((title, body))

    return sections if sections else [("Full Document", text)]


# ── Size-based splitting and merging ─────────────────────────────


def _split_long_section(title: str, body: str) -> list[tuple[str, str]]:
    """Split a section that exceeds MAX_CHUNK_SIZE at paragraph boundaries."""
    if len(body) <= MAX_CHUNK_SIZE:
        return [(title, body)]

    paragraphs = re.split(r"\n\s*\n", body)
    result: list[tuple[str, str]] = []
    buffer = ""
    part = 1

    for para in paragraphs:
        para = para.strip()
        if not para:
            continue
        if buffer and len(buffer) + len(para) + 2 > MAX_CHUNK_SIZE:
            result.append((f"{title} (Part {part})" if part > 1 or len(paragraphs) > 2 else title, buffer.strip()))
            part += 1
            buffer = para
        else:
            buffer = f"{buffer}\n\n{para}" if buffer else para

    if buffer.strip():
        result.append((f"{title} (Part {part})" if part > 1 else title, buffer.strip()))

    return result


def _merge_small_sections(sections: list[tuple[str, str]]) -> list[tuple[str, str]]:
    """Merge sections smaller than MIN_CHUNK_SIZE into neighbours."""
    merged: list[tuple[str, str]] = []
    buf_title = ""
    buf_body = ""

    for title, body in sections:
        if len(body) < MIN_CHUNK_SIZE and buf_body:
            buf_body += f"\n\n{body}"
        elif len(body) < MIN_CHUNK_SIZE:
            buf_title = title
            buf_body = body
        else:
            if buf_body:
                merged.append((buf_title, buf_body))
                buf_title = ""
                buf_body = ""
            merged.append((title, body))

    if buf_body:
        merged.append((buf_title, buf_body))

    return merged


# ── Public API ───────────────────────────────────────────────────


_PAGE_MARKER_RX = re.compile(r"\[\[PAGE:(\d+)\]\]")


def _resolve_page(body: str) -> int | None:
    """Extract the page number from the first [[PAGE:N]] marker in a chunk body."""
    m = _PAGE_MARKER_RX.search(body)
    return int(m.group(1)) if m else None


def _strip_page_markers(text: str) -> str:
    return _PAGE_MARKER_RX.sub("", text).strip()


def split_into_chunks(text: str, chunk_size: int = MAX_CHUNK_SIZE) -> list[ContractChunk]:
    """Parse contract text into semantic chunks.

    Uses hybrid detection (embedding similarity + regex headers) to find
    section boundaries, then splits oversized sections and merges tiny ones.
    Falls back to regex-only when embeddings are unavailable.
    """
    text = text.strip()
    if not text:
        return []

    sections = _detect_sections_hybrid(text)

    final_sections: list[tuple[str, str]] = []
    for title, body in sections:
        final_sections.extend(_split_long_section(title, body))

    merged = _merge_small_sections(final_sections)

    chunks: list[ContractChunk] = []
    last_page: int | None = None
    for idx, (title, body) in enumerate(merged):
        page = _resolve_page(body)
        if page is not None:
            last_page = page
        else:
            page = last_page

        clean_body = _strip_page_markers(body)
        clean_title = _strip_page_markers(title)
        if clean_body and len(clean_body.strip()) > 10:
            chunks.append(ContractChunk(
                chunk_id=f"c{idx + 1:04d}",
                text=clean_body,
                section=clean_title,
                page=page,
            ))
    return chunks


def _extract_text_from_pdf(content: bytes) -> str:
    try:
        from pypdf import PdfReader
    except ImportError:
        return ""

    reader = PdfReader(BytesIO(content))
    parts: list[str] = []
    for i, page in enumerate(reader.pages):
        text = page.extract_text() or ""
        if text.strip():
            parts.append(f"[[PAGE:{i + 1}]]\n{text}")
    return "\n\n".join(parts)


def _extract_text_from_docx(content: bytes) -> str:
    try:
        from docx import Document
    except ImportError:
        return ""

    doc = Document(BytesIO(content))
    return "\n".join([p.text for p in doc.paragraphs if p.text])


def _extract_text_from_html(content: bytes) -> str:
    text = content.decode("utf-8", errors="ignore")
    text = re.sub(r"<script.*?>.*?</script>", " ", text, flags=re.IGNORECASE | re.DOTALL)
    text = re.sub(r"<style.*?>.*?</style>", " ", text, flags=re.IGNORECASE | re.DOTALL)
    text = re.sub(r"<[^>]+>", " ", text)
    return text


UPLOADS_DIR = Path(__file__).resolve().parent.parent.parent / "uploads"
UPLOADS_DIR.mkdir(exist_ok=True)


def ingest_contract(filename: str, content: bytes) -> ContractRecord:
    contract_id = f"ctr_{uuid.uuid4().hex[:10]}"

    # Save raw file for PDF viewer
    contract_dir = UPLOADS_DIR / contract_id
    contract_dir.mkdir(exist_ok=True)
    (contract_dir / filename).write_bytes(content)

    ext = Path(filename).suffix.lower()
    if ext in {".txt", ".md"}:
        text = content.decode("utf-8", errors="ignore")
    elif ext == ".pdf":
        text = _extract_text_from_pdf(content)
    elif ext == ".docx":
        text = _extract_text_from_docx(content)
    elif ext in {".html", ".htm", ".shtml"}:
        text = _extract_text_from_html(content)
    else:
        text = content.decode("utf-8", errors="ignore")

    if not text.strip():
        text = content.decode("utf-8", errors="ignore")

    chunks = split_into_chunks(text)

    from app.services.embeddings import generate_embeddings_batch
    chunk_texts = [c.text for c in chunks]
    embeddings = generate_embeddings_batch(chunk_texts) if chunk_texts else []

    metadata = _extract_metadata(filename, text)
    record = ContractRecord(contract_id=contract_id, filename=filename, chunks=chunks)
    upsert_contract(record, embeddings=embeddings, metadata=metadata)
    return record


def _extract_metadata(filename: str, text: str) -> dict:
    """Extract contract type, counterparty, and agreement date from filename and text."""
    import re
    from datetime import datetime

    fn_lower = filename.lower()
    text_lower = text[:4000].lower()

    # Detect contract type — check filename first, then text. Order: specific before generic.
    type_rules = [
        ("SOW", ["statement of work", "sow-", "sow_"]),
        ("SaaS License", ["saas", "software license", "software-as-a-service", "subscription agreement"]),
        ("MSA", ["master service agreement", "master services agreement", "master supplier agreement", "msa-", "msa_"]),
        ("Vendor Agreement", ["vendor agreement", "vendor-agreement", "vendor services", "supplier agreement"]),
        ("NDA", ["nda", "nda-", "nda_", "non-disclosure", "nondisclosure"]),
        ("Lease", ["lease agreement", "lease-", "tenancy agreement"]),
        ("Employment", ["employment agreement", "employment contract", "offer letter"]),
        ("Purchase Order", ["purchase order", "order form"]),
        ("Loan Agreement", ["loan agreement", "promissory note", "credit agreement"]),
        ("Service Agreement", ["service agreement", "consulting agreement", "professional services"]),
    ]
    contract_type = "Other"
    # Check filename first (more reliable)
    for label, keywords in type_rules:
        if any(kw in fn_lower for kw in keywords):
            contract_type = label
            break
    # If filename didn't match, check text (first 600 chars = title area)
    if contract_type == "Other":
        title_text = text_lower[:600]
        for label, keywords in type_rules:
            if any(kw in title_text for kw in keywords):
                contract_type = label
                break

    # Extract counterparty — look for the second party named
    counterparty = None
    party_patterns = [
        r'(?:and|AND)\s+([A-Z][A-Za-z\s]+(?:Inc|LLC|Ltd|Corp|Corporation|Company|Group|Partners|LLP)[\.,]?)',
        r'(?:Supplier|Vendor|Provider|Consultant|Contractor|Licensor)[:\s\-]+([A-Z][A-Za-z\s]+(?:Inc|LLC|Ltd|Corp|Corporation|Company|Group)[\.,]?)',
        r'"(?:Supplier|Vendor|Provider|Consultant|Contractor)"\)\s*\n?\s*([A-Z][A-Za-z\s]+(?:Inc|LLC|Ltd|Corp|Corporation|Company|Group)[\.,]?)',
        r'(?:between.*?and\s+)([A-Z][A-Za-z\s]+(?:Inc|LLC|Ltd|Corp|Corporation|Company|Group)[\.,]?)',
    ]
    for pat in party_patterns:
        m = re.search(pat, text[:4000])
        if m:
            raw = m.group(1).strip().rstrip(".,")
            if len(raw) > 4 and len(raw) < 60:
                counterparty = raw
                break

    # Extract agreement date
    agreement_date = None
    date_patterns = [
        r'(?:effective\s+date|effective|dated|entered into|as of)[:\s]+(\w+ \d{1,2},?\s*\d{4})',
        r'(?:Effective Date)[:\s]+(\w+ \d{1,2},?\s*\d{4})',
        r'(\d{1,2}/\d{1,2}/\d{4})',
    ]
    for pat in date_patterns:
        m = re.search(pat, text[:4000], re.IGNORECASE)
        if m:
            raw = m.group(1).strip()
            for fmt in ("%B %d, %Y", "%B %d %Y", "%b %d, %Y", "%b %d %Y", "%m/%d/%Y"):
                try:
                    agreement_date = datetime.strptime(raw, fmt).strftime("%Y-%m-%d")
                    break
                except ValueError:
                    continue
            if agreement_date:
                break

    return {
        "contract_type": contract_type,
        "counterparty": counterparty,
        "agreement_date": agreement_date,
        "status": "Under Review",
    }
