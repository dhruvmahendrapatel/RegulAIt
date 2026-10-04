# Demo runbook — the seeded and hardened environment

For a **capability demo** driven by us, to a prospective customer. It is not a trial environment and
nothing in it is production: every provider is a mock, every upstream is a loopback double, and every
credential it mints is printed once and dies with the database.

---

## 1. Stand it up (about three minutes)

Four terminals, in this order. Steps 2–4 all need the same `DATABASE_URL`,
`REGULAIT_BOOTSTRAP_TOKEN` and `REGULAIT_DATA_KEY`. The gateway (step 5) also needs
`REGULAIT_OFFLINE_CHECKS=1`: there is no CI in the demo, and since AER-047 a workflow check nobody
reports waits for a report unless the gateway declares offline mode — the seeded pipeline templates
then auto-pass their checks, labelled "auto-passed · no report". A database seeded before
2026-10-03 predates that opt-in and must be recreated.

**No docker on the demo box?** Skip to §1.1 and come back. Everything from §3 onwards is
identical — the only thing you lose is the WORM anchor, and §2 says exactly what that costs.

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

# (4b) OPTIONAL (ADR-0174) — one password you chose for Ada, Dana and Avery instead of the
#     one-time passwords from (2). Read from the environment or a 0600 secret file, checked
#     against the password policy, never printed, audited without the password. Runs only
#     AFTER (4): it requires the ephemeral demo licence (4) installs, and refuses with no
#     licence, an expired one, or a customer licence. (demo:prepare runs (4) for you.)
read -rs REGULAIT_DEMO_USER_PASSWORD && export REGULAIT_DEMO_USER_PASSWORD
pnpm --filter @regulait/gateway demo:set-passwords && unset REGULAIT_DEMO_USER_PASSWORD

# (5) The gateway itself. HOST=127.0.0.1 binds loopback only — a laptop on a shared
#     network must not expose the plaintext gateway and its bootstrap token (DEMO-01).
HOST=127.0.0.1 REGULAIT_OFFLINE_CHECKS=1 pnpm --filter @regulait/gateway start
```

### 1.1 Without docker — a native Postgres path

Docker is not available everywhere this gets demoed (a locked-down laptop, a cloud dev box, a
customer-supplied machine). Nothing in §1 actually needs containers except Postgres and MinIO, and
only one of those is load-bearing for the run of show.

**Postgres 16, installed natively.** One-time, as root:

```bash
pg_ctlcluster 16 main start                                  # if it is not already running
sudo -u postgres psql -c "CREATE ROLE regulait LOGIN PASSWORD 'regulait';"
sudo -u postgres psql -c "CREATE DATABASE regulait OWNER regulait;"
```

**Mint the data key ONCE**, in one terminal, and read it off the screen:

```bash
openssl rand -hex 32           # 64 HEX characters — copy this value
```

**Hex, not base64.** `keyBytes` (`apps/gateway/src/secrets.ts:32-35`) does
`Buffer.from(key, "hex")` and requires exactly 32 bytes. A base64 key is not rejected at
start-up — the ADR-0063 boot gate checks key *continuity*, not *format*, so the gateway boots
clean, seeding gets most of the way through, and then the first credential write answers a bare
**`500 internal`**. It cost a verification run to find; do not rediscover it at a customer.

Then paste **that same literal** into **every** terminal, and run §1 steps 2–5 unchanged:

```bash
export DATABASE_URL="postgres://regulait:regulait@127.0.0.1:5432/regulait"
export REGULAIT_BOOTSTRAP_TOKEN="dev-bootstrap"
export REGULAIT_DATA_KEY="<the value you just minted>"
export REGULAIT_SCHEDULER=on
export REGULAIT_OFFLINE_CHECKS=1
```

Do **not** put `$(openssl rand -hex 32)` in each terminal's export — that mints a different key
per shell, and the failure is delayed and confusing: seeding works, the gateway starts, and then a
connector invoke answers `no_data_key` or fails to decrypt a credential the seed wrote minutes ago.

Three things worth knowing rather than discovering:

- **The gateway migrates on start-up**, so there is no separate migrate step and an empty database
  is the right starting point. `pnpm --filter @regulait/gateway seed` will populate it.
- **`REGULAIT_DATA_KEY` must be the same 64-hex-character value in every terminal and across
  restarts.** It is the AES-256-GCM key for stored credentials; a new key on restart does not
  rotate anything, it makes every stored credential undecryptable. Mint it once, keep it in the
  shell, and **do not write it into a file** — it dies with the session by design.
- **`demo:setup` talks to Postgres directly**, not over HTTP, and already defaults to
  `postgres://regulait:regulait@localhost:5432/regulait`. It does not care that there is no docker.

