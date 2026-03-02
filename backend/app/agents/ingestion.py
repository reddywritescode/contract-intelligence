"""Ingestion Agent — handles PDF, DOCX, HTML, TXT, and OCR extraction.

Uses hybrid section detection: embedding-based semantic boundary detection
combined with regex structural headers, with regex-only fallback when
embeddings are unavailable.
"""
from __future__ import annotations

import re
import uuid
from io import BytesIO
from pathlib import Path
from typing import Optional

from app.agents.base import BaseAgent, ChunkState, ContractState


class IngestionAgent(BaseAgent):
    name = "IngestionAgent"
    role = "Document ingestion specialist — extracts text from PDF, DOCX, HTML, TXT with OCR fallback for scanned documents"
    system_prompt = ""  # no LLM call needed
    tools = ["pypdf", "python-docx", "pytesseract", "pdf2image"]

    def execute(self, state: ContractState) -> ContractState:
        raise NotImplementedError("Use ingest() directly with file content")

    def ingest(self, filename: str, content: bytes, contract_id: Optional[str] = None) -> ContractState:
        """Full ingestion pipeline: extract → chunk → embed → persist."""
        state = ContractState(
            contract_id=contract_id or f"ctr_{uuid.uuid4().hex[:10]}",
            filename=filename,
        )
        trace = self._start_trace(state, ["filename", "content_bytes"])

        ext = Path(filename).suffix.lower()

        # 1. Extract text
        text = ""
        method = "txt"
        ocr_used = False

        try:
            if ext == ".pdf":
                text = self._extract_pdf(content)
                method = "pdf"
                if not text.strip() or self._looks_like_scanned(text):
                    ocr_text = self._extract_ocr(content)
                    if ocr_text.strip():
                        text = ocr_text
                        method = "ocr"
                        ocr_used = True
            elif ext == ".docx":
                text = self._extract_docx(content)
                method = "docx"
            elif ext in {".html", ".htm", ".shtml"}:
                text = self._extract_html(content)
                method = "html"
            else:
                text = content.decode("utf-8", errors="ignore")
                method = "txt"

            if not text.strip():
                text = content.decode("utf-8", errors="ignore")
        except Exception as exc:
            self._fail_trace(trace, str(exc))
            raise

        state.raw_text = text
        state.extraction_method = method
        state.ocr_used = ocr_used

        # 2. Chunk
        chunks = self._split_into_chunks(text)
        state.chunks = chunks

        # 3. Extract metadata
        state.metadata = self._extract_metadata(filename, text)

        # 4. Generate embeddings
        embed_count = 0
        try:
            from app.services.embeddings import generate_embeddings_batch
            chunk_texts = [c.text for c in chunks]
            embeddings = generate_embeddings_batch(chunk_texts) if chunk_texts else []
            embed_count = len(embeddings)
            for i, c in enumerate(chunks):
                if i < len(embeddings):
                    c.embedding_generated = True
        except Exception:
            embeddings = []

        # 5. Persist
        from app.models.schemas import ContractChunk, ContractRecord
        from app.services.repository import upsert_contract

        record_chunks = [
            ContractChunk(chunk_id=c.chunk_id, text=c.text, section=c.section, page=c.page)
            for c in chunks
        ]
        record = ContractRecord(contract_id=state.contract_id, filename=filename, chunks=record_chunks)
        upsert_contract(record, embeddings=embeddings, metadata=state.metadata)

        # 6. Save raw file
        from app.services.ingestion import UPLOADS_DIR
        contract_dir = UPLOADS_DIR / state.contract_id
        contract_dir.mkdir(exist_ok=True)
        (contract_dir / filename).write_bytes(content)

        self._complete_trace(trace, ["raw_text", "chunks", "metadata", "extraction_method"], {
            "extraction_method": method,
            "ocr_used": ocr_used,
            "chunk_count": len(chunks),
            "text_length": len(text),
            "embeddings_generated": embed_count,
            "metadata": state.metadata,
        })

        return state

    # ── Extractors ──

    @staticmethod
    def _extract_pdf(content: bytes) -> str:
        try:
            from pypdf import PdfReader
        except ImportError:
            return ""
        reader = PdfReader(BytesIO(content))
        return "\n".join(page.extract_text() or "" for page in reader.pages)

    @staticmethod
    def _extract_docx(content: bytes) -> str:
        try:
            from docx import Document
        except ImportError:
            return ""
        doc = Document(BytesIO(content))
        return "\n".join(p.text for p in doc.paragraphs if p.text)

    @staticmethod
    def _extract_html(content: bytes) -> str:
        text = content.decode("utf-8", errors="ignore")
        text = re.sub(r"<script.*?>.*?</script>", " ", text, flags=re.IGNORECASE | re.DOTALL)
        text = re.sub(r"<style.*?>.*?</style>", " ", text, flags=re.IGNORECASE | re.DOTALL)
        text = re.sub(r"<[^>]+>", " ", text)
        return text

    @staticmethod
    def _extract_ocr(content: bytes) -> str:
        """OCR fallback for scanned PDFs using pytesseract + pdf2image."""
        try:
            from pdf2image import convert_from_bytes
            import pytesseract
        except ImportError:
            return ""

        try:
            images = convert_from_bytes(content, dpi=300)
            pages = []
            for img in images:
                text = pytesseract.image_to_string(img, lang="eng")
                pages.append(text)
            return "\n".join(pages)
        except Exception:
            return ""

    @staticmethod
    def _looks_like_scanned(text: str) -> bool:
        """Heuristic: if extracted text is very short relative to expected content,
        it's likely a scanned PDF that needs OCR."""
        stripped = text.strip()
        if len(stripped) < 50:
            return True
        alpha_ratio = sum(1 for c in stripped if c.isalpha()) / max(len(stripped), 1)
        return alpha_ratio < 0.3

    # ── Chunking (delegates to service hybrid detection) ──

    def _split_into_chunks(self, text: str) -> list[ChunkState]:
        """Split text using hybrid semantic + regex section detection.

        Delegates to the service layer which combines embedding-based
        topic-shift detection with regex structural headers.
        """
        from app.services.ingestion import split_into_chunks

        contract_chunks = split_into_chunks(text)
        return [
            ChunkState(chunk_id=c.chunk_id, text=c.text, section=c.section, page=c.page)
            for c in contract_chunks
        ]

    # ── Metadata extraction ──

    @staticmethod
    def _extract_metadata(filename: str, text: str) -> dict:
        from app.services.ingestion import _extract_metadata
        return _extract_metadata(filename, text)
