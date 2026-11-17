"""ADR-0362 slice 1: the content-extraction task, run ONLY inside the engine sandbox (ADR-0190 I5).

It turns the files and attachments of one gateway request or response into plain text, so the gateway can run
its existing PII detection and guardrails (ADR-0140, ADR-0042) on that text with their usual outcomes. It never
decides anything itself: every file ends either `extracted` (with its text) or `refused` (with one reason from
REFUSAL_REASONS), and the gateway fails closed on `refused` unless an admin relaxed that, audited.

    python3 -I extract.py <bundle.json> <result.json>

bundle.json:   {"limits": {...optional, can only TIGHTEN the baked caps...},
                "files": [{"id": "a0", "name": "report.pdf", "mediaType": "application/pdf", "dataBase64": "..."}]}
               one file, written by the gateway as the run's subject (the sandbox input holds nothing else)
result.json:   {"version": 1, "files": [{"id", "status", "type", "reason"?, "text"?, "pages"?, "entries"?,
                "scannedPages"?}]}

What it reads, and with what:
  - PDF: pypdfium2 (Apache-2.0 / BSD-3-Clause; PDFium, the PDF engine Chrome ships). Text per page. A page with
    no text layer is counted in `scannedPages`; a PDF with no text at all is refused `needs_ocr` until the OCR
    slice (ADR-0362 slice 2) reads it.
  - DOCX, XLSX, PPTX: the Python standard library only (zipfile + xml.etree). Office Open XML is a zip of XML
    parts; no maintained, permissively licensed reader beats reading the parts directly (ADR-0362 comparison).
    A part that declares a DOCTYPE or an ENTITY is refused `malformed`: OOXML never needs one, so refusing it
    closes entity-expansion bombs and external entities whatever the expat version.
  - CSV and plain text: strict UTF-8 (BOM allowed), no NUL bytes.
  - ZIP archives: the standard library, each entry detected and read recursively, bounded by entry count,
    nesting depth, total and per-entry uncompressed bytes and the compression ratio. Sizes in headers are never
    trusted: every read stops one byte past its limit.
  - Images: refused `needs_ocr` until the OCR slice.

The type is decided from the bytes (magic numbers), never from the declared name or media type. A declared media
type of a different family is refused `type_mismatch`. Anything else is `unknown_type`.

Every limit is enforced here AND by the sandbox (wall time, memory, no network). The defaults below are the hard
caps; a request may only lower them.
"""

from __future__ import annotations

import base64
import io
import json
import os
import re
import sys
import time
import zipfile
import xml.etree.ElementTree as ET

RESULT_VERSION = 1
# the engine version the manifest pins (CONTENTEXTRACT_ENGINE_VERSION); the runner shim reads it from this file
EXTRACTOR_VERSION = "0.1.0"

# the hard caps; ADR-0362 "Limits". A request's `limits` may lower each one, never raise it.
HARD_LIMITS = {
    "maxFileBytes": 16 * 1024 * 1024,  # one input file
    "maxPages": 200,  # one PDF
    "maxTextChars": 2_000_000,  # all text this request returns, across files
    "maxArchiveEntries": 256,  # entries across one archive tree (OOXML parts count)
    "maxArchiveDepth": 2,  # archive inside archive inside archive: refused
    "maxArchiveTotalBytes": 64 * 1024 * 1024,  # uncompressed bytes read across one archive tree
    "maxEntryBytes": 16 * 1024 * 1024,  # one uncompressed entry
    "maxCompressionRatio": 100,  # uncompressed / compressed, per entry
    "deadlineMs": 20_000,  # this whole request
}

REFUSAL_REASONS = (
    "unknown_type",
    "type_mismatch",
    "too_large",
    "page_limit",
    "text_limit",
    "archive_limit",
    "depth_limit",
    "ratio_limit",
    "encrypted",
    "malformed",
    "timeout",
    "needs_ocr",
)

# declared media type -> the family it must be. A declared type not listed here is not checked (browsers send
# application/octet-stream for much); the bytes decide.
DECLARED_FAMILY = {
    "application/pdf": "pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
    "application/zip": "zip",
    "application/x-zip-compressed": "zip",
    "text/csv": "text",
    "text/plain": "text",
    "image/png": "image",
    "image/jpeg": "image",
}
# families a declared type may legitimately resolve to (an .xlsx is a zip; a .csv is text)
COMPATIBLE = {"zip": {"zip", "docx", "xlsx", "pptx"}}


class Refused(Exception):
    def __init__(self, reason: str):
        assert reason in REFUSAL_REASONS, reason
        super().__init__(reason)
        self.reason = reason


