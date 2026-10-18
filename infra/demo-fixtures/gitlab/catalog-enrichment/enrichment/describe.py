"""Write short descriptions and tags for new catalogue items (fictional demo code)."""

import os

import cohere
from mistralai import Mistral


def describe(item_name: str) -> str:
    client = Mistral(api_key=os.environ["MISTRAL_API_KEY"])
    res = client.chat.complete(
        model=os.environ["DESCRIPTION_MODEL"],
        messages=[{"role": "user", "content": f"Two sentences describing: {item_name}"}],
    )
    return res.choices[0].message.content


def tags(description: str) -> list[str]:
    co = cohere.ClientV2(api_key=os.environ["CO_API_KEY"])
    res = co.classify(inputs=[description], examples=[])
    return [c.prediction for c in res.classifications]
