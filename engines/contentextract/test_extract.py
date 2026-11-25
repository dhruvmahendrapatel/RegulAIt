"""ADR-0362 slice 1: unit tests of the extractor. Run: python3 -I -m unittest discover -s engines/contentextract

Stdlib only. The PDF cases need pypdfium2: they run in the image build (the Dockerfile runs this file with
REGULAIT_REQUIRE_PDFIUM=1, which turns a missing pypdfium2 into a failure) and are skipped, loudly, on a bare
interpreter.
"""

from __future__ import annotations

import io
import json
import os
import sys
import tempfile
import unittest
import zipfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import extract  # noqa: E402

try:
    import pypdfium2  # noqa: F401

    HAVE_PDFIUM = True
except ImportError:
    HAVE_PDFIUM = False
    if os.environ.get("REGULAIT_REQUIRE_PDFIUM") == "1":
        raise

CT = b'<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'
WNS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
ANS = "http://schemas.openxmlformats.org/drawingml/2006/main"
SNS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"


def zip_bytes(entries: dict[str, bytes], method=zipfile.ZIP_DEFLATED) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", method) as zf:
        for name, data in entries.items():
            zf.writestr(name, data)
    return buf.getvalue()


def docx(*paragraphs: str, extra: dict[str, bytes] | None = None) -> bytes:
    body = "".join(f"<w:p><w:r><w:t>{p}</w:t></w:r></w:p>" for p in paragraphs)
    doc = f'<?xml version="1.0"?><w:document xmlns:w="{WNS}"><w:body>{body}</w:body></w:document>'.encode()
    return zip_bytes({"[Content_Types].xml": CT, "word/document.xml": doc, **(extra or {})})


def assemble_pdf(objs: list[bytes]) -> bytes:
    out = io.BytesIO()
    out.write(b"%PDF-1.4\n")
    offsets = []
    for i, body in enumerate(objs, start=1):
        offsets.append(out.tell())
        out.write(b"%d 0 obj\n" % i + body + b"\nendobj\n")
    xref = out.tell()
    out.write(b"xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1))
    for off in offsets:
        out.write(b"%010d 00000 n \n" % off)
    out.write(b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objs) + 1, xref))
    return out.getvalue()


def pdf_with_text(text: str | None, pages: int = 1, font_size: int = 12) -> bytes:
    """A minimal PDF of `pages` identical pages; `None` = no content at all (a blank page)."""
    stream = f"BT /F1 {font_size} Tf 72 700 Td ({text}) Tj ET".encode() if text else b""
    objs = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [%s] /Count %d >>" % (b" ".join(b"3 0 R" for _ in range(pages)), pages),
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
        b"<< /Length %d >>\nstream\n" % len(stream) + stream + b"\nendstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    return assemble_pdf(objs)


def png_chunk(kind: bytes, body: bytes) -> bytes:
    import zlib
    return len(body).to_bytes(4, "big") + kind + body + zlib.crc32(kind + body).to_bytes(4, "big")


def png_header(width: int, height: int) -> bytes:
    """A PNG signature and IHDR only: enough for the header check, which must refuse before any decoder runs."""
    ihdr = width.to_bytes(4, "big") + height.to_bytes(4, "big") + bytes([8, 0, 0, 0, 0])
    return b"\x89PNG\r\n\x1a\n" + png_chunk(b"IHDR", ihdr)


def png_gray(width: int, height: int, pixels: bytes) -> bytes:
    import zlib
    raw = b"".join(b"\x00" + pixels[r * width:(r + 1) * width] for r in range(height))
    return png_header(width, height) + png_chunk(b"IDAT", zlib.compress(raw)) + png_chunk(b"IEND", b"")


def jpeg_header(width: int, height: int) -> bytes:
    sof = b"\xff\xc0" + (17).to_bytes(2, "big") + b"\x08" + height.to_bytes(2, "big") + width.to_bytes(2, "big") + b"\x03" + b"\x01\x11\x00\x02\x11\x01\x03\x11\x01"
    return b"\xff\xd8" + b"\xff\xe0\x00\x10JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00" + sof


class no_tesseract:
    def __enter__(self):
        self.saved = extract.TESSERACT
        extract.TESSERACT = "/nonexistent/tesseract"

    def __exit__(self, *exc):
        extract.TESSERACT = self.saved


HAVE_OCR = extract.ocr_available()
if not HAVE_OCR and os.environ.get("REGULAIT_REQUIRE_OCR") == "1":
    raise RuntimeError("REGULAIT_REQUIRE_OCR=1 but no Tesseract at " + extract.TESSERACT)


