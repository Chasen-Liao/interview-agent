from __future__ import annotations

import os
import time
from pathlib import Path

import pytest

from agent.resume_ocr import extract_text

pytestmark = pytest.mark.ocr

if os.environ.get("INTERVIEW_AGENT_RUN_OCR") != "1":
    pytest.skip(
        "set INTERVIEW_AGENT_RUN_OCR=1 to run real OCR integration tests",
        allow_module_level=True,
    )

try:
    import pymupdf as fitz  # type: ignore[import-not-found]
except ModuleNotFoundError:
    pytest.skip("PyMuPDF is required for OCR integration tests", allow_module_level=True)


KEYWORDS = ["OCR", "Python", "Redis", "MySQL", "LLM", "RAG"]


def test_real_ocr_reads_generated_image_and_scanned_pdf(tmp_path: Path):
    image_path, pdf_path = _make_ocr_samples(tmp_path)

    image_text, image_elapsed = _run_ocr(image_path)
    pdf_text, pdf_elapsed = _run_ocr(pdf_path)

    print(f"OCR image elapsed: {image_elapsed:.2f}s")
    print(f"OCR scanned PDF elapsed: {pdf_elapsed:.2f}s")
    assert _missing_keywords(image_text) == []
    assert _missing_keywords(pdf_text) == []
    assert image_elapsed < 60
    assert pdf_elapsed < 90


def _run_ocr(path: Path) -> tuple[str, float]:
    start = time.perf_counter()
    text = extract_text(str(path), max_pages=3)
    return text, time.perf_counter() - start


def _missing_keywords(text: str) -> list[str]:
    compact = "".join(text.lower().split())
    return [keyword for keyword in KEYWORDS if keyword.lower() not in compact]


def _make_ocr_samples(tmp_path: Path) -> tuple[Path, Path]:
    image_path = tmp_path / "resume-image.png"
    pdf_path = tmp_path / "resume-scanned.pdf"
    font_args = _font_args()

    source = fitz.open()
    page = source.new_page(width=900, height=640)
    lines = [
        "中文简历 OCR Resume",
        "Name Daisy",
        "Python Redis MySQL",
        "LLM RAG Agent",
        "Spring Boot API",
    ]
    y = 90
    for line in lines:
        page.insert_text((72, y), line, fontsize=30, **font_args)
        y += 72

    pix = page.get_pixmap(matrix=fitz.Matrix(2, 2), alpha=False)
    image_path.write_bytes(pix.tobytes("png"))
    source.close()

    scanned = fitz.open()
    page = scanned.new_page(width=900, height=640)
    page.insert_image(page.rect, filename=str(image_path))
    scanned.save(pdf_path)
    scanned.close()

    return image_path, pdf_path


def _font_args() -> dict[str, str]:
    candidates = [
        Path(r"C:\Windows\Fonts\msyh.ttc"),
        Path(r"C:\Windows\Fonts\simsun.ttc"),
        Path(r"C:\Windows\Fonts\arial.ttf"),
    ]
    for font in candidates:
        if font.exists():
            return {"fontname": "ocrfont", "fontfile": str(font)}
    return {}
