"""扫描版 PDF / 图片简历 OCR 入口。

Extension Host 在普通 PDF 文字层为空或用户上传图片简历时调用本脚本。
依赖缺失时输出清晰错误，让前端提示用户先安装 OCR 可选依赖。
"""

from __future__ import annotations

import re
import sys
from pathlib import Path
from typing import Any

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")


IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp"}
PDF_EXTENSIONS = {".pdf"}
SUPPORTED_EXTENSIONS = PDF_EXTENSIONS | IMAGE_EXTENSIONS


def _load_dependencies():
    """延迟加载 OCR 依赖，避免普通 Agent 启动时被重依赖拖慢。"""
    missing: list[str] = []
    try:
        import pymupdf as fitz  # type: ignore[import-not-found]
    except ModuleNotFoundError:
        try:
            import fitz  # type: ignore[import-not-found,no-redef]
        except ModuleNotFoundError:
            fitz = None
            missing.append("PyMuPDF")
    try:
        import numpy as np  # type: ignore[import-not-found]
    except ModuleNotFoundError:
        np = None
        missing.append("numpy")
    RapidOCR = None
    try:
        from rapidocr import RapidOCR  # type: ignore[import-not-found,no-redef]
    except ModuleNotFoundError:
        try:
            from rapidocr_onnxruntime import RapidOCR  # type: ignore[import-not-found,no-redef]
        except ModuleNotFoundError:
            missing.append("rapidocr + onnxruntime")

    if missing:
        raise RuntimeError(
            "OCR 依赖未安装："
            + ", ".join(missing)
            + "。请点击“安装 OCR 依赖”后重试。"
        )
    return fitz, np, RapidOCR


def extract_text(file_path: str, max_pages: int = 5) -> str:
    """从扫描版 PDF 或图片提取文字，PDF 最多识别前 max_pages 页。"""
    path = Path(file_path)
    ext = path.suffix.lower()
    if ext not in SUPPORTED_EXTENSIONS:
        raise ValueError("当前 OCR 只支持 .pdf、.png、.jpg、.jpeg、.webp 文件。")

    fitz, np, RapidOCR = _load_dependencies()
    engine = RapidOCR()
    parts: list[str] = []

    if ext in IMAGE_EXTENSIONS:
        return _normalize_text(_extract_result_text(engine(str(path))))

    with fitz.open(file_path) as doc:
        for page_index in range(min(max_pages, len(doc))):
            page = doc[page_index]
            pix = page.get_pixmap(matrix=fitz.Matrix(2.5, 2.5), alpha=False)
            image = np.frombuffer(pix.samples, dtype=np.uint8).reshape(
                pix.height,
                pix.width,
                pix.n,
            )
            parts.extend(_extract_result_text(engine(image)).splitlines())

    return _normalize_text("\n".join(parts))


def _extract_result_text(result: Any) -> str:
    """兼容 RapidOCR 新版输出对象和旧版 tuple/list 输出。"""
    if result is None:
        return ""

    txts = getattr(result, "txts", None)
    if txts is not None:
        return _normalize_text("\n".join(str(text) for text in txts if text))

    if isinstance(result, tuple):
        result = result[0] if result else []

    parts: list[str] = []
    for item in result or []:
        if isinstance(item, str):
            parts.append(item)
        elif isinstance(item, (list, tuple)) and len(item) >= 2 and item[1]:
            parts.append(str(item[1]))
    return _normalize_text("\n".join(parts))


def _normalize_text(text: str) -> str:
    """清理 OCR 文本中的重复空白，保留换行用于简历上下文分段。"""
    lines = []
    for line in text.splitlines():
        normalized = re.sub(r"[ \t]+", " ", line).strip()
        if normalized:
            lines.append(normalized)
    return "\n".join(lines).strip()


def main(argv: list[str] | None = None) -> int:
    """命令行入口：stdout 输出识别文本，stderr 输出错误。"""
    argv = sys.argv[1:] if argv is None else argv
    if not argv:
        sys.stderr.write("缺少 PDF 文件路径\n")
        return 2
    try:
        text = extract_text(argv[0])
    except Exception as e:
        sys.stderr.write(str(e) + "\n")
        return 1
    sys.stdout.write(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
