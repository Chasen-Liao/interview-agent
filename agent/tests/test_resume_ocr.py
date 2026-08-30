from pathlib import Path

import pytest

from agent import resume_ocr


class FakeRapidOCR:
    def __call__(self, image):
        self.image = image
        return FakeRapidOCROutput()


class FakeRapidOCROutput:
    txts = [" Daisy OCR Resume ", "Python   Redis", "", "MySQL"]


def test_extract_result_text_supports_new_rapidocr_output():
    text = resume_ocr._extract_result_text(FakeRapidOCROutput())

    assert text == "Daisy OCR Resume\nPython Redis\nMySQL"


def test_extract_result_text_supports_old_rapidocr_tuple():
    text = resume_ocr._extract_result_text((
        [
            [[[0, 0]], "OCR Resume", 0.99],
            [[[0, 20]], "Redis  MySQL", 0.98],
        ],
        0.12,
    ))

    assert text == "OCR Resume\nRedis MySQL"


def test_extract_text_rejects_unsupported_format(tmp_path: Path):
    file_path = tmp_path / "resume.xlsx"
    file_path.write_text("not supported", encoding="utf-8")

    with pytest.raises(ValueError, match="当前 OCR 只支持"):
        resume_ocr.extract_text(str(file_path))


def test_extract_text_reads_image_path(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    image_path = tmp_path / "resume.png"
    image_path.write_bytes(b"fake")

    monkeypatch.setattr(
        resume_ocr,
        "_load_dependencies",
        lambda: (object(), object(), FakeRapidOCR),
    )

    assert resume_ocr.extract_text(str(image_path)) == "Daisy OCR Resume\nPython Redis\nMySQL"
