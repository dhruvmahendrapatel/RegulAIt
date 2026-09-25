# Demo runbook — the seeded and hardened environment

For a **capability demo** driven by us, to a prospective customer. It is not a trial environment and
nothing in it is production: every provider is a mock, every upstream is a loopback double, and every
credential it mints is printed once and dies with the database.

---

## 1. Stand it up (about three minutes)

Four terminals, in this order. Steps 2–4 all need the same `DATABASE_URL`,
`REGULAIT_BOOTSTRAP_TOKEN` and `REGULAIT_DATA_KEY`.

```bash
# (1) Postgres. On a laptop, docker compose also gives you the WORM audit anchor — see §2.
docker compose up -d db minio minio-init

# (2) Seed the playground. Prints the personas' one-time passwords and API keys — KEEP THIS OUTPUT.
pnpm --filter @regulait/gateway seed

# (3) A real MCP server on loopback. LEAVE IT RUNNING for the whole demo.
pnpm --filter @regulait/gateway demo:mcp

# (4) Make it hardened, and check it. Re-runnable; run it again if anything drifts.
#     Also mints an EPHEMERAL demo licence (compliance packs are tier-gated and an
#     unlicensed deployment runs default CLOSED, so criterion (d) needs one), activates
#     the NIST and EU packs, and creates the use case (d) is about.
pnpm --filter @regulait/gateway demo:setup

# (5) The gateway itself.
pnpm --filter @regulait/gateway start
```

`demo:setup` ends by dispatching as a real user **before and after** applying the preset. If the
second one is not `200` it says so in as many words. **Do not present until it is** — with the gates
on, every refusal you then demo will name the first unmet gate rather than the one you meant to show.

### Why step 3 exists

The seed registers its MCP servers against `http://127.0.0.1:9/` — the discard port — on purpose, so
seeding needs no listener. But `POST /mcp/:serverId` connects upstream at the *top* of the handler,
before any JSON-RPC message is read, so that egress and admission refusals come back as plain HTTP
rather than as protocol errors. Against the discard port every request dies at connect, and the
gateway looks broken rather than governed. `demo:setup` repoints the rows at the real server.

---

## 2. The two controls that are not settable from any API

`demo:setup` will report **5 of 7** enforcement controls and an overall verdict of **not hardened**.
That is correct, not a failure: the audit anchor and the scheduler are resolved from the process
environment at start-up, and an API call cannot set an environment variable. The product reports them
with their *observed* state and refuses to count them on its own say-so.

To reach **7 of 7 / `hardened: true`**:

```bash
export REGULAIT_SCHEDULER=on            # docker compose does NOT pass this through by default
docker compose up -d minio minio-init   # a REAL S3 Object Lock COMPLIANCE bucket
```

Then restart the gateway and re-read `/admin → Enforcement posture`. The anchor grade comes from
asking the bucket for its Object Lock configuration — a `GOVERNANCE`-mode bucket still grades
**false**, because an administrator holding `s3:BypassGovernanceRetention` defeats it. No flag can
fake it, which is the point and is worth saying out loud.

**Confirm the page reads 7 of 7 before you present.** If docker is unavailable on the demo box, run
at 5 of 7 and show the two unmet rows deliberately — an honest "here is what this install has not
got" lands better than a number nobody can interrogate.

---

## 3. The run of show

### (0) Set the scene — `/admin → Enforcement posture`

One screen that answers *"what is actually enforcing right now?"*. Read the **"what turning it on
refuses"** column aloud; it is the part with the value. Note the two rows marked *set by deployment*
and say why they cannot be switched on from a page.

### (b) Block a policy-violating tool call — *lead with this, it is the strongest*

As **Dana**, against **repo-tools**, over the real MCP protocol:

| tool | result | why |
|---|---|---|
| `read_file` | **allowed** | her role grants read-only |
| `search_code` | **denied** | her per-user revocation beats the role |
| `write_file` | **approval required** | queued to **Avery, by name** |

`tools/list` is already filtered to what she may see, so the deny is not a UI decoration — she cannot
see the tool she is not entitled to. Then approve the `write_file` request as Avery and retry.

Worth stating: the approval is bound to **the arguments that were approved**. Retry with different
arguments and it re-queues rather than spending a signature on a payload nobody signed. No vendor in
the analysis document does this.

### (c) The audit record of that block

`/admin → Audit`. The deny row carries `effect`, `ruleId`, the full `ruleChain` and a reason, and the
chain is hash-linked. Export signed and verify with `scripts/verify-export-bundle.sh` — **no
database, no gateway, no network**. The trust root is the fingerprint you hand over once; the public
key inside the bundle is a convenience and the verifier refuses to treat it as authority, because a
bundle carrying its own key proves only that somebody signed it.

