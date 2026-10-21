# Demo runbook — the seeded and hardened environment

For a **capability demo** driven by us, to a prospective customer. It is not a trial environment and
nothing in it is production: every provider is a mock, every upstream is a loopback double, and every
credential it mints is printed once and dies with the database.

Sections 1-6 describe that local, seeded environment. **§7** adds what the 2026-11-01 demo needs on top: the hosted
dev instance, the real-account discovery sources (read-only scans of a GitLab demo group, a non-production AWS sandbox
account, an Azure subscription and an endpoint device, ADR-0197), and the pre-demo checklist.

---

## 1. Stand it up (about three minutes)

Four terminals, in this order. Steps 2–4 all need the same `DATABASE_URL`,
`REGULAIT_BOOTSTRAP_TOKEN` and `REGULAIT_DATA_KEY`. The gateway (step 5) also needs
`REGULAIT_OFFLINE_CHECKS=1`: there is no CI in the demo, and since AER-047 a workflow check nobody
reports waits for a report unless the gateway declares offline mode — the seeded pipeline templates
then auto-pass their checks, labelled "auto-passed · no report". A database seeded before
2026-10-03 predates that opt-in and must be recreated.

**Database TLS (ADR-0181).** The gateway and every demo script require TLS to Postgres by default.
The demo's Postgres is local and has none, so **every terminal** also exports
`REGULAIT_DATABASE_SSL=disable` — an explicit, visible relaxation: the gateway prints a loud
boot warning and Settings → Enforcement posture shows "database TLS: relaxed". Without it every
step fails at its first query with "The server does not support SSL connections". Docker compose
sets it for the bundled `db` service itself.

**Whole stack in Docker, no pnpm?** §1.3 does steps 1–5 below (and `demo:intake`, `demo:traffic`,
`demo:check`, the export key) inside the containers with one `.env` switch.

**No docker on the demo box?** Skip to §1.1 and come back. Everything from §3 onwards is
identical — the only thing you lose is the WORM anchor, and §2 says exactly what that costs.

```bash
# (1) Postgres. On a laptop, docker compose also gives you the WORM audit anchor — see §2.
docker compose up -d db objectstore objectstore-init

# (2) Seed the playground. Prints the personas' one-time passwords and API keys — KEEP THIS OUTPUT.
pnpm --filter @regulait/gateway seed

# (3) A real MCP server on loopback. LEAVE IT RUNNING for the whole demo.
pnpm --filter @regulait/gateway demo:mcp

# (4) Make it hardened, and check it. Re-runnable; run it again if anything drifts.
#     Also mints an EPHEMERAL demo licence (compliance packs are tier-gated and an
#     unlicensed deployment runs default CLOSED, so criterion (d) needs one), activates
#     the NIST and EU packs, and creates the use case (d) is about.
pnpm --filter @regulait/gateway demo:setup

# (4b) OPTIONAL (ADR-0174) — one password you chose for Ada, Dana, Avery and Morgan (the
#     security lead, the second admin of ADR-0197's addendum) instead of the one-time passwords
#     from (2). It also clears the authenticators the seed enrolled for the two admins, Ada and
#     Morgan (ADR-0181 FX2): each enrols her own at her next sign-in (below). Read from the environment or a 0600 secret file, checked
#     against the password policy, never printed, audited without the password. Runs only
#     AFTER (4): it requires the ephemeral demo licence (4) installs, and refuses with no
#     licence, an expired one, or a customer licence. (demo:prepare runs (4) for you.)
#     Whole stack in docker instead? See §1.3 (REGULAIT_DEMO_LICENSE=1).
read -rs REGULAIT_DEMO_USER_PASSWORD && export REGULAIT_DEMO_USER_PASSWORD
pnpm --filter @regulait/gateway demo:set-passwords && unset REGULAIT_DEMO_USER_PASSWORD

# (5) The gateway itself. HOST=127.0.0.1 binds loopback only — a laptop on a shared
#     network must not expose the plaintext gateway and its bootstrap token (DEMO-01).
HOST=127.0.0.1 REGULAIT_OFFLINE_CHECKS=1 pnpm --filter @regulait/gateway start
```