def text_page_gray(text: str) -> tuple[int, int, bytes]:
    """A real page of text rendered by PDFium to greyscale pixels (what a scanner produces)."""
    import pypdfium2 as pdfium
    pdf = pdfium.PdfDocument(pdf_with_text(text, font_size=28))
    page = pdf[0]
    bm = page.render(scale=2, grayscale=True)
    w, h, stride, buf = bm.width, bm.height, bm.stride, bytes(bm.buffer)
    bm.close(); page.close(); pdf.close()
    return w, h, b"".join(buf[r * stride:r * stride + w] for r in range(h))


def pdf_with_image(width: int, height: int, gray: bytes) -> bytes:
    """A one-page PDF whose only content is a greyscale image: a scan, with no text layer."""
    import zlib
    img = zlib.compress(gray)
    content = b"q 612 0 0 792 0 0 cm /Im0 Do Q"
    objs = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /XObject << /Im0 5 0 R >> >> >>",
        b"<< /Length %d >>\nstream\n" % len(content) + content + b"\nendstream",
        b"<< /Type /XObject /Subtype /Image /Width %d /Height %d /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length %d >>\nstream\n" % (width, height, len(img)) + img + b"\nendstream",
    ]
    return assemble_pdf(objs)


def run_one(data: bytes, media_type: str = "application/octet-stream", limits: dict | None = None) -> dict:
    req = {"files": [{"id": "f0", "name": "x", "mediaType": media_type, "path": "f0"}]}
    if limits:
        req["limits"] = limits
    return extract.run(req, lambda spec, cap: data)["files"][0]


