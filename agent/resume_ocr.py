"""扫描版 PDF 简历 OCR 入口。

Extension Host 在普通 PDF 文字层为空时调用本脚本。依赖缺失时输出清晰错误，
让前端提示用户先安装 Agent 依赖。
"""

from __future__ import annotations

import sys

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")


def _load_dependencies():
    """延迟加载 OCR 依赖，避免普通 Agent 启动时被重依赖拖慢。"""
    missing: list[str] = []
    try:
        import fitz  # type: ignore[import-not-found]
    except ModuleNotFoundError:
        fitz = None
        missing.append("PyMuPDF")
    try:
        import numpy as np  # type: ignore[import-not-found]
    except ModuleNotFoundError:
        np = None
        missing.append("numpy")
    try:
        from rapidocr_onnxruntime import RapidOCR  # type: ignore[import-not-found]
    except ModuleNotFoundError:
        RapidOCR = None
        missing.append("rapidocr-onnxruntime")

    if missing:
        raise RuntimeError(
            "OCR 依赖未安装："
            + ", ".join(missing)
            + "。请点击“安装 Agent 依赖”后重试。"
        )
    return fitz, np, RapidOCR


def extract_text(pdf_path: str, max_pages: int = 5) -> str:
    """从扫描版 PDF 提取文字，最多识别前 max_pages 页。"""
    fitz, np, RapidOCR = _load_dependencies()
    engine = RapidOCR()
    parts: list[str] = []

    with fitz.open(pdf_path) as doc:
        for page_index in range(min(max_pages, len(doc))):
            page = doc[page_index]
            pix = page.get_pixmap(matrix=fitz.Matrix(2, 2), alpha=False)
            image = np.frombuffer(pix.samples, dtype=np.uint8).reshape(
                pix.height,
                pix.width,
                pix.n,
            )
            result, _ = engine(image)
            if not result:
                continue
            for item in result:
                if len(item) >= 2 and item[1]:
                    parts.append(str(item[1]))

    return "\n".join(parts).strip()


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
