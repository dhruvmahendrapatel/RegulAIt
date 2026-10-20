"""Summarise end-of-shift stock notes with a local model (fictional demo code)."""

import os

import ollama


def summarise(notes: str) -> str:
    res = ollama.chat(
        model=os.environ["LOCAL_MODEL"],
        messages=[{"role": "user", "content": f"Summarise these stock notes:\n{notes}"}],
    )
    return res["message"]["content"]