**Ada and Morgan enrol two-factor once (ADR-0181).** MFA is required for admins by default, and
both are admins. Without `demo:set-passwords` (4b), `seed` has already enrolled both and printed
each one's otpauth URI once in its output: add the two URIs to an authenticator app on the
presenting phone. After (4b), which clears the seed's enrolment, each admin enrols at her next
sign-in: the app shows an enrolment secret, add it to the authenticator and type the 6-digit code. Every later sign-in asks for a code. **Morgan enrols
before her Approve in `/ui/inbox`** (the remediation sign-off, script S3): until she has, `demo:check`
FAILs "1 Remediation plan" and its hint says to sign in as her and enrol. Dana and Avery are not
admins and are not asked. Do this during preparation, not in front of the audience. The API keys
that `seed` and `demo:setup` print expire after 30 days; the keys the intake, traffic, check and
gate scripts mint for their own run expire after one day.

### 1.1 Without docker — a native Postgres path

Docker is not available everywhere this gets demoed (a locked-down laptop, a cloud dev box, a
customer-supplied machine). Nothing in §1 actually needs containers except Postgres and the object
store, and only one of those is load-bearing for the run of show.

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
export REGULAIT_DATABASE_SSL=disable   # local Postgres without TLS (ADR-0181: the default is require)
export REGULAIT_OFFLINE_CHECKS=1
# the scheduler is ON by default since ADR-0181; REGULAIT_SCHEDULER=off switches it off
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

**What you give up: the object store, and therefore the WORM anchor.** There is no S3 Object Lock
bucket, so `resolveAnchorSink` falls through to the local buffer (`audit-chain.ts:601-606`) — not to `off`.
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
first run both come back **`409 use_case_approval_required`**, and that is the script's
own doing: the setup script (`demo-setup.ts` §3b) creates the *Checkout assistant* use case and deliberately leaves it `proposed`,
because driving it to `approved` means walking the pillar-2 intake sign-off and that walk is worth
showing. `useCaseGateMode` is `enforce` by default (ADR-0181), so a proposal legitimately blocks
every dispatch attributed to its project, before the preset as well as after it.

So **as Avery, approve it before you present**, then re-run `demo:setup` and expect `200`. The
script names this case explicitly rather than telling you to stop — the gate is working, and it is
the only refusal in the run that is not one you meant to show.

Any *other* non-`200` on that second dispatch is a real problem: **do not present until it is
green**, because every refusal you then demo will name the first unmet gate rather than the one you
were aiming at.

### 1.3 Everything in Docker — the whole demo, prepared, in one switch (ADR-0174 amendment)

When the whole stack runs under `docker compose` (no pnpm on the box), one switch gives you the
**same prepared demo as §1 / `demo:prepare`**, with nothing else to run but the password step:

1. In the `.env` next to `docker-compose.yml`, add `REGULAIT_DEMO_LICENSE=1`. Only the exact value
   `1` does anything (a Windows CRLF line ending is fine).
2. `docker compose up -d --build --wait` on an empty stack (first time, or after `down -v`). The
   gateway container then does, in order, and prints each step to `docker compose logs gateway`:
   - **export-signing key** for the signed export (beat 3E): made once in the `demo_license_keys`
     volume (`/app/demo-license-keys/export-signing`) and reused; the log shows its path and
     **fingerprint** (what you hand an auditor for `verify-export-bundle.sh --fingerprint`), never
     the key;
   - **demo MCP server** (§1 step 3) in the background inside the container, on 127.0.0.1 and
     127.0.0.2 port 8931, for the life of the container;
   - **seed** — mints (or keeps) the 30-day ephemeral licence that says "NOT A PRODUCTION
     DEPLOYMENT"; only its public key is written, to the same volume;
   - **demo:setup → demo:intake → demo:traffic → demo:check** — packs installed and activated,
     use cases, hardening, governed traffic and alerts, then the dry run. The log ends the prep
     with `19 pass, 0 warn, 0 fail` and `demo prep: complete in …s`;
   - the **gateway**, with `REGULAIT_OFFLINE_CHECKS=1` and the export key set (as §1 step 5).

   `--wait` returns once the gateway answers its health check, i.e. after the prep (about
   30–60 s on a laptop; the first build takes longer). Check it with
   `docker compose logs gateway | grep -E "demo prep|pass, "` (PowerShell:
   `docker compose logs gateway | Select-String "demo prep|pass, "`).