**What you give up: MinIO, and therefore the WORM anchor.** There is no S3 Object Lock bucket, so
`resolveAnchorSink` falls through to the local buffer (`audit-chain.ts:601-606`) — not to `off`.
The posture page will show the anchor row with a local destination and **`tamperResistant: false`**,
and §2's ceiling drops from 7 of 7 to **6 of 7**. See §2 for how to present that, because it is a
better beat than it sounds.

---

### Why step 3 exists

The seed registers its MCP servers against `http://127.0.0.1:9/` — the discard port — on purpose, so
seeding needs no listener. But `POST /mcp/:serverId` connects upstream at the *top* of the handler,
before any JSON-RPC message is read, so that egress and admission refusals come back as plain HTTP
rather than as protocol errors. Against the discard port every request dies at connect, and the
gateway looks broken rather than governed. `demo:setup` repoints the rows at the real server.

### 1.2 Approve the use case — **the step that is easy to skip and will cost you the demo**

`demo:setup` ends by dispatching as a real user **before and after** applying the preset. On a
first run the second one comes back **`409 use_case_approval_required`**, and that is the script's
own doing: the setup script (`demo-setup.ts` §3b) creates the *Checkout assistant* use case and deliberately leaves it `proposed`,
because driving it to `approved` means walking the pillar-2 intake sign-off and that walk is worth
showing. With `useCaseGateMode=enforcing` a proposal legitimately blocks every dispatch attributed
to its project.

So **as Avery, approve it before you present**, then re-run `demo:setup` and expect `200`. The
script names this case explicitly rather than telling you to stop — the gate is working, and it is
the only refusal in the run that is not one you meant to show.

Any *other* non-`200` on that second dispatch is a real problem: **do not present until it is
green**, because every refusal you then demo will name the first unmet gate rather than the one you
were aiming at.

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

**Confirm the page reads 7 of 7 before you present.** If you cannot, show the unmet rows
deliberately — an honest "here is what this install has not got" lands better than a number nobody
can interrogate.

**On the §1.1 native path the ceiling is 6 of 7, and the missing row is the good one.** With
`REGULAIT_SCHEDULER=on` exported, the scheduler row satisfies; the anchor row cannot, because
without MinIO there is no Object Lock bucket to ask. It will read a **local buffer** with
`tamperResistant: false`, and the control's own text says why: *"A local directory is a buffer,
never WORM."*

That is worth thirty seconds on screen rather than an apology. The point the row makes is the point
the whole product makes: **the grade comes from asking the medium, not from reading the
configuration.** No environment variable can flip that boolean, a GOVERNANCE-mode bucket grades
`false` too, and a competitor's green tick here would mean nothing. Say: *"this install has no WORM
medium, and rather than let me claim one, the product grades itself down."*

If the buyer wants to see the `true` case, that needs docker (`minio` + `minio-init`) or a real S3
Object Lock **COMPLIANCE** bucket. Do not stand one up against a live AWS account for a demo.

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

### (e) The kill switch — worth showing to a security-led buyer   [NEW — ADR-0124]

Not one of the four PoC criteria, and the thing a CISO asks about first. Keep it short:

```
GET /v1/execution                 # what is stopped right now
PUT /v1/execution/mode            # {"mode":"halted","reason":"..."} — a reason is required
```

Three beats, in this order:

1. **Halt one tool, not the business.** Halt the write tool with a reason, retry it (refused,
   `execution-subject-halted`), then call a *read* tool on the same server — still works. That is
   what "per-capability" buys.
2. **Then halt the deployment**, and show that `GET /v1/execution` still answers and the tool list
   is still populated. Say why: an empty list mid-incident looks like revoked access, and a switch
   that locks the door behind you is a worse outage than the one you threw it for.
3. **Lift it** — and note that lifting also requires a reason, because *"why was it safe to
   resume?"* is the question the auditor asks afterwards. Both directions are in the ledger under
   their own rule ids.

Throw it from `/admin → Execution control`, not from curl — the page is the demo. Say plainly the
one thing a technical buyer will find anyway: **nothing trips it automatically.** There is no
"halt if the red-team ASR crosses a threshold" and no dead-man's switch; every position is a
deliberate act by a named operator, which is the right default and still a real limitation.

### (d) Map a use case to a framework with evidence — **do this straight after (b)**

```
GET /v1/use-cases/<id>/frameworks?framework=nist-ai-rmf
```

The active NIST AI RMF pack (v3, subcategory IDs checked against NIST AI 100-1; ADR-0175) with **live
evidence counts**, in one call, for any framework we ship. No longer a two-hop narration.