### (a) Discover an unregistered MCP server

`POST /v1/shadow-ai/mcp-discovery` with the contents of `demo-mcp-evidence.log` (written into the
repo root by `demo:setup`).

One host comes back **governed and named**, one comes back **UNREGISTERED**, from the same file —
and the ordinary web traffic in it stays silent. **Say the limit out loud, because the payload
does**: this classifies evidence *you* supply. It is not a claim to have searched their estate, and a
stdio MCP server — a local subprocess, a very common deployment — never appears in a proxy log at
all. Conceding that is what makes the rest of the answer credible.

### (d) Map a use case to a framework with evidence — **do this straight after (b)**

```
GET /v1/use-cases/<id>/frameworks?framework=nist-ai-rmf
```

Five NIST AI RMF controls with **live evidence counts**, in one call, for any framework we ship.
No longer a two-hop narration.

**The moment worth setting up.** Keep the same screen from (b). The refusal you just demonstrated
*is* the evidence for `nist-ai-rmf:MANAGE-2.2` — "mechanisms are in place to supersede, disengage
or deactivate an AI system". It moves from `unsatisfied` to `satisfied` because a deny landed in
the ledger attributed to this project. So: read the control as unsatisfied, make the refused call,
re-read, watch it go green.

**Make the refused call with the project header** (`x-regulait-project-id`) or it will not count.
That is honest behaviour rather than a trick: an unattributed refusal is not evidence about any
project, and the product declines to pretend otherwise.

Two things to say out loud while it is on screen, because the payload says them:

- **Evidence is collected per project.** The counts cover everything governed in that project, not
  this use case alone. A use case attributed to no project returns nulls, not zeros — "not
  measured" and "measured as none" are different claims.
- **The attestation-required control stays outstanding.** `GOVERN-4.1` is organisational and the
  platform will never count it as satisfied on its own say-so. A tool that marked it green would be
  the tick-box exercise this product exists to replace.

---

## 4. Do not do these

- **Do not claim hardening blocks unattributed calls everywhere.** It binds the native dispatch only.
  There are three independent attribution switches and the preset sets one; the MCP proxy and the
  compat edge have their own. The posture page says so in the attribution control's own text — read
  it rather than talking past it. (A hardened environment will happily serve an unattributed MCP tool
  call, and a technical buyer may well try exactly that.)
- **Do not demo the optimisation cache.** It is deliberately left off. A cached answer looks like a
  fast model and is not one, and being caught on that costs more than the feature is worth here.
- **Do not present discovery as autonomous.** See (a).
- **Do not claim "least privilege for agents".** We enforce least privilege for the *humans* who
  hold agent grants; there is no per-agent principal in the policy kernel. The accurate and still
  strong sentence is "every agent call is bound to an entitled human identity".
- **Do not claim a kill switch.** There isn't one — no global stop, no per-tool emergency disable.
  A per-agent `enabled` flag is enforced in the kernel and is now audited, and that is what to say.
- **Do not promise SAP.** There is no code. One incidental comment in a migration header is the only
  hit in the repository.
- **Do not open a `prod` anything.** Nothing in this environment is production and nothing should be
  made to look like it.

---

## 5. If something breaks mid-demo

| symptom | cause | fix |
|---|---|---|
| every MCP call fails at connect | `demo:mcp` is not running, or the rows point at the discard port | start it, re-run `demo:setup` |
| a dispatch returns `mrm_approval_required` | that agent has no live model card | re-run `demo:setup`; it only covers the three mock agents |
| a dispatch returns `attribution_required` | the call named no project | pass `projectId` — this is the gate working |
| posture reads fewer controls than expected | the gateway was restarted without the env | re-export and restart; the page is reading the truth |
| a tool that should be a write behaves as a read | the upstream lost its `readOnlyHint` and the live manifest overwrote the inventory | check `demo-mcp-server.ts`; the hint *is* the classification |
| activating a pack answers `license_feature_not_licensed` | the ephemeral demo licence is missing, or the gateway cannot see the keyring | re-run `demo:setup`, and start the gateway with `REGULAIT_LICENSE_KEYRING=<repo>/demo-license-keys` |
| every MCP call returns a bare `{"error":"internal"}` | the demo MCP server is not running — an upstream connection failure currently surfaces as an opaque 500 rather than a named refusal | restart `demo:mcp`. (Worth knowing: unlike `egress_blocked` and `mcp_admission_held`, this one is not named yet.) |
| `MANAGE-2.2` stays `unsatisfied` after a refusal | the refused call carried no `x-regulait-project-id` | repeat it with the header; an unattributed refusal is correctly not counted |

Re-running `demo:setup` is safe at any point. It reads the world back at each step rather than
assuming the previous run landed, and it mints fresh keys for Dana and Avery each time.