3. Set the password with the bash or PowerShell commands in the README ("Demo with your own
   password (Docker)"). The value goes from your shell into one `docker compose exec` process via
   `-e REGULAIT_DEMO_USER_PASSWORD`. It is never on a command line or in a file.
4. Sign in at `http://localhost:3000/ui` as `admin`, `dana` or `avery`, and go to §1.2. The first
   `admin` sign-in enrols two-factor (see §1).

**Once per database.** The prep steps run only when the database has not been prepared yet: the
marker is the API key `demo:traffic` mints (a row in the database, so it goes with the data).
`docker compose restart gateway`, or `down` / `up` keeping the volumes, logs
`demo prep: this database was already prepared … — prep steps skipped`: no new traffic, no new
alerts, the licence, export key and your password are kept. The demo MCP server, the seed (which
keeps everything) and the gateway run on every start. To prepare from scratch:
`docker compose down -v`, then `up` again (this deletes the demo data and the demo password).

**If a step fails** the log says `*** DEMO PREP FAILED at step <name> (exit <n>)` after that
step's own output, and the gateway **still starts**, so the UI and the log stay reachable. A
failure in demo:setup or demo:intake is retried on the next start (`docker compose restart
gateway`); from demo:traffic on, use `down -v` and `up`. You can re-run the dry run any time
without changing anything: `docker compose exec gateway node apps/gateway/dist/demo-check.js`.

Without the switch (or `SEED_DEMO=1`) the gateway starts empty: no demo users, keys or relaxations
are seeded (ADR-0181), no licence is minted, the gateway reads its default keyring, no MCP server,
export key, offline checks or prep step runs, and `demo:set-passwords` refuses as before. **The switch is demo-only.** `scripts/install.sh` refuses it from the environment or a
`.env`, and its rendered override pins it to `"0"`. The image's start script
(`apps/gateway/docker-start.sh`) also ignores it on a `byoc` / `air_gapped`
`REGULAIT_DEPLOY_MODE`. Since ADR-0181 the switch is itself the explicit demo signal: it seeds
without `SEED_DEMO=1` (which now defaults to `0`), every seed runs with `--seed-demo`, and the
seed refuses a database that has a real admin (anyone outside its own personas).

Verified on 2026-10-05 in real containers (Linux, Docker 29, compose 5.1) with a CRLF `.env`: a
fresh stack prepared itself (19 pass, 0 warn, 0 fail; eu-ai-act and nist-ai-rmf active; the AI
intake linked its EU AI Act controls; a signed audit bundle verified offline against the logged
fingerprint; Dana's `read_file` through the demo MCP was allowed, `search_code` denied and
`write_file` queued for Avery); `restart gateway` and `down` / `up` skipped the prep with the alert
count unchanged and sign-in working; `down -v` / `up` prepared again; the switch off ran none of
it; and an image built from a context with every text file in CRLF (docker-start.sh included)
booted and prepared the same way. The PowerShell commands are written for Docker Desktop but have
**not yet been run on Windows**. Run them once before relying on them.

---

## 2. The controls that are not settable from any API

`demo:setup` reports an overall verdict of **not hardened**. That is correct, not a failure: the
audit anchor, the scheduler and database TLS are resolved from the process environment at start-up,
and an API call cannot set an environment variable. The product reports them with their *observed*
state and refuses to count them on its own say-so.

- **The scheduler** is ON by default since ADR-0181; its row satisfies unless `REGULAIT_SCHEDULER=off`.
- **Database TLS** reads **relaxed** on every local demo: the demo sets `REGULAIT_DATABASE_SSL=disable`
  for its TLS-less local Postgres (§1). That row never satisfies in the demo, by design, and the page
  says "database TLS: relaxed" so nobody mistakes the demo for a hardened install.
- **The audit anchor** satisfies only against a real Object Lock bucket:

```bash
docker compose up -d objectstore objectstore-init   # a REAL S3 Object Lock COMPLIANCE bucket
```

Then restart the gateway and re-read `/admin → Enforcement posture`. The anchor grade comes from
asking the bucket for its Object Lock configuration — a `GOVERNANCE`-mode bucket still grades
**false**, because an administrator holding `s3:BypassGovernanceRetention` defeats it. No flag can
fake it, which is the point and is worth saying out loud.

**Confirm the page reads 7 of 7 before you present.** If you cannot, show the unmet rows
deliberately — an honest "here is what this install has not got" lands better than a number nobody
can interrogate.

**On the §1.1 native path the anchor row is also unmet, and it is the good one.** The scheduler row
satisfies (it is on by default); the anchor row cannot, because
without the object store there is no Object Lock bucket to ask. It will read a **local buffer** with
`tamperResistant: false`, and the control's own text says why: *"A local directory is a buffer,
never WORM."*

That is worth thirty seconds on screen rather than an apology. The point the row makes is the point
the whole product makes: **the grade comes from asking the medium, not from reading the
configuration.** No environment variable can flip that boolean, a GOVERNANCE-mode bucket grades
`false` too, and a competitor's green tick here would mean nothing. Say: *"this install has no WORM
medium, and rather than let me claim one, the product grades itself down."*

If the buyer wants to see the `true` case, that needs docker (`objectstore` + `objectstore-init`) or a real S3
Object Lock **COMPLIANCE** bucket. Do not stand one up against a live AWS account for a demo.

---

## 3. The run of show

### (0) Set the scene — `/admin → Enforcement posture`

One screen that answers *"what is actually enforcing right now?"*. Read the **"what turning it on
refuses"** column aloud; it is the part with the value. Note the two rows marked *set by deployment*
and say why they cannot be switched on from a page.

### (b) Block a policy-violating tool call — *lead with this, it is the strongest*

As **Dana**, against **repo-tools**, over the real MCP protocol, with the transport carrying
`x-regulait-project-id: <demo-project's id>`. MCP attribution is required by default (ADR-0181):
the same client without the header is refused at connect with **`400 mcp_attribution_required`**,
audited, before any entitlement decision. That refusal is worth a sentence of its own.

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

- **Do not credit the hardening preset with blocking unattributed calls.** There are three
  independent attribution switches (the native dispatch, the MCP proxy and the compat edge), and
  since ADR-0181 all three are **on by default**; the preset sets only the native one. An admin can
  relax each one separately, audited. If a technical buyer tries an unattributed MCP tool call, it
  is refused with `mcp_attribution_required`.
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
| `demo:set-passwords` under docker: `no valid demo licence is installed` | `REGULAIT_DEMO_LICENSE=1` is not in the `.env` next to `docker-compose.yml`, or the stack was not re-upped after adding it | add it, `docker compose up -d`, re-run the command (§1.3) |
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

---

## 7. The 2026-11-01 demo: hosted dev instance and real-account discovery (ADR-0197)

This section is for `DEMO_SCRIPT_2026-11-01.md`. Sections 1-6 above still describe the local, seeded environment;
the fallback stack below is prepared the same way. **Every step in this section is pending execution** (M-041)
unless it says otherwise: none of it has been run yet. The infrastructure itself (the AWS sandbox account, the Azure
app registration, the GitLab demo group, the public federation issuer) is Terraform and runbooks written by a
separate lane under `infra/`; the owner runs or approves every apply (ADR-0197 decision 6). Steps that depend on it
point there rather than repeating commands nobody has run.

### 7.1 What runs where

- **Live instance:** the hosted dev instance over public HTTPS (ADR-0197 decision 1). The laptop is only a browser.
  Its database carries the governance seed and the four real discovery sources, and **only real findings**: what the real
  GitLab, AWS and Azure scans and the real endpoint device find (owner, 2026-10-19, ADR-0197 addendum decision 3,
  option A). No seeded discovery dataset. Prepare it from empty with
  `pnpm --filter @regulait/gateway demo:prepare --live`: the same pipeline without either `demo:shadow` phase, with
  `demo:intake --live` (the shipped signature catalogues, not the synthetic SaaS export), ending in
  `demo:check --live`. That check FAILs on any trace of the fictional dataset, and on "1 Real discovery sources" until
  one real source is enabled, so on a fresh database it ends with that one FAIL: add the sources (§7.2) and re-run
  `pnpm --filter @regulait/gateway demo:check --live`. CI runs both on an empty database (`demo.yml`, `demo-live`);
  on the dev instance host this is **pending execution**.
- **Fallback:** the local docker compose stack on the presenting laptop (§1.3), prepared with `demo:prepare` the night
  before (addendum, decision 4), including the seeded discovery dataset (ADR-0197 decision 7). It must pass
  `demo:check` with 0 fail; read the pass count off its output. For the endpoint device to enrol, the stack needs
  `REGULAIT_PUBLIC_URL` and the identity signing key (the `demo:check` hint says so). **Pending execution.**
- **Deploy gate:** `demo:gate` runs live from a terminal on the dev instance host (SSH or Session Manager; addendum,
  decision 2), with the T-24h captured output as the fallback. The command and environment on that host are
  **pending execution** and are written here only once run there.
- **Recording:** a screen recording of one real scan, Discovery sources → Run now → Recent runs → Shadow-AI
  discovery, captured from the live instance. Kept as a local file on the presenting laptop.

### 7.2 Discovery sources on the live instance (pending execution)

Each source is added on `/ui/admin/shadow-ai/discovery-sources` (**Add a source** form → **Add source**; a new source is added turned off), given
a credential (**Add credential** → **Save credential**), then **Enable**d with a step-up. The scanner's API host is
added to the egress allow list first (ADR-0195 decision 8; adding an allow entry is a `settings_relax` step-up).
Target and credential fields, from the code on `main`:

| Source kind (Kind label) | Target (key=value lines) | Scope | Credential |
|---|---|---|---|
| `repo_gitlab` (GitLab repositories) | `namespace=<demo-group>`; optional `baseUrl` (https), `history`, `historyDepth` (`REPO_TARGET_KEYS`) | the repositories as `group/project`, or organisation-level | **static** read-only group access token, scopes `read_api` and `read_repository` (ADR-0197 decision 5). Static is a relaxation: the step-up is asked and the posture page lists it. The repo scanner refuses a federated credential today |
| `cloud_aws` (AWS) | `accountId=<sandbox-account-id>`; optional `stsRegion`, `trailBucket`, `trailBucketRegion`, `trailPrefix`, `federation=oidc` (default) or `principal` | the regions, or organisation-level (every enabled region) | **federated**, public config `roleArn=<read-only role in the sandbox>`. The role trusts the federation issuer (ADR-0195 SD2b; owner decision Q12 keeps the trust mode per source, default OIDC) |
| `cloud_azure` (Azure) | `tenantId=<tenant-id>`; optional `managementGroupId`, `logAnalyticsWorkspaceIds`, `authorityHost` | the subscription ids, or organisation-level (needs `managementGroupId`) | **federated**, public config `tenantId`, `clientId` of the app registration whose federated credential trusts the issuer |
| `endpoint_agent` (RegulAIt endpoint agent) | none: the gateway checks a target only for AWS (`targetProblem`); leave the box empty | tick **Organisation-level scope** (the add form asks for a scope on every kind); fed by uploads, no schedule | none. Enrol the device: **Endpoint agent enrolment** → choose the source → **Token name**, **Device cap (required)**, **Expires in (days, at most 30)** → **Issue enrolment token**, then deliver the enrolment file shown once (root-owned, mode 0600) and run the agent's install step on the device (`agents/endpoint/README.md`) |

Then, on the **Cloud federation** card: **Generate key** → **Turn on with this key** (a step-up). The card says the
issuer needs the deployment's public URL (`REGULAIT_PUBLIC_URL`); its discovery document and key set must be reachable
from AWS and Azure (ADR-0197 decision 3).

Real values (account, tenant, client and group identifiers) are never written into this repository. They live in the
owner's notes and the infrastructure lane's state.

### 7.3 Pre-demo checklist

| When | Check | Status |
|---|---|---|
| T-7d | First real-account round trip done for each source: a run **succeeded**, **Reads** says *all read* or names what it could not read, findings appear | pending execution |
| T-7d | The endpoint agent has reported at least once since enrolment (the `endpoint_agent` source is upload-fed: **Run now** only commits reports the device already uploaded) | pending execution |
| T-7d | The remediation workflow walked once on a rehearsal database as Ada: start → **Finish planning** → **Submit for sign-off** → Morgan's **Review** and **Approve** in `/ui/inbox` (the item opens in the panel on the right; **Approve** is in its pinned foot) | pending execution |
| T-7d | Morgan Reyes (security lead) is an active admin, Ada is the only other admin, and Morgan has enrolled her authenticator (after `demo:set-passwords`, at her next sign-in) | pending execution |
| T-3d | Code freeze held (2026-10-29: only demo-blocker fixes merge, ADR-0197 decision 9); the live instance runs the frozen build | pending execution |
| T-24h | **Run now** on every live source (the endpoint agent's only if the device has reported since); each run **succeeded**; choose the rows S2-S4 walk from the real findings on `/ui/admin/shadow-ai` | pending execution |
| T-24h | On the live database, the chosen finding has **no** remediation workflow yet (S3 creates one). On the fallback, `gitlab:acme-bank-demo/credit-memo-assistant`'s workflow waits on Morgan (`demo:check` "1 Remediation plan" PASS); nobody approved it at rehearsal | pending execution |
| T-24h | The environment S3 types (`staging` on a `demo:prepare`d database) is configured on the live instance | pending execution |
| T-24h | `demo:check --live` on the live instance: 0 fail (no fictional-dataset trace, every real source listed with its last run) | pending execution |
| T-24h | Screen recording of one real scan captured and played back once | pending execution |
| T-24h | Fallback stack on the laptop prepared with `demo:prepare` (the night before); `demo:check` 0 fail; Ada, Avery and Morgan signed in there too, in a separate browser | pending execution |
| T-24h | `demo:gate` run once from the dev instance host terminal; its output captured to `real-gate.txt` as the fallback (the 10-05 fallback step 1) | pending execution |
| T-24h | Neither demo budget alert has fired (AWS USD 40 and Azure USD 10, USD 50 in total; each alerts at 80%, USD 32 and USD 8, `docs/deployment/DEMO_REAL_ACCOUNTS.md`); planted usage still within budget (ADR-0197 decision 4) | pending execution |
| T-1h | Browsers: Profile A (Ada), Profile B (Avery) and Profile C (Morgan) on the live instance, all signed in; the fallback browser signed in to the laptop stack; one spare browser installed | pending execution |
| T-1h | A terminal open on the dev instance host for G3 | pending execution |
| T-1h | Navigation pinned in every profile (**Pin navigation**) | pending execution |
| T-1h | Every browser window at 1440 px wide or more, so the detail drawer (alerts, Inbox items, the remediation plan, the sign-off review) opens beside the page; at 900 px or less it is a modal that hides the page (DEMO_SCRIPT, "Detail drawer") | pending execution |
| T-1h | Themes: the same theme in every profile (user menu, **Switch to dark theme** / **Switch to light theme**), chosen for the room's projector | pending execution |
| T-1h | Ada's and Morgan's authenticators on the presenting phone; the phone charged and silenced | pending execution |
| T-1h | The live instance answers over HTTPS from the venue network (open `/ui` in each profile) | pending execution |
| After | Teardown of the sandbox resources and the Azure deployment, tracked as a follow-up (ADR-0197 consequences) | pending execution |

### 7.4 If something breaks on the day

| Symptom | Cause | Do |
|---|---|---|
| A source's last run reads **failed** with an error code | a credential, trust or egress problem since T-24h | do not debug live: show the previous succeeded run in **Recent runs**, or switch to the fallback stack |
| **Run now** stays *queued* | the worker has not leased the run yet | do not wait on it: the script never runs a scan live |
| The **Cloud federation** card reads *off* | federation was turned off, or the issuer URL is not set | federated cloud runs cannot run; switch to the fallback stack for S1 (its runs are recorded replays; its own card reads *off* by design) |
| Starting the remediation workflow answers *second_approver_unavailable* | no other active admin exists (Morgan missing or deactivated) | switch to the fallback stack; fix the personas after the demo |
| Morgan's **Approve** asks for a code she cannot give | her authenticator was not enrolled after `demo:set-passwords` | switch to the fallback stack; never relax MFA live |
| The remediation panel says **no workflow assigned** | an admin rule replaced the default assignment | link a workflow started another way, or switch to the fallback stack |
| An alert, Inbox item or plan opens over a dimmed page that cannot be clicked | the window is 900 px wide or less, so the detail drawer is a modal | **Close** the panel, widen the window (or zoom out) and open it again |
| The live instance does not load | network or instance failure | play the recording for S1-S2, then the fallback stack on the laptop or the screenshot deck |
