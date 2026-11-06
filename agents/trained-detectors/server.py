"""ADR-0220: the trained-detector service (reference implementation).

Speaks the ADR-0088 external-scorer contract on ``POST /score`` for the three
guardrail kinds, and answers ``GET /healthz`` with the kinds it serves. Every
model is read from /opt/models, baked into the image at build time and
verified against models.lock.json; nothing is downloaded at run time
(HF_HUB_OFFLINE and TRANSFORMERS_OFFLINE are set, and every load is
``local_files_only``).

Logging carries the method, path, status and duration only. Request and
reply bodies are never logged.

Environment:
  DETECTOR_PORT      listen port (default 8080)
  DETECTOR_API_KEY   if set, every /score request must send
                     ``Authorization: Bearer <key>`` (register the same key on
                     the gateway's External scorers page)
  DETECTOR_MODELS    comma-separated subset of pii,prompt_injection,harm to
                     load (default: all three)
"""

from __future__ import annotations

import hmac
import json
import logging
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import detector_core as core

MODELS_DIR = os.environ.get("DETECTOR_MODELS_DIR", "/opt/models")
MAX_BODY_BYTES = 2 * 1024 * 1024

log = logging.getLogger("trained-detectors")


def pin_offline_public_suffix_list(tldextract_module) -> object:
    """Replace tldextract's module-level extractor with one that cannot fetch.

    Presidio's email recogniser calls ``tldextract.extract()``, whose default
    extractor downloads the Public Suffix List on first use (no timeout by
    default) and caches it under $HOME. An air-gapped service must never try.
    This one has no URLs and no cache, so it always uses the snapshot bundled
    in the pinned tldextract wheel. ``tldextract.extract`` reads the module
    global at call time, so replacing it covers every caller."""
    extractor = tldextract_module.TLDExtract(suffix_list_urls=(), cache_dir=None, fallback_to_snapshot=True)
    tldextract_module.tldextract.TLD_EXTRACTOR = extractor
    return extractor


def load_models(wanted: list[str]) -> dict:
    """Load each requested model from its baked directory. Imports are local
    so the pure core and its tests need none of these packages."""
    models: dict = {}
    if "prompt_injection" in wanted or "harm" in wanted:
        import torch
        from transformers import AutoModelForSequenceClassification, AutoTokenizer

        torch.set_num_threads(int(os.environ.get("DETECTOR_THREADS", "2")))

        def classifier(path: str, multi_label: bool):
            tok = AutoTokenizer.from_pretrained(path, local_files_only=True)
            model = AutoModelForSequenceClassification.from_pretrained(path, local_files_only=True).eval()
            labels = model.config.id2label

            def classify(text: str) -> dict:
                with torch.inference_mode():
                    enc = tok(text, truncation=True, max_length=512, return_tensors="pt")
                    logits = model(**enc).logits[0]
                    probs = torch.sigmoid(logits) if multi_label else torch.softmax(logits, dim=-1)
                return {labels[i]: float(p) for i, p in enumerate(probs)}

            return classify

        if "prompt_injection" in wanted:
            models["prompt_injection"] = classifier(os.path.join(MODELS_DIR, "prompt-injection"), multi_label=False)
        if "harm" in wanted:
            models["harm"] = classifier(os.path.join(MODELS_DIR, "harm"), multi_label=True)

    if "pii" in wanted:
        import tldextract

        # before any recogniser is built or called: no Public Suffix List fetch, ever
        pin_offline_public_suffix_list(tldextract)
        from presidio_analyzer import AnalyzerEngine
        from presidio_analyzer.nlp_engine import NlpEngineProvider

        provider = NlpEngineProvider(
            nlp_configuration={"nlp_engine_name": "spacy", "models": [{"lang_code": "en", "model_name": "en_core_web_sm"}]}
        )
        engine = AnalyzerEngine(nlp_engine=provider.create_engine(), supported_languages=["en"])

        def recognise(text: str):
            return [(r.entity_type, r.score, r.start, r.end) for r in engine.analyze(text=text, language="en")]

        models["pii"] = recognise
    return models


class Handler(BaseHTTPRequestHandler):
    server_version = "regulait-trained-detectors"
    sys_version = ""
    models: dict = {}
    api_key: str | None = None
    lock = threading.Lock()

    # BaseHTTPRequestHandler logs the request line, which is safe, but route it
    # through one place so nothing else is ever added to it
    def log_message(self, fmt: str, *args) -> None:  # noqa: D401
        return

    def _reply(self, status: int, body: dict, started: float) -> None:
        raw = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)
        log.info("%s %s %d %.0fms", self.command, self.path.split("?")[0], status, (time.monotonic() - started) * 1000)

    def do_GET(self) -> None:
        started = time.monotonic()
        if self.path == "/healthz":
            return self._reply(200, {"ok": True, "serves": list(core.supported(self.models))}, started)
        return self._reply(404, {"error": "not found"}, started)

    def do_POST(self) -> None:
        started = time.monotonic()
        if self.path != "/score":
            return self._reply(404, {"error": "not found"}, started)
        if self.api_key is not None:
            got = self.headers.get("authorization", "")
            if not hmac.compare_digest(got.encode(), f"Bearer {self.api_key}".encode()):
                return self._reply(401, {"error": "unauthorised"}, started)
        try:
            length = int(self.headers.get("content-length", ""))
        except ValueError:
            return self._reply(411, {"error": "content-length required"}, started)
        if length < 0 or length > MAX_BODY_BYTES:
            return self._reply(413, {"error": "request too large"}, started)
        try:
            kind, text = core.parse_request(json.loads(self.rfile.read(length) or b"null"))
        except (core.RequestError, json.JSONDecodeError, UnicodeDecodeError) as err:
            # the message is ours (never the request text)
            return self._reply(400, {"error": str(err) if isinstance(err, core.RequestError) else "invalid JSON"}, started)
        model_key = kind.removeprefix("guardrail_")
        if model_key not in self.models:
            return self._reply(400, {"error": "scorerKind not loaded on this instance"}, started)
        try:
            with self.lock:
                verdict = core.score(kind, text, self.models)
        except Exception:  # noqa: BLE001 — a model failure is a 500, never a fabricated score
            return self._reply(500, {"error": "model failure"}, started)
        return self._reply(200, verdict, started)


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    wanted = [m.strip() for m in os.environ.get("DETECTOR_MODELS", "pii,prompt_injection,harm").split(",") if m.strip()]
    Handler.models = load_models(wanted)
    Handler.api_key = os.environ.get("DETECTOR_API_KEY") or None
    port = int(os.environ.get("DETECTOR_PORT", "8080"))
    log.info("serving %s on :%d", ",".join(core.supported(Handler.models)), port)
    ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()


if __name__ == "__main__":
    main()