class Budget:
    """The request-wide counters: text returned, wall clock."""

    def __init__(self, limits: dict):
        self.limits = limits
        self.chars = 0
        self.deadline = time.monotonic() + limits["deadlineMs"] / 1000.0

    def tick(self) -> None:
        if time.monotonic() > self.deadline:
            raise Refused("timeout")

    def take(self, text: str) -> str:
        self.chars += len(text)
        if self.chars > self.limits["maxTextChars"]:
            raise Refused("text_limit")
        return text


class ArchiveBudget:
    """The counters of one archive tree (a zip, or an OOXML package, and everything nested in it)."""

    def __init__(self) -> None:
        self.entries = 0
        self.bytes = 0


def merge_limits(requested: object) -> dict:
    limits = dict(HARD_LIMITS)
    if isinstance(requested, dict):
        for key, cap in HARD_LIMITS.items():
            value = requested.get(key)
            # bool is an int subclass; refuse it like any other non-integer
            if isinstance(value, int) and not isinstance(value, bool) and 0 < value < cap:
                limits[key] = value
    return limits


# ---- type detection ----------------------------------------------------------------------------------------


def sniff(data: bytes) -> str:
    if data.startswith(b"%PDF-"):
        return "pdf"
    if data.startswith(b"PK\x03\x04") or data.startswith(b"PK\x05\x06"):
        return "zip"  # refined to docx/xlsx/pptx once opened
    if data.startswith(b"\x89PNG\r\n\x1a\n") or data.startswith(b"\xff\xd8\xff"):
        return "image"
    if looks_like_text(data):
        return "text"
    return "unknown"


def looks_like_text(data: bytes) -> bool:
    if b"\x00" in data:
        return False
    try:
        decode_text(data)
    except UnicodeDecodeError:
        return False
    return True


def decode_text(data: bytes) -> str:
    return data.decode("utf-8-sig", errors="strict")


def ooxml_kind(zf: zipfile.ZipFile) -> str | None:
    names = set(zf.namelist())
    if "[Content_Types].xml" not in names:
        return None
    if "word/document.xml" in names:
        return "docx"
    if "xl/workbook.xml" in names:
        return "xlsx"
    if "ppt/presentation.xml" in names:
        return "pptx"
    return None


# ---- zip ---------------------------------------------------------------------------------------------------


def open_zip(data: bytes) -> zipfile.ZipFile:
    try:
        return zipfile.ZipFile(io.BytesIO(data))
    except (zipfile.BadZipFile, ValueError, EOFError):
        raise Refused("malformed")


def read_entry(zf: zipfile.ZipFile, info: zipfile.ZipInfo, limits: dict, arch: ArchiveBudget, budget: Budget) -> bytes:
    budget.tick()
    arch.entries += 1
    if arch.entries > limits["maxArchiveEntries"]:
        raise Refused("archive_limit")
    if info.flag_bits & 0x1:
        raise Refused("encrypted")
    # header sizes are claims, not facts: check them early, then bound the real read anyway
    if info.file_size > limits["maxEntryBytes"]:
        raise Refused("too_large")
    if info.file_size > 0 and info.file_size / max(info.compress_size, 1) > limits["maxCompressionRatio"]:
        raise Refused("ratio_limit")
    cap = min(limits["maxEntryBytes"], limits["maxArchiveTotalBytes"] - arch.bytes)
    try:
        with zf.open(info) as fh:
            out = fh.read(cap + 1)
    except (zipfile.BadZipFile, ValueError, EOFError, NotImplementedError, OSError):
        raise Refused("malformed")
    except RuntimeError:  # zipfile raises RuntimeError for an encrypted member read without a password
        raise Refused("encrypted")
    if len(out) > cap:
        raise Refused("too_large" if len(out) > limits["maxEntryBytes"] else "archive_limit")
    if len(out) > 0 and len(out) / max(info.compress_size, 1) > limits["maxCompressionRatio"]:
        raise Refused("ratio_limit")
    arch.bytes += len(out)
    return out


def extract_zip(zf: zipfile.ZipFile, limits: dict, arch: ArchiveBudget, budget: Budget, depth: int) -> tuple[str, int]:
    parts: list[str] = []
    entries = 0
    for info in zf.infolist():
        if info.is_dir():
            continue
        data = read_entry(zf, info, limits, arch, budget)
        entries += 1
        kind, text = extract_bytes(data, limits, budget, depth + 1, arch)
        if text:
            parts.append(f"----- {safe_label(info.filename)} -----\n{text}")
    return "\n".join(parts), entries


def safe_label(name: str) -> str:
    # an entry name is attacker text that ends up in the inspected text; keep it to one short printable line
    return re.sub(r"[^\w./ -]", "_", name)[:200]


# ---- OOXML -------------------------------------------------------------------------------------------------

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
A = "{http://schemas.openxmlformats.org/drawingml/2006/main}"
S = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"

