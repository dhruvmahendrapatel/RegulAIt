"""ADR-0220: the trained-detector service's pure core.

No model, no network, no clock: the request contract, chunking and the
reduction of model outputs to the ADR-0088 reply ``{"score", "reasons"}``.
The models are passed in as plain callables, so this file is tested with
fakes (test_detector_core.py) and the real models live in server.py.

Reply rules, mirrored by the gateway (packages/shared/src/trained-detectors.ts):
  - ``score`` is a finite number in [0, 1]: the strongest signal in any chunk.
  - ``reasons`` are bare lowercase labels (an entity type, a harm category),
    never text from the request. The gateway drops anything that is not a
    label, but this service does not send one in the first place.
"""

from __future__ import annotations

import math
from typing import Callable, Iterable, Mapping, Sequence

GUARDRAIL_KINDS = ("guardrail_pii", "guardrail_prompt_injection", "guardrail_harm")

# the gateway refuses longer text before sending it; this is the same bound
MAX_TEXT_CHARS = 256_000
# a window comfortably inside a 512-token encoder, with an overlap so a phrase
# split across a boundary is still seen whole in one window
CHUNK_CHARS = 1_500
CHUNK_OVERLAP = 200
# a harm label or PII entity counts as a reason at or above this probability
REASON_MIN = 0.5


class RequestError(ValueError):
    """A request outside the contract. The server answers 400, which the
    gateway treats as a scorer failure (and so fails closed by default)."""


def parse_request(body: object) -> tuple[str, str]:
    """Validate a decoded request; return (scorerKind, text)."""
    if not isinstance(body, dict):
        raise RequestError("request is not a JSON object")
    kind = body.get("scorerKind")
    if kind not in GUARDRAIL_KINDS:
        raise RequestError("unsupported scorerKind")
    parts = []
    for field in ("input", "output"):
        value = body.get(field, "")
        if not isinstance(value, str):
            raise RequestError(f"`{field}` must be a string")
        if value:
            parts.append(value)
    text = "\n".join(parts)
    if len(text) > MAX_TEXT_CHARS:
        raise RequestError("text too long")
    return kind, text


def chunks(text: str, size: int = CHUNK_CHARS, overlap: int = CHUNK_OVERLAP) -> list[str]:
    """Overlapping windows covering all of ``text`` (an empty text is no windows)."""
    if not text:
        return []
    if len(text) <= size:
        return [text]
    step = size - overlap
    return [text[i : i + size] for i in range(0, len(text) - overlap, step)]


def _clamp(p: float) -> float:
    if not isinstance(p, (int, float)) or math.isnan(p):
        raise ValueError("model returned a non-numeric probability")
    return min(1.0, max(0.0, float(p)))


def score_injection(text: str, classify: Callable[[str], Mapping[str, float]]) -> dict:
    """``classify`` maps a window to label probabilities; the injection label
    is ``INJECTION`` (case-insensitive). Score = the highest across windows."""
    best = 0.0
    for window in chunks(text):
        probs = {k.upper(): v for k, v in classify(window).items()}
        best = max(best, _clamp(probs.get("INJECTION", 0.0)))
    return {"score": best, "reasons": []}


def score_harm(text: str, classify: Callable[[str], Mapping[str, float]]) -> dict:
    """``classify`` maps a window to independent (multi-label) probabilities.
    Score = the highest label anywhere; reasons = each label that reached
    REASON_MIN in any window, once."""
    best = 0.0
    labels: set[str] = set()
    for window in chunks(text):
        for label, p in classify(window).items():
            p = _clamp(p)
            best = max(best, p)
            if p >= REASON_MIN:
                labels.add(_label(label))
    return {"score": best, "reasons": sorted(labels)}


def score_pii(
    text: str,
    recognise: Callable[[str], Iterable[tuple[str, float, int, int]]],
) -> dict:
    """``recognise`` returns (entity_type, score, start, end) per finding in a
    window. Score = the highest finding; reasons = one entity label per
    distinct finding (so the gateway can count them), de-duplicated across
    the overlap between windows by absolute position."""
    best = 0.0
    seen: set[tuple[str, int, int]] = set()
    reasons: list[str] = []
    step = CHUNK_CHARS - CHUNK_OVERLAP
    for i, window in enumerate(chunks(text)):
        offset = i * step if len(text) > CHUNK_CHARS else 0
        for entity, p, start, end in recognise(window):
            p = _clamp(p)
            best = max(best, p)
            if p < REASON_MIN:
                continue
            key = (_label(entity), offset + start, offset + end)
            if key in seen:
                continue
            seen.add(key)
            reasons.append(key[0])
    return {"score": best, "reasons": reasons[:20]}


def _label(raw: str) -> str:
    """A bare lowercase label (the gateway's `^[a-z][a-z0-9_]{0,39}$`)."""
    out = "".join(c if c.isalnum() else "_" for c in raw.strip().lower())[:40]
    return out if out and out[0].isalpha() else "unlabelled"


def score(kind: str, text: str, models: Mapping[str, Callable]) -> dict:
    """Dispatch one validated request to its model."""
    if kind == "guardrail_prompt_injection":
        return score_injection(text, models["prompt_injection"])
    if kind == "guardrail_harm":
        return score_harm(text, models["harm"])
    if kind == "guardrail_pii":
        return score_pii(text, models["pii"])
    raise RequestError("unsupported scorerKind")


def supported(models: Mapping[str, object]) -> Sequence[str]:
    """The guardrail kinds this instance can serve (for /healthz)."""
    have = {"prompt_injection": "guardrail_prompt_injection", "harm": "guardrail_harm", "pii": "guardrail_pii"}
    return [have[k] for k in have if k in models]
