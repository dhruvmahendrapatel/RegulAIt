"""Planted demo AI activity: a few small Bedrock Converse calls per run.

Each call is recorded by CloudTrail as a `Converse` management event under this
function's role, which is what a discovery scan reads. Nothing about the prompt
or the reply is logged: only call and token counts.

The caps below hold whatever the environment says, so a mistyped variable can
never turn this into a large spend.
"""

import json
import os
import random

import boto3

MAX_TOKENS_CAP = 128
CALLS_PER_RUN_CAP = 3

_client = boto3.client("bedrock-runtime")


def _bounded_int(name, default, cap):
    try:
        value = int(os.environ.get(name, default))
    except ValueError:
        value = default
    return max(1, min(value, cap))


def handler(event, context):
    model_id = os.environ["MODEL_ID"]
    prompts = json.loads(os.environ["PROMPTS"])
    max_tokens = _bounded_int("MAX_TOKENS", 48, MAX_TOKENS_CAP)
    calls = _bounded_int("CALLS_PER_RUN", 1, CALLS_PER_RUN_CAP)

    usage = []
    for _ in range(calls):
        prompt = random.choice(prompts)
        response = _client.converse(
            modelId=model_id,
            messages=[{"role": "user", "content": [{"text": prompt}]}],
            inferenceConfig={"maxTokens": max_tokens, "temperature": 0.2},
        )
        tokens = response.get("usage", {})
        usage.append({"in": tokens.get("inputTokens", 0), "out": tokens.get("outputTokens", 0)})

    print(json.dumps({"calls": len(usage), "usage": usage}))
    return {"calls": len(usage)}