DOCX_PART = re.compile(r"^word/(document|header\d*|footer\d*|footnotes|endnotes|comments)\.xml$")
PPTX_PART = re.compile(r"^ppt/(slides/slide|notesSlides/notesSlide)\d+\.xml$")
XLSX_SHEET = re.compile(r"^xl/worksheets/sheet\d+\.xml$")
CORE_PART = "docProps/core.xml"


def parse_xml(data: bytes) -> ET.Element:
    lowered = data.lower()
    if b"<!doctype" in lowered or b"<!entity" in lowered:
        raise Refused("malformed")
    try:
        return ET.fromstring(data)
    except ET.ParseError:
        raise Refused("malformed")


def natural_key(name: str) -> list:
    return [int(t) if t.isdigit() else t for t in re.split(r"(\d+)", name)]


def text_of_docx_part(root: ET.Element) -> str:
    out: list[str] = []
    for p in root.iter(f"{W}p"):
        line: list[str] = []
        for el in p.iter():
            if el.tag == f"{W}t" and el.text:
                line.append(el.text)
            elif el.tag == f"{W}tab":
                line.append("\t")
            elif el.tag in (f"{W}br", f"{W}cr"):
                line.append("\n")
        out.append("".join(line))
    return "\n".join(s for s in out if s)


def text_of_drawing(root: ET.Element) -> str:
    out: list[str] = []
    for p in root.iter(f"{A}p"):
        line = "".join(t.text or "" for t in p.iter(f"{A}t"))
        if line:
            out.append(line)
    return "\n".join(out)


def text_of_xlsx(parts: dict[str, ET.Element]) -> str:
    out: list[str] = []
    shared = parts.get("xl/sharedStrings.xml")
    if shared is not None:
        for si in shared.iter(f"{S}si"):
            s = "".join(t.text or "" for t in si.iter(f"{S}t"))
            if s:
                out.append(s)
    for name in sorted((n for n in parts if XLSX_SHEET.match(n)), key=natural_key):
        for c in parts[name].iter(f"{S}c"):
            if c.get("t") == "s":
                continue  # an index into sharedStrings, already read above
            if c.get("t") == "inlineStr":
                s = "".join(t.text or "" for t in c.iter(f"{S}t"))
            else:
                v = c.find(f"{S}v")
                s = v.text if v is not None and v.text else ""
            if s:
                out.append(s)
    return "\n".join(out)


def text_of_core(root: ET.Element) -> str:
    # author, title, subject, keywords: metadata carries personal data too
    return "\n".join(el.text.strip() for el in root.iter() if el.text and el.text.strip())


def extract_ooxml(zf: zipfile.ZipFile, kind: str, limits: dict, arch: ArchiveBudget, budget: Budget) -> tuple[str, int]:
    if kind == "docx":
        wanted = lambda n: bool(DOCX_PART.match(n))  # noqa: E731
    elif kind == "pptx":
        wanted = lambda n: bool(PPTX_PART.match(n))  # noqa: E731
    else:
        wanted = lambda n: n == "xl/sharedStrings.xml" or bool(XLSX_SHEET.match(n))  # noqa: E731
    parts: dict[str, ET.Element] = {}
    infos = sorted(zf.infolist(), key=lambda i: natural_key(i.filename))
    for info in infos:
        if info.is_dir() or not (wanted(info.filename) or info.filename == CORE_PART):
            continue
        parts[info.filename] = parse_xml(read_entry(zf, info, limits, arch, budget))
    texts: list[str] = []
    if kind == "xlsx":
        texts.append(text_of_xlsx(parts))
    for name, root in parts.items():
        if name == CORE_PART or kind == "xlsx":
            continue
        texts.append(text_of_docx_part(root) if kind == "docx" else text_of_drawing(root))
    if CORE_PART in parts:
        texts.append(text_of_core(parts[CORE_PART]))
    return "\n".join(t for t in texts if t), len(parts)


# ---- PDF ---------------------------------------------------------------------------------------------------


def extract_pdf(data: bytes, limits: dict, budget: Budget) -> tuple[str, int, int]:
    try:
        import pypdfium2 as pdfium  # noqa: PLC0415 (imported only when a PDF arrives)
    except ImportError:  # the image always has it; a bare interpreter in a unit test may not
        raise Refused("unknown_type")
    try:
        pdf = pdfium.PdfDocument(data)
    except pdfium.PdfiumError as e:
        raise Refused("encrypted" if "password" in str(e).lower() else "malformed")
    try:
        n = len(pdf)
        if n > limits["maxPages"]:
            raise Refused("page_limit")
        pages: list[str] = []
        scanned = 0
        for i in range(n):
            budget.tick()
            page = pdf[i]
            try:
                tp = page.get_textpage()
                try:
                    text = tp.get_text_bounded().strip()
                finally:
                    tp.close()
            finally:
                page.close()
            if text:
                pages.append(budget.take(text))
            else:
                scanned += 1
        if n > 0 and not pages:
            raise Refused("needs_ocr")
        return "\n\f".join(pages), n, scanned
    finally:
        pdf.close()


