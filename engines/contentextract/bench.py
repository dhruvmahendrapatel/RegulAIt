"""ADR-0362 slice 3: the cost of content inspection, measured.

    python3 -I engines/contentextract/bench.py [--runs N] [--json out.json]

Measures, per file type, the extractor's own work inside the sandbox: a cold process (interpreter start, imports,
extraction, result written; what one sandboxed task pays) and the warm extraction alone (throughput). The files are
synthetic and built here, so the numbers are reproducible on any machine with pypdfium2 and, for OCR, Tesseract.

It does not measure the sandbox start (gVisor), the engine runner's lease poll or the gateway's await; those are
reported in ADR-0362 §Cost from the engine contract's constants, until a built image can be timed end to end.
"""

from __future__ import annotations

import argparse
import base64
import io
import json
import os
import statistics
import subprocess
import sys
import tempfile
import time
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import extract  # noqa: E402
import test_extract as fx  # noqa: E402  (the unit tests' fixture builders)

LOREM = (
    "The quarterly report lists account 4111 1111 1111 1111 and contact alice@example.com. "
    "Revenue grew in every region; the appendix carries the detail for each cost centre. "
)


def text_pdf(pages: int) -> bytes:
    body = LOREM * 6
    return fx.pdf_with_text(body[:900].replace("(", "").replace(")", ""), pages=pages)


def docx(paragraphs: int) -> bytes:
    # varied text, so the package is not a few hundred bytes of repeated, perfectly compressible XML
    return fx.docx(*[f"Paragraph {i}: invoice {100000 + i * 7919} for user{i}@example.com, {LOREM}" for i in range(paragraphs)])


def xlsx(rows: int) -> bytes:
    shared = f'<sst xmlns="{fx.SNS}">' + "".join(f"<si><t>name {i} alice{i}@example.com</t></si>" for i in range(rows)) + "</sst>"
    cells = "".join(f'<row><c t="s"><v>{i}</v></c><c><v>{4111111111111111 + i}</v></c></row>' for i in range(rows))
    sheet = f'<worksheet xmlns="{fx.SNS}"><sheetData>{cells}</sheetData></worksheet>'
    return fx.zip_bytes(
        {"[Content_Types].xml": fx.CT, "xl/workbook.xml": b"<workbook/>", "xl/sharedStrings.xml": shared.encode(),
         "xl/worksheets/sheet1.xml": sheet.encode()}
    )


def csv(rows: int) -> bytes:
    return ("name,email,card\n" + "".join(f"user{i},user{i}@example.com,4111111111111111\n" for i in range(rows))).encode()


def archive(n: int) -> bytes:
    return fx.zip_bytes({f"doc{i}.txt": (LOREM * 20).encode() for i in range(n)})


def cases(with_ocr: bool) -> list[tuple[str, str, bytes]]:
    out = [
        ("csv 10k rows", "text/csv", csv(10_000)),
        ("docx 2,000 paragraphs", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", docx(2_000)),
        ("xlsx 5k rows", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", xlsx(5_000)),
        ("zip 50 text files", "application/zip", archive(50)),
        ("pdf 1 page (text)", "application/pdf", text_pdf(1)),
        ("pdf 50 pages (text)", "application/pdf", text_pdf(50)),
        ("pdf 200 pages (text)", "application/pdf", text_pdf(200)),
    ]
    if with_ocr:
        w, h, gray = fx.text_page_gray("Account 4111 1111 1111 1111 for alice@example.com")
        out.append(("png 1 page (OCR)", "image/png", fx.png_gray(w, h, gray)))
        out.append(("pdf 1 scanned page (OCR)", "application/pdf", fx.pdf_with_image(w, h, gray)))
        out.append(("pdf 5 scanned pages (OCR)", "application/pdf", scanned_pdf(w, h, gray, 5)))
    return out


def scanned_pdf(w: int, h: int, gray: bytes, pages: int) -> bytes:
    one = fx.pdf_with_image(w, h, gray)
    # the same page n times: rebuild with n Kids pointing at one page object (identical pages are fine for timing)
    return one.replace(b"/Kids [3 0 R] /Count 1", b"/Kids [" + b" ".join(b"3 0 R" for _ in range(pages)) + b"] /Count %d" % pages)


def warm(data: bytes, media_type: str) -> float:
    t = time.perf_counter()
    r = extract.run({"files": [{"id": "f", "mediaType": media_type, "dataBase64": base64.b64encode(data).decode()}]}, extract.read_inline)
    elapsed = time.perf_counter() - t
    if r["files"][0]["status"] != "extracted":
        raise SystemExit(f"benchmark input was refused: {r['files'][0]}")
    return elapsed


def cold(data: bytes, media_type: str, tmp: str) -> float:
    bundle = os.path.join(tmp, "bundle.json")
    with open(bundle, "w") as fh:
        json.dump({"files": [{"id": "f", "mediaType": media_type, "dataBase64": base64.b64encode(data).decode()}]}, fh)
    t = time.perf_counter()
    subprocess.run([sys.executable, "-I", os.path.join(HERE, "extract.py"), bundle, os.path.join(tmp, "r.json")], check=True)
    return time.perf_counter() - t


def pct(xs: list[float], p: float) -> float:
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(round(p * (len(xs) - 1))))]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--runs", type=int, default=7)
    ap.add_argument("--json")
    args = ap.parse_args()
    with_ocr = extract.ocr_available()
    rows = []
    with tempfile.TemporaryDirectory() as tmp:
        warm(b"warm up", "text/plain")
        for name, mt, data in cases(with_ocr):
            w = [warm(data, mt) for _ in range(args.runs)]
            c = [cold(data, mt, tmp) for _ in range(max(3, args.runs // 2))]
            med = statistics.median(w)
            rows.append({
                "case": name,
                "bytes": len(data),
                "warm_ms_median": round(med * 1000, 1),
                "warm_ms_p95": round(pct(w, 0.95) * 1000, 1),
                "cold_ms_median": round(statistics.median(c) * 1000, 1),
                "mb_per_s": round(len(data) / 1e6 / med, 2) if med > 0 else None,  # input bytes; compressed formats read low
            })
    env = {
        "python": sys.version.split()[0],
        "cpus": os.cpu_count(),
        "ocr": with_ocr,
        "tesseract": subprocess.run([extract.TESSERACT, "--version"], capture_output=True, text=True).stdout.splitlines()[0] if with_ocr else None,
    }
    print(f"{'case':28} {'bytes':>10} {'warm med':>9} {'warm p95':>9} {'cold med':>9} {'MB/s':>7}")
    for r in rows:
        print(f"{r['case']:28} {r['bytes']:>10} {r['warm_ms_median']:>8}ms {r['warm_ms_p95']:>8}ms {r['cold_ms_median']:>8}ms {r['mb_per_s']!s:>7}")
    print(json.dumps(env))
    if args.json:
        with open(args.json, "w") as fh:
            json.dump({"env": env, "rows": rows}, fh, indent=2)
    return 0


if __name__ == "__main__":
    sys.exit(main())