class OfficeTests(unittest.TestCase):
    def test_docx_text_and_metadata(self):
        core = b'<cp:coreProperties xmlns:cp="x" xmlns:dc="y"><dc:creator>Jane Roe</dc:creator></cp:coreProperties>'
        r = run_one(docx("hello", "card 4111 1111 1111 1111", extra={"docProps/core.xml": core}))
        self.assertEqual(r["status"], "extracted")
        self.assertEqual(r["type"], "docx")
        self.assertIn("card 4111 1111 1111 1111", r["text"])
        self.assertIn("Jane Roe", r["text"])

    def test_docx_header_footer_comments(self):
        hdr = f'<w:hdr xmlns:w="{WNS}"><w:p><w:r><w:t>secret header</w:t></w:r></w:p></w:hdr>'.encode()
        r = run_one(docx("body", extra={"word/header1.xml": hdr}))
        self.assertIn("secret header", r["text"])

    def test_xlsx_shared_inline_and_numbers(self):
        shared = f'<sst xmlns="{SNS}"><si><t>alice@example.com</t></si></sst>'.encode()
        sheet = (
            f'<worksheet xmlns="{SNS}"><sheetData><row>'
            '<c t="s"><v>0</v></c><c><v>4111111111111111</v></c><c t="inlineStr"><is><t>inline</t></is></c>'
            "</row></sheetData></worksheet>"
        ).encode()
        data = zip_bytes(
            {"[Content_Types].xml": CT, "xl/workbook.xml": b"<workbook/>", "xl/sharedStrings.xml": shared,
             "xl/worksheets/sheet1.xml": sheet}
        )
        r = run_one(data, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
        self.assertEqual(r["type"], "xlsx")
        for want in ("alice@example.com", "4111111111111111", "inline"):
            self.assertIn(want, r["text"])
        self.assertNotIn("\n0\n", "\n" + r["text"] + "\n")  # the shared-string index is not text

    def test_pptx_slides_and_notes(self):
        slide = f'<p:sld xmlns:p="p" xmlns:a="{ANS}"><a:p><a:r><a:t>slide text</a:t></a:r></a:p></p:sld>'.encode()
        note = f'<p:notes xmlns:p="p" xmlns:a="{ANS}"><a:p><a:r><a:t>speaker note</a:t></a:r></a:p></p:notes>'.encode()
        data = zip_bytes(
            {"[Content_Types].xml": CT, "ppt/presentation.xml": b"<p/>", "ppt/slides/slide1.xml": slide,
             "ppt/notesSlides/notesSlide1.xml": note}
        )
        r = run_one(data)
        self.assertEqual(r["type"], "pptx")
        self.assertIn("slide text", r["text"])
        self.assertIn("speaker note", r["text"])

    def test_doctype_and_entities_refused(self):
        bomb = (
            b'<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;">]>'
            b'<w:document xmlns:w="' + WNS.encode() + b'"><w:body>&lol2;</w:body></w:document>'
        )
        data = zip_bytes({"[Content_Types].xml": CT, "word/document.xml": bomb})
        self.assertEqual(run_one(data)["reason"], "malformed")

    def test_dtd_hidden_by_utf16_refused(self):
        # review R-1 (#967): a UTF-16 part carries no ASCII "<!doctype"/"<!entity" bytes; the parser-level check
        # must still refuse it, with and without a BOM, little- and big-endian
        body = ('<?xml version="1.0" encoding="UTF-16"?><!DOCTYPE r [<!ENTITY e "INJECTED">]>'
                f'<w:document xmlns:w="{WNS}"><w:body><w:p><w:r><w:t>&e;</w:t></w:r></w:p></w:body></w:document>')
        for enc in ("utf-16", "utf-16-le", "utf-16-be"):
            part = body.encode(enc)
            self.assertNotIn(b"<!doctype", part.lower())
            data = zip_bytes({"[Content_Types].xml": CT, "word/document.xml": part})
            r = run_one(data)
            self.assertEqual((r["status"], r.get("reason")), ("refused", "malformed"), enc)
            self.assertNotIn("text", r)

    def test_utf16_part_without_dtd_still_reads(self):
        body = f'<?xml version="1.0" encoding="UTF-16"?><w:document xmlns:w="{WNS}"><w:body><w:p><w:r><w:t>wide text</w:t></w:r></w:p></w:body></w:document>'
        data = zip_bytes({"[Content_Types].xml": CT, "word/document.xml": body.encode("utf-16")})
        self.assertIn("wide text", run_one(data)["text"])

    def test_external_entity_refused(self):
        xml = b'<?xml version="1.0"?><!DOCTYPE r SYSTEM "http://example.invalid/x.dtd"><r/>'
        with self.assertRaises(extract.Refused) as e:
            extract.refuse_dtd(xml)
        self.assertEqual(e.exception.reason, "malformed")

    def test_broken_xml_refused(self):
        data = zip_bytes({"[Content_Types].xml": CT, "word/document.xml": b"<w:document"})
        self.assertEqual(run_one(data)["reason"], "malformed")


class ArchiveTests(unittest.TestCase):
    def test_zip_recurses_into_entries(self):
        data = zip_bytes({"a.txt": b"plain one", "b.docx": docx("nested docx")})
        r = run_one(data, "application/zip")
        self.assertEqual(r["status"], "extracted")
        self.assertIn("plain one", r["text"])
        self.assertIn("nested docx", r["text"])

    def test_compression_ratio_bomb_refused(self):
        data = zip_bytes({"zeros.txt": b"a" * (4 * 1024 * 1024)})
        self.assertEqual(run_one(data)["reason"], "ratio_limit")

    def test_depth_limit(self):
        inner = zip_bytes({"t.txt": b"deep"})
        for _ in range(3):
            inner = zip_bytes({"n.zip": inner}, zipfile.ZIP_STORED)
        self.assertEqual(run_one(inner)["reason"], "depth_limit")

    def test_entry_count_limit(self):
        data = zip_bytes({f"{i}.txt": b"x%d" % i for i in range(20)}, zipfile.ZIP_STORED)
        self.assertEqual(run_one(data, limits={"maxArchiveEntries": 10})["reason"], "archive_limit")

    def test_total_bytes_limit(self):
        data = zip_bytes({f"{i}.txt": os.urandom(4000).hex().encode() for i in range(5)}, zipfile.ZIP_STORED)
        self.assertEqual(run_one(data, limits={"maxArchiveTotalBytes": 20000})["reason"], "archive_limit")

    def test_lying_header_size_is_bounded(self):
        # a header that claims a small size; the real read stops one byte past the cap whatever the header says
        data = zip_bytes({"big.txt": os.urandom(50000).hex().encode()}, zipfile.ZIP_STORED)
        self.assertEqual(run_one(data, limits={"maxEntryBytes": 1000})["reason"], "too_large")

    def test_encrypted_entry_refused(self):
        data = bytearray(zip_bytes({"a.txt": b"hello"}, zipfile.ZIP_STORED))
        # set the "encrypted" general-purpose bit in the local header and the central directory entry
        data[6] |= 1
        cd = data.rfind(b"PK\x01\x02")
        data[cd + 8] |= 1
        self.assertEqual(run_one(bytes(data))["reason"], "encrypted")

    def test_corrupt_zip_refused(self):
        self.assertEqual(run_one(b"PK\x03\x04garbage")["reason"], "malformed")


class TypeAndLimitTests(unittest.TestCase):
    def test_csv_and_text(self):
        r = run_one("﻿name,email\nbob,bob@example.com\n".encode(), "text/csv")
        self.assertEqual((r["status"], r["type"]), ("extracted", "text"))
        self.assertIn("bob@example.com", r["text"])

    def test_unknown_binary_refused(self):
        self.assertEqual(run_one(b"\x00\x01\x02\xffbinary")["reason"], "unknown_type")

    def test_invalid_utf8_refused(self):
        self.assertEqual(run_one(b"caf\xe9 latin-1", "text/plain")["reason"], "type_mismatch")
        self.assertEqual(run_one(b"caf\xe9 latin-1")["reason"], "unknown_type")

    def test_declared_pdf_that_is_a_zip(self):
        self.assertEqual(run_one(docx("x"), "application/pdf")["reason"], "type_mismatch")

    def test_declared_docx_that_is_an_xlsx(self):
        data = zip_bytes({"[Content_Types].xml": CT, "xl/workbook.xml": b"<w/>"})
        mt = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        self.assertEqual(run_one(data, mt)["reason"], "type_mismatch")

    def test_image_without_ocr_engine_needs_ocr(self):
        with no_tesseract():
            self.assertEqual(run_one(png_gray(4, 4, b"\xff" * 16), "image/png")["reason"], "needs_ocr")

    def test_image_header_checked_before_ocr(self):
        self.assertEqual(run_one(b"\x89PNG\r\n\x1a\n" + b"\x00" * 20, "image/png")["reason"], "malformed")
        self.assertEqual(run_one(png_header(50_000, 50_000), "image/png")["reason"], "too_large")
        self.assertEqual(run_one(png_header(10_000, 5_000), "image/png")["reason"], "too_large")  # 50 MP
        self.assertEqual(run_one(b"\xff\xd8\xff\xe0\x00", "image/jpeg")["reason"], "malformed")
        self.assertEqual(run_one(jpeg_header(30_000, 10), "image/jpeg")["reason"], "too_large")
        self.assertEqual(extract.image_size(jpeg_header(640, 480)), (640, 480))

    def test_file_size_limit(self):
        self.assertEqual(run_one(b"a" * 2000, limits={"maxFileBytes": 1000})["reason"], "too_large")

    def test_text_limit_across_files(self):
        req = {"limits": {"maxTextChars": 1500},
               "files": [{"id": "a", "path": "a"}, {"id": "b", "path": "b"}]}
        res = extract.run(req, lambda spec, cap: b"y" * 1000)["files"]
        self.assertEqual(res[0]["status"], "extracted")
        self.assertEqual(res[1]["reason"], "text_limit")

    def test_limits_can_only_tighten(self):
        lim = extract.merge_limits({"maxPages": 10_000, "maxTextChars": 5, "deadlineMs": True, "nope": 1})
        self.assertEqual(lim["maxPages"], extract.HARD_LIMITS["maxPages"])
        self.assertEqual(lim["maxTextChars"], 5)
        self.assertEqual(lim["deadlineMs"], extract.HARD_LIMITS["deadlineMs"])
        self.assertNotIn("nope", lim)

    def test_deadline(self):
        data = zip_bytes({f"{i}.txt": b"x" for i in range(50)}, zipfile.ZIP_STORED)
        b = extract.Budget(extract.merge_limits({"deadlineMs": 1}))
        b.deadline = 0  # already past
        r = extract.extract_file({"id": "z"}, data, extract.merge_limits(None), b)
        self.assertEqual(r["reason"], "timeout")

    def test_every_reason_is_declared(self):
        with self.assertRaises(AssertionError):
            extract.Refused("not_a_reason")

    def test_entry_names_are_sanitised(self):
        data = zip_bytes({"a‮\nb.txt": b"text"})
        self.assertIn("----- a__b.txt -----", run_one(data)["text"])


class MainTests(unittest.TestCase):
    def test_cli_bundle(self):
        import base64
        with tempfile.TemporaryDirectory() as d:
            req = {"files": [{"id": "ok", "dataBase64": base64.b64encode(b"hello file").decode()},
                             {"id": "bad-b64", "dataBase64": "@@@@"},
                             {"id": "no-data"}]}
            src = os.path.join(d, "bundle.json")
            with open(src, "w") as fh:
                json.dump(req, fh)
            out = os.path.join(d, "result.json")
            self.assertEqual(extract.main(["extract.py", src, out]), 0)
            with open(out) as fh:
                res = json.load(fh)
            self.assertEqual(res["version"], 1)
            self.assertEqual(res["files"][0]["text"], "hello file")
            for i in (1, 2):
                self.assertEqual(res["files"][i]["reason"], "malformed")
            self.assertFalse(os.path.exists(out + ".tmp"))

    def test_inline_size_bounded_before_decoding(self):
        import base64
        with self.assertRaises(extract.Refused) as e:
            extract.read_inline({"dataBase64": base64.b64encode(b"x" * 3000).decode()}, 1000)
        self.assertEqual(e.exception.reason, "too_large")

    def test_bad_bundle(self):
        with tempfile.TemporaryDirectory() as d:
            src = os.path.join(d, "bundle.json")
            with open(src, "w") as fh:
                fh.write("[]")
            self.assertEqual(extract.main(["extract.py", src, os.path.join(d, "r.json")]), 3)


@unittest.skipUnless(HAVE_PDFIUM, "pypdfium2 is not installed here; the image build runs these")
class PdfTests(unittest.TestCase):
    def test_pdf_text(self):
        r = run_one(pdf_with_text("SSN 123-45-6789"), "application/pdf")
        self.assertEqual((r["status"], r["type"], r["pages"], r["scannedPages"]), ("extracted", "pdf", 1, 0))
        self.assertIn("123-45-6789", r["text"])

    def test_scanned_pdf_without_ocr_engine_needs_ocr(self):
        with no_tesseract():
            self.assertEqual(run_one(pdf_with_text(None))["reason"], "needs_ocr")

    def test_page_limit(self):
        self.assertEqual(run_one(pdf_with_text("x", 3), limits={"maxPages": 3})["status"], "extracted")
        self.assertEqual(run_one(pdf_with_text("x", 3), limits={"maxPages": 2})["reason"], "page_limit")

    def test_corrupt_pdf(self):
        self.assertEqual(run_one(b"%PDF-1.4\nnot really")["reason"], "malformed")


@unittest.skipUnless(HAVE_PDFIUM and HAVE_OCR, "pypdfium2 and Tesseract are not both installed here; the image build runs these")
class OcrTests(unittest.TestCase):
    PHRASE = "Account 4111 1111 1111 1111"

    def test_image_ocr(self):
        w, h, gray = text_page_gray(self.PHRASE)
        r = run_one(png_gray(w, h, gray), "image/png")
        self.assertEqual((r["status"], r["type"]), ("extracted", "image"))
        self.assertIn("4111 1111 1111 1111", r["text"])

    def test_scanned_pdf_ocr(self):
        w, h, gray = text_page_gray(self.PHRASE)
        r = run_one(pdf_with_image(w, h, gray), "application/pdf")
        self.assertEqual((r["status"], r["pages"], r["scannedPages"]), ("extracted", 1, 1))
        self.assertIn("4111 1111 1111 1111", r["text"])

    def test_blank_page_is_read_not_refused(self):
        r = run_one(pdf_with_text(None))
        self.assertEqual((r["status"], r["scannedPages"]), ("extracted", 1))

    def test_ocr_page_cap_across_files(self):
        img = png_gray(8, 8, b"\xff" * 64)
        files = [{"id": f"i{n}", "path": "x"} for n in range(extract.OCR_LIMITS["maxOcrPages"] + 1)]
        res = extract.run({"files": files}, lambda spec, cap: img)["files"]
        self.assertTrue(all(f["status"] == "extracted" for f in res[:-1]))
        self.assertEqual(res[-1]["reason"], "page_limit")

    def test_ocr_respects_the_deadline(self):
        b = extract.Budget(extract.merge_limits(None))
        b.deadline = 0
        with self.assertRaises(extract.Refused) as e:
            extract.ocr_image(png_gray(8, 8, b"\xff" * 64), b)
        self.assertEqual(e.exception.reason, "timeout")

    def test_corrupt_image_body(self):
        bad = png_header(8, 8) + png_chunk(b"IDAT", b"not zlib") + png_chunk(b"IEND", b"")
        self.assertEqual(run_one(bad, "image/png")["reason"], "malformed")


if __name__ == "__main__":
    unittest.main()