# ---- dispatch ----------------------------------------------------------------------------------------------


def extract_bytes(data: bytes, limits: dict, budget: Budget, depth: int, arch: ArchiveBudget | None) -> tuple[str, str]:
    """(kind, text) for one blob; raises Refused."""
    budget.tick()
    kind = sniff(data)
    if kind == "pdf":
        text, _, _ = extract_pdf(data, limits, budget)
        return kind, text
    if kind == "text":
        return kind, budget.take(decode_text(data))
    if kind == "image":
        raise Refused("needs_ocr")
    if kind == "zip":
        if depth > limits["maxArchiveDepth"]:
            raise Refused("depth_limit")
        zf = open_zip(data)
        arch = arch or ArchiveBudget()
        office = ooxml_kind(zf)
        if office:
            text, _ = extract_ooxml(zf, office, limits, arch, budget)
            return office, budget.take(text)
        text, _ = extract_zip(zf, limits, arch, budget, depth)
        return "zip", text
    raise Refused("unknown_type")


def family_matches(declared: str | None, kind: str) -> bool:
    """A declared media type is checked only when we know it; `zip` admits the OOXML kinds (they are zips)."""
    if declared is None:
        return True
    return kind == declared or (declared == "zip" and kind in COMPATIBLE["zip"])


def extract_file(spec: dict, data: bytes, limits: dict, budget: Budget) -> dict:
    out: dict = {"id": spec.get("id"), "type": sniff(data)}
    declared = DECLARED_FAMILY.get(str(spec.get("mediaType", "")).lower().split(";")[0].strip())
    try:
        if len(data) > limits["maxFileBytes"]:
            raise Refused("too_large")
        # cheap pre-check on the sniffed family, before any parser runs: a declared PDF that is a zip never
        # reaches the zip reader
        sniffed = out["type"]
        if declared and not (family_matches(declared, sniffed) or (sniffed == "zip" and declared in COMPATIBLE["zip"])):
            raise Refused("type_mismatch")
        if sniffed == "pdf":
            text, pages, scanned = extract_pdf(data, limits, budget)
            out.update(status="extracted", text=text, pages=pages, scannedPages=scanned)
            return out
        kind, text = extract_bytes(data, limits, budget, 0, None)
        out["type"] = kind
        if not family_matches(declared, kind):
            raise Refused("type_mismatch")  # declared .docx that is really an .xlsx
        out.update(status="extracted", text=text)
        return out
    except Refused as r:
        out.update(status="refused", reason=r.reason)
        out.pop("text", None)
        return out
    except RecursionError:
        out.update(status="refused", reason="depth_limit")
        return out
    except MemoryError:
        out.update(status="refused", reason="too_large")
        return out


def run(request: dict, read) -> dict:
    limits = merge_limits(request.get("limits"))
    budget = Budget(limits)
    files = request.get("files")
    if not isinstance(files, list):
        raise ValueError("request.files must be a list")
    results = []
    for spec in files:
        try:
            data = read(spec, limits["maxFileBytes"])
        except Refused as r:
            results.append({"id": spec.get("id"), "status": "refused", "reason": r.reason, "type": "unknown"})
            continue
        results.append(extract_file(spec, data, limits, budget))
    return {"version": RESULT_VERSION, "files": results}


def read_inline(spec: dict, cap: int) -> bytes:
    """The bytes of one file of the bundle: strict base64, bounded before decoding."""
    data = spec.get("dataBase64")
    if not isinstance(data, str) or not re.fullmatch(r"[A-Za-z0-9+/]*={0,2}", data) or len(data) % 4:
        raise Refused("malformed")
    if len(data) // 4 * 3 > cap + 2:
        raise Refused("too_large")
    out = base64.b64decode(data, validate=True)
    if len(out) > cap:
        raise Refused("too_large")
    return out


# the bundle itself: the files' base64 plus a little JSON; the gateway never sends more (ADR-0362 "Limits")
MAX_BUNDLE_BYTES = 96 * 1024 * 1024


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        print("usage: extract.py <bundle.json> <result.json>", file=sys.stderr)
        return 2
    with open(argv[1], "rb") as fh:
        raw = fh.read(MAX_BUNDLE_BYTES + 1)
    if len(raw) > MAX_BUNDLE_BYTES:
        print("bundle over its limit", file=sys.stderr)
        return 3
    request = json.loads(raw)
    if not isinstance(request, dict):
        print("bundle is not an object", file=sys.stderr)
        return 3
    result = run(request, read_inline)
    tmp = argv[2] + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(result, fh, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, argv[2])
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
