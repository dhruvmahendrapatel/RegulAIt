"""Draft a first reply to a support ticket (fictional demo code)."""

import os

import anthropic
from openai import OpenAI


def draft_reply(ticket_text: str) -> str:
    try:
        client = OpenAI(api_key=os.environ["OPENAI_API_KEY"])
        result = client.chat.completions.create(
            model=os.environ["CHAT_MODEL"],
            messages=[
                {"role": "system", "content": "You draft polite replies for an outdoor-gear shop."},
                {"role": "user", "content": ticket_text},
            ],
            max_tokens=200,
        )
        return result.choices[0].message.content
    except Exception:
        fallback = anthropic.Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])
        message = fallback.messages.create(
            model=os.environ["FALLBACK_MODEL"],
            max_tokens=200,
            messages=[{"role": "user", "content": ticket_text}],
        )
        return message.content[0].text