**The moment worth setting up.** Keep the same screen from (b). The refusal you just demonstrated
*is* the evidence for `nist-ai-rmf:MANAGE-2.4` — "mechanisms are in place to supersede, disengage
or deactivate an AI system". (Packs v1 and v2 filed this under MANAGE-2.2, which in the framework is
sustaining the value of deployed systems; v3 corrects it.) It moves from `unsatisfied` to `satisfied` because a deny landed in
the ledger attributed to this project. So: read the control as unsatisfied, make the refused call,
re-read, watch it go green.

**Make the refused call with the project header** (`x-regulait-project-id`) or it will not count.
That is honest behaviour rather than a trick: an unattributed refusal is not evidence about any
project, and the product declines to pretend otherwise.

Two things to say out loud while it is on screen, because the payload says them:

- **Evidence is collected per project.** The counts cover everything governed in that project, not
  this use case alone. A use case attributed to no project returns nulls, not zeros — "not
  measured" and "measured as none" are different claims.
- **The attestation-required controls stay outstanding.** `GOVERN-4.1` (and GOVERN 2.3, 3.1 and the
  other organisational ones) cannot be observed, and the platform will never count them as satisfied
  on its own say-so. A tool that marked them green would be
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
- **Do not claim the kill switch is automatic.** It is real at all three scopes and it has a UI
  (ADR-0124), but nothing trips it on its own. Say "one operator, one reason, on the record" —
  not "the platform detects and contains".
- **Do not promise SAP.** There is none in the product: nothing on `main`, and one incidental
  comment in a migration header. The claim is about the PRODUCT and it is exact — do not widen it to
  "there is no SAP code anywhere", because an abandoned branch has some (see PENDING D03). Nothing
  on it ships, is tested, or is reachable.
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
| every MCP call returns `502 mcp_upstream_unreachable` | the demo MCP server is not running | restart `demo:mcp`. Since ADR-0126 this is a NAMED, audited refusal naming the server and its URL — it used to be an opaque 500 |
| every MCP call returns `503 mcp_upstream_circuit_open` | five consecutive failures opened the breaker; it is refusing without contacting the upstream | start `demo:mcp`, then wait out the 30s cooldown — the next call probes and closes the circuit by itself. Nothing to reset by hand |
| `MANAGE-2.4` stays `unsatisfied` after a refusal | the refused call carried no `x-regulait-project-id` | repeat it with the header; an unattributed refusal is correctly not counted |
| `docker compose up` fails / no docker daemon | the box has no container runtime | use the §1.1 native-Postgres path; you lose only the WORM anchor |
| `no_data_key`, or stored credentials stop decrypting after a restart | `REGULAIT_DATA_KEY` was unset or regenerated between runs | export the SAME key in every terminal; on the native path a new key means re-seeding, not re-entering credentials |
| posture reads 6 of 7 with the anchor row on a local destination | expected on the §1.1 path — no Object Lock bucket to grade | nothing to fix; present it as §2 describes |

Re-running `demo:setup` is safe at any point. It reads the world back at each step rather than
assuming the previous run landed, and it mints fresh keys for Dana and Avery each time. One
consequence worth knowing: on a re-run the *"before hardening"* dispatch is measured against an
already-hardened deployment, so it reads the same as the *"after"* one. That is the re-run, not a
regression.

---

## 6. Verified

The §1.1 native path was walked end to end on 2026-09-26 — fresh database, `seed`, `demo:mcp`,
`demo:setup`, `start` — and then exercised over HTTP against the running gateway:

| Check | Result |
|---|---|
| `GET /health` | `{"status":"ok","database":"ok"}` |
| `GET /v1/org/posture` | 6 of 7 enforcement controls, the unmet one `auditAnchorTamperResistant` (`settable: false`) |
| `GET /v1/execution` | answers without admin, `mode: normal`, *"Nothing is stopped."* |
| `tools/list` as Dana, real MCP protocol | `["list_branches","read_file","write_file"]` — **`search_code` absent**, so her per-user revocation is enforced in discovery, not just at call time |
| halt `write_file`, then call it | refused, and the message distinguishes an emergency stop from a missing grant |
| `read_file` on the same server while halted | still works — that is what per-capability buys |
| lift the halt | `200` |
| both MCP loopback addresses (`127.0.0.1`, `127.0.0.2`) | reachable natively, so ADR-0122's host-keyed registry diff still names the right server |

Re-walk this after any change to the seed, the preset or the kill switch. A runbook that has not
been run is a guess — the `openssl rand -base64 32` line that used to be in §1.1 is the proof.
