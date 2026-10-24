# Demo runbook — the seeded and hardened environment

For a **capability demo** driven by us, to a prospective customer. It is not a trial environment and
nothing in it is production: every provider is a mock, every upstream is a loopback double, and every
credential it mints is printed once and dies with the database.

Sections 1-6 describe that local, seeded environment. **§7** adds what the 2026-11-01 demo needs on top: the hosted
dev instance, the real-account discovery sources (read-only scans of a GitLab demo group, a non-production AWS sandbox
account and an Azure subscription, plus an imported inventory export of a demo laptop, ADR-0197 and its 2026-10-24
addendum), and the pre-demo checklist.

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

**Whole stack in Docker, no pnpm?** §1.3 runs the full `demo:prepare` order (both `demo:shadow` phases, the seed,
`demo:setup`, `demo:intake`, `demo:traffic`, `demo:check`, the export key) inside the gateway container with two
`.env` lines. **For the laptop fallback use §1.3** (deep scan #522, #29). Do not split the stack (compose `db` plus
`pnpm` on the host): the compose `db` publishes no port to the host, so every host step fails at its first
connection. The commands below are for a host with its own Postgres; §1.1 is the native-Postgres path CI uses.

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
**same prepared demo as §1 / `demo:prepare`**, discovery dataset included, with nothing else to run but the
password step:

1. In the `.env` next to `docker-compose.yml`, add **both** lines. Only the exact value `1` turns the switch on (a
   Windows CRLF line ending is fine). Without the public URL the shadow phase cannot enrol the endpoint device, and
   `demo:check` ends with 1 FAIL ("Endpoint agent: no enrolled device").

   ```
   REGULAIT_DEMO_LICENSE=1
   REGULAIT_PUBLIC_URL=http://localhost:3000
   ```
2. From the repo root, on an empty stack (the prep runs only on an empty database):

   ```bash
   docker compose down -v          # laptop only; never on the dev host (§7.6)
   docker compose up -d --build
   docker compose logs -f gateway  # wait for "demo prep: complete in <n>s", then Ctrl+C
   ```

   The gateway container then does, in order, and prints each step to `docker compose logs gateway`:
   - **export-signing key** for the signed export (beat 3E): made once in the `demo_license_keys`
     volume (`/app/demo-license-keys/export-signing`) and reused; the log shows its path and
     **fingerprint** (what you hand an auditor for `verify-export-bundle.sh --fingerprint`), never
     the key;
   - **demo MCP server** (§1 step 3) in the background inside the container, on 127.0.0.1 and
     127.0.0.2 port 8931, for the life of the container;
   - **the full `demo:prepare` order** (deep scan #522, #1), from the same step list `demo:prepare` uses natively
     (`demo-prepare.js --steps`). The headers appear in this order:

     ```
     === demo prep: identity-key:init ===
     === demo prep: demo:shadow (first-admin setup) ===
     === demo prep: seed ===
     === demo prep: demo:setup ===
     === demo prep: demo:intake ===
     === demo prep: demo:shadow ===
     === demo prep: demo:traffic ===
     === demo prep: demo:check ===
     ```

     The seed runs with `--seed-demo --open-assurance-window` and mints (or keeps) the 30-day ephemeral licence that
     says "NOT A PRODUCTION DEPLOYMENT"; only its public key is written, to the same volume. `demo:check` should end
     **26 pass, 1 warn, 0 fail** (the WARN is `3 Monitor`, listing the active alerts; run `39940181481`, 2026-10-23,
     and the 10-21 rehearsal agree), followed by `demo prep: complete in <n>s`. If a later green `Demo journey` run
     shows different counts, trust the run;
   - the **gateway**, with `REGULAIT_OFFLINE_CHECKS=1` and the export key set (as §1 step 5).

   The prep takes about a minute on a laptop (the first build takes longer). Check it afterwards with
   `docker compose logs gateway | grep -E "demo prep|pass, "` (PowerShell:
   `docker compose logs gateway | Select-String "demo prep|pass, "`).
3. Set the password with the bash or PowerShell commands in the README ("Demo with your own
   password (Docker)"). The value goes from your shell into one `docker compose exec` process via
   `-e REGULAIT_DEMO_USER_PASSWORD`. It is never on a command line or in a file.
4. Sign in at `http://localhost:3000/ui` as `admin`, `dana`, `avery` or `morgan`, and go to §1.2. The first
   `admin` and `morgan` sign-ins enrol two-factor (see §1). The 2026-11-01 script needs `morgan` on this stack too:
   she gives S3's sign-off and acknowledges the AI policy at preparation (§7.3; `DEMO_SECURITY_LEAD` in
   `apps/gateway/src/demo-identity.ts`).

**Once per database.** The prep steps run only when the database has not been prepared yet: the
marker is the API key `demo:traffic` mints (a row in the database, so it goes with the data).
`docker compose restart gateway`, or `down` / `up` keeping the volumes, logs
`demo prep: this database was already prepared … — prep steps skipped`: no new traffic, no new
alerts, the licence, export key and your password are kept. The demo MCP server, the seed (which
keeps everything) and the gateway run on every start. To prepare from scratch:
`docker compose down -v`, then `up` again (this deletes the demo data and the demo password).

**If a step fails** the log says `*** DEMO PREP FAILED at step <name> (exit <n>)` after that
step's own output, and the gateway **still starts**, so the UI and the log stay reachable. If the log instead says
`*** DEMO PREP SKIPPED: this database was started but never fully prepared`, the database has users but never
finished the prep (the start script's reader exits 4). Either way the prep cannot be finished in place, and a
restart does not repair it: run `docker compose down -v`, then `up` again (laptop only: **never `down -v` on the dev
host**, §7.6).

**Re-checking later (deep scan #522, #28).** A bare `docker compose exec gateway node apps/gateway/dist/demo-check.js`
FAILs "3 Evidence" (25 pass, 1 warn, 1 fail) even when the gateway has the export key: `docker-start.sh` exports the
key and licence variables only inside the gateway's own start script, and `demo:check` tests its own process
environment. Read the prep's result from the log instead
(`docker compose logs gateway | grep -E "pass, .* warn, .* fail"`), or re-run the check with the same variables the
start script sets. It reuses the keys already in the volume, prints paths and key ids (never a key) and changes
nothing; the D1 builder ran it against the real start script's paths and got 26/1/0 (#526):

```bash
docker compose exec gateway sh -c '
  export REGULAIT_LICENSE_KEYRING=/app/demo-license-keys REGULAIT_OFFLINE_CHECKS=1 \
         REGULAIT_DEMO_KEY_DIR=/app/demo-license-keys/export-signing
  eval "$(node apps/gateway/dist/demo-export-key.js --env)"
  node apps/gateway/dist/demo-check.js'
```

Compare the counts with the latest green `Demo journey` run (above), not with a number written earlier.

Without the switch (or `SEED_DEMO=1`) the gateway starts empty: no demo users, keys or relaxations
are seeded (ADR-0181), no licence is minted, the gateway reads its default keyring, no MCP server,
export key, offline checks or prep step runs, and `demo:set-passwords` refuses as before. **The switch is demo-only.** `scripts/install.sh` refuses it from the environment or a
`.env`, and its rendered override pins it to `"0"`. The image's start script
(`apps/gateway/docker-start.sh`) also ignores it on a `byoc` / `air_gapped`
`REGULAIT_DEPLOY_MODE`. Since ADR-0181 the switch is itself the explicit demo signal: it seeds
without `SEED_DEMO=1` (which now defaults to `0`), every seed runs with `--seed-demo`, and the
seed refuses a database that has a real admin (anyone outside its own personas).

Verified on 2026-10-05 in real containers (Linux, Docker 29, compose 5.1) with a CRLF `.env`: a
fresh stack prepared itself (`demo:check` with no warning or failure, at a count from before the shadow and
G9 beats; today's expected count is in step 2 above; eu-ai-act and nist-ai-rmf active; the AI
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
`false` too, so a green tick here means a medium answered, not a setting. Say: *"this install has no WORM
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
arguments and it re-queues rather than spending a signature on a payload nobody signed. Say what we do;
do not compare it with any other product (talk-track rule).

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
the fallback stack below is prepared the same way.

**Dates (owner, 2026-10-23, #453).** Two runs use this section: a full **internal run-through on Sun 2026-11-01,
afternoon ET**, and the **external demo on Tue 2026-11-03**. The code freeze stays **Thu 2026-10-29**. Everything here
must be ready for 11-01 and still hold on 11-03. The T-7d, T-24h, T-1h, T-10 min and T-5 min rows of §7.3 apply to
**both** runs (T-7d is 10-25 for the run-through and 10-27 for the demo; T-24h is 10-31 and 11-02). DST ends on
11-01 at 02:00, so both runs are on EST (UTC-5). **Every step in this section is pending execution** (M-041)
unless it says otherwise: none of it has been run yet. The infrastructure itself (the AWS sandbox account, the Azure
app registration, the GitLab demo group, the public federation issuer) is Terraform and runbooks written by a
separate lane under `infra/`; the owner runs or approves every apply (ADR-0197 decision 6). Steps that depend on it
point there rather than repeating commands nobody has run.

### 7.1 What runs where

- **Live instance:** the hosted dev instance over public HTTPS (ADR-0197 decision 1). The laptop is only a browser.
  Its database carries the governance seed and the four real discovery sources (three network scanners and one
  device inventory import source), and **only real findings**: what the real GitLab, AWS and Azure scans and the real
  device's inventory export find (owner, 2026-10-19, ADR-0197 addendum decision 3, option A; device import: owner,
  2026-10-24, ADR-0197 addendum of that date). **No endpoint agent on LIVE** (FS-1): `GET /v1/endpoint-agent/config`
  answers 503 `collection_pack_unavailable` until the signing stage (ADR-0195 SD4g) exists, and the agent's compiled
  keyring is empty, so a real agent never reaches the report stage. The agent stays on the fallback, where its
  reports are seeded. No seeded discovery dataset. Prepare it from empty with `demo:prepare --live`: the same pipeline without
  either `demo:shadow` phase, with `demo:intake --live` (the shipped signature catalogues, not the synthetic SaaS
  export), ending in `demo:check --live`. That check FAILs on any trace of the fictional dataset, and on "1 Real
  discovery sources" until one real source is enabled, so on a fresh database it ends with that one FAIL: add the
  sources (§7.2) and re-run the check. CI runs both on an empty database (`demo.yml`, `demo-live`); on the dev instance
  host this is **pending execution**. On that host every demo command runs inside the gateway container, after the
  gateway environment of §7.6 is in place (the compose `db` publishes no port, and the host has no pnpm):

  ```bash
  # pending execution — on the dev host, in /opt/app, once, on an empty database, BEFORE DEMO_REAL_ACCOUNTS step 2
  sudo docker compose exec gateway node apps/gateway/dist/demo-prepare.js --live
  # after the sources exist and one is enabled (§7.2):
  sudo docker compose exec gateway node apps/gateway/dist/demo-check.js --live
  ```

  - **Once only** (deep scan #522, #15). Each AWS and Azure trust policy names its discovery source's id, so prepare
    LIVE **once, before** `DEMO_REAL_ACCOUNTS.md` step 2 creates the sources. Re-preparing later creates new source ids,
    and every federated run fails until both stacks are re-applied. **Never `docker compose down -v` on the dev host**:
    besides the database it deletes `caddy_data` (the ACME certificates; Let's Encrypt allows 5 duplicate certificates
    a week), `install_secrets` and the object-store anchors. If the database must be emptied, stop `gateway` and `db`
    and remove only the `pgdata` volume. Rehearse remediation on a different real finding, never by re-preparing.
  - **`staging`** (deep scan #4, owner decision): `demo:prepare --live` creates an audited mock deploy target named
    `demo-staging` (environment `staging`), so a remediation workflow may target that environment, and
    `demo:check --live` asserts it with the beat "1 Remediation environment" (PASS: "'staging' is an accepted
    remediation environment: deploy target 'demo-staging' (mock)"). Detection is unaffected.
  - **Never the demo switch on the live box** (`REGULAIT_DEMO_LICENSE=1`). It runs the non-live intake and writes the
    fictional dataset into the live database, which `demo:check --live` then FAILs ("1 Fictional dataset"), and the
    audit is append-only, so it cannot be removed. The export key and licence keyring come from the override in §7.6.
  - **HSTS** (deep scan #14). The dev host sets `REGULAIT_HSTS` (user data, ADR-0029 amendment), so the gateway treats
    the box as deployed and refuses offline auto-pass. On LIVE the seeded pipeline and deploy workflows rest at
    unreported checks, while on the fallback and in CI they reach blocked or rolled back. S3 is unaffected: its template
    has no check stage. Do not open those pipelines on LIVE in Q&A. Keep HSTS as it is.
  - **Licence** (deep scan #39). `demo:setup` mints a 30-day demo licence with no grace and keeps any valid one. A LIVE
    database prepared from empty on or after 2026-10-05 holds a licence past 11-03; expiry would block expansion
    actions only. After the demo, re-mint when 7 days or less remain.
- **Fallback:** the local docker compose stack on the presenting laptop (§1.3),
  prepared from empty **less than 18 hours before each run** (owner, 2026-10-23: once for 11-01 and again for 11-03),
  including the seeded discovery dataset (ADR-0197 decision 7). High alerts read *SLA due soon* 18 h after they are
  raised and *SLA breached* from 24 h, so a fresher database keeps G5's chips on *on track*, as in the screenshot pack.
  For a 14:00 ET start, prepare no earlier than 20:00 ET the evening before. It must pass `demo:check` with 0 fail;
  compare the counts with the latest green `Demo journey` run (§1.3), not with a number written earlier. For the endpoint device to enrol, the stack needs
  `REGULAIT_PUBLIC_URL` and the identity signing key (the `demo:check` hint says so). **Pending execution.**
- **Deploy gate:** `demo:gate` runs live from a terminal on the dev instance host (addendum, decision 2), with the
  T-24h captured output as the fallback. The host has no SSH (no key pair; only ports 80 and 443 are open), so the
  terminal is a Session Manager shell. The command runs inside the gateway container, kept in a one-line script, with
  the environment `staging` (§7.6). It is **pending execution** on that host.
- **Recording:** a screen recording of one real scan, Discovery sources → Run now → Recent runs (open its folded
  header first: it starts folded on a first visit) → Shadow-AI discovery, captured from the live instance. Kept as a local file on the presenting laptop.

### 7.2 Discovery sources on the live instance (pending execution)

Each source is added on `/ui/admin/shadow-ai/discovery-sources` (**Add a source** form → **Add source**; a new source is added turned off), given
a credential (**More** → **Add credential** → **Save credential**), then **Enable**d with a step-up. The scanner's API host is
added to the egress allow list first (ADR-0195 decision 8; adding an allow entry is a `settings_relax` step-up).
Target and credential fields, from the code on `main`:

| Source kind (Kind label) | Target (key=value lines) | Scope | Credential |
|---|---|---|---|
| `repo_gitlab` (GitLab repositories) | `namespace=<demo-group>`; optional `baseUrl` (https), `history`, `historyDepth` (`REPO_TARGET_KEYS`) | the repositories as `group/project`, or organisation-level | **static** read-only group access token, scopes `read_api` and `read_repository` (ADR-0197 decision 5). Static is a relaxation: the step-up is asked and the posture page lists it. The repo scanner refuses a federated credential today |
| `cloud_aws` (AWS) | `accountId=<sandbox-account-id>`; optional `stsRegion`, `trailBucket`, `trailBucketRegion`, `trailPrefix`, `federation=oidc` (default) or `principal` | the regions, or organisation-level (every enabled region) | **federated**, public config `roleArn=<read-only role in the sandbox>`. The role trusts the federation issuer (ADR-0195 SD2b; owner decision Q12 keeps the trust mode per source, default OIDC) |
| `cloud_azure` (Azure) | `tenantId=<tenant-id>`; optional `managementGroupId`, `logAnalyticsWorkspaceIds`, `authorityHost` | the subscription ids, or organisation-level (needs `managementGroupId`) | **federated**, public config `tenantId`, `clientId` of the app registration whose federated credential trusts the issuer |
| `endpoint_inventory` (MDM/EDR inventory export) | none: leave the box empty | tick **Organisation-level scope**; fed by uploads, no schedule | none. No egress entry either: nothing is fetched. The import is described below the table |
| `endpoint_agent` (RegulAIt endpoint agent) | **Not on LIVE** (owner, 2026-10-24, FS-1): the gateway serves no signed collection pack yet, so an enrolled agent backs off at its config call and never reports. Fallback only, where the reports are seeded | — | — |

**The device inventory import (pending execution).** The agentless endpoint path of FS-1: a software inventory export
of a real demo laptop we own, imported through `POST /v1/discovery/sources/:sourceId/endpoint-imports`
(`apps/gateway/src/endpoint-import-routes.ts`, ADR-0195 SD3).
1. The file: CSV or JSON with at least a device column and an application-name column; version, publisher, user, OS
   and observed-at columns are optional. Headers are inferred from common names (for example `hostname`,
   `application`, `version`, `publisher`, `user`, `os`, `last_seen`) and inference **refuses on ambiguity**; an explicit
   mapping goes in the card's **Inventory configuration** box (`packages/shared/src/endpoint-discovery/
   inventory-import.ts`). Produce it from the MDM that manages the demo laptop if one does, otherwise from the
   laptop's own installed-software list, and include the AI desktop apps planted on it. It describes a real device:
   never the fallback's dataset (`demo:check --live` FAILs on any of its markers).
2. The match: only applications in the endpoint signature catalogue become findings; `demo:prepare --live` loads it
   (`demo:intake --live` posts `/v1/discovery/endpoint-signatures/seed`). Device names and users leave only as
   pseudonyms; the raw file is kept only as a digest.
3. On **Import endpoint evidence**: choose the source, the format, the file → **Dry run** (writes only an audit row and
   shows matched and refused rows) → once the matches are the planted apps, **Import** (enabled only when the source
   is enabled). The import opens a discovery run for the source, so it appears in **Recent runs**.
4. The import is a state change on LIVE: do it at T-7d (first) and T-24h (refresh), never on stage and never on 11-01.

Then, on the **Cloud federation** card: **Generate key** → **Turn on with this key** (a step-up). The card says the
issuer needs the deployment's public URL (`REGULAIT_PUBLIC_URL`); its discovery document and key set must be reachable
from AWS and Azure (ADR-0197 decision 3).

Real values (account, tenant, client and group identifiers) are never written into this repository. They live in the
owner's notes and the infrastructure lane's state.

### 7.3 Pre-demo checklist

Every row is **pending execution** unless it says otherwise. A **T-** row applies to **both** runs: the internal
run-through (Sun 11-01, afternoon ET) and the external demo (Tue 11-03). Do it once for each, against that run's start
time. Rows marked *once* are done a single time for both. The recipes the rows name are in §7.6.

| When | Check | Status |
|---|---|---|
| Before Sun 10-25, *once* | **Power schedule off** (deep scan #2, owner): the owner applies `power_schedule_enabled = false` in `infra/environments/regulait-dev-app` and confirms that both EventBridge schedules, `regulait-dev-app-start` and `regulait-dev-app-stop`, read **DISABLED** (§7.6). By default the box runs only 08:00-20:00 ET Mon-Fri, so it would be off from Fri 10-30 20:00 to Mon 11-02 08:00. If the plan shows a `user_data` change, the apply stops and starts the box: run it outside rehearsal hours | pending execution — owner |
| Before Thu 10-29, *once* | **Both hosts on post-#508 main** (deep scan #38, owner): update the dev host and the presenting laptop to `main` after #508 (Postgres and Keycloak pinned by digest), run `docker compose pull` while online, then prepare and check (LIVE: §7.1 once; laptop: a trial `demo:prepare`). Close long-running `psql` sessions on the dev host first: the first boot after an update builds an audit index concurrently and stops with `ConcurrentIndexBlockedError` if it cannot get its locks within 60 s (#43). **No `pull` during the freeze**; hold #521 until after the demo | pending execution — owner |
| Before Thu 10-29, *once* | **Live gateway environment** (deep scan #6, owner): the export-signing key, its id and `REGULAIT_LICENSE_KEYRING` added to the dev host's `docker-compose.override.yml`, gateway recreated (§7.6). **Never the demo switch on the live box** | pending execution — owner |
| Before Thu 10-29, *once* | **Branch rule on main** (deep scan #51, owner): require `ci.yml`'s `build-and-test` check on `main` for the freeze, with an admin bypass for docs-only PRs; remove it after 11-03 | pending execution — owner |
| *Once*, before `DEMO_REAL_ACCOUNTS.md` step 2 | `demo:prepare --live` on the dev host from empty, through `docker compose exec` (§7.1). It creates the mock deploy target `demo-staging` (environment `staging`) | pending execution — owner |
| Now, then after the freeze dispatch | **Offline deck** (deep scan #20): rebuild it from the `demo-screens` artifact of run `39940181481` (artifact `12497390750`, kept until 11-22) with `node apps/web/e2e/fallback-deck.mjs --pack 2026-11-01 --dark --no-gate`. After the freeze-SHA dispatch below, rebuild it from that run's artifact with `--gate <path to real-gate.txt>` in place of `--no-gate` (31 slides) | pending execution |
| Thu 10-29, *once* | **Freeze-SHA dispatches** (deep scan #21, owner): dispatch `demo.yml`, `ci.yml` and `ui-enterprise.yml` on `main` at the freeze SHA; record each run id and the SHA in §7.5. The 10-21 rehearsal's gate artifact expires 2026-10-28 15:06Z; the freeze dispatch replaces it | pending execution |
| T-7d | **Power schedule still off**: both schedules still read **DISABLED** (§7.6) | pending execution — owner |
| T-7d | First real-account round trip done for each source: a run **succeeded**, **Reads** says *all read* or names what it could not read, findings appear | pending execution |
| T-7d | **Device inventory import** (FS-1, owner 2026-10-24): the `endpoint_inventory` source exists and is enabled; the demo laptop's export has a **Dry run** that matches the planted AI apps and refuses nothing unexpected, then one **Import**; its run reads *succeeded* in **Recent runs** and the device finding (*Endpoint inventory*) is on `/ui/admin/shadow-ai` (§7.2). No endpoint agent is enrolled on LIVE | pending execution |
| T-7d | **Audit anchor on LIVE** (scan Q12, owner 2026-10-24): signed in as Ada, `GET /v1/audit/verify` on the live instance; note whether the anchor reads tamper-resistant and that at least one anchor has been written. If not, brief the presenter for G8 with the §2 "graded down honestly" line (*"this install has no WORM medium, and rather than let me claim one, the product grades itself down"*) rather than avoiding the folded panels | pending execution |
| T-7d | The remediation workflow walked once on a rehearsal database as Ada: start → **Finish planning** → **Submit for sign-off** → Morgan's **Review** and **Approve** in `/ui/inbox` (the item opens in the panel on the right; **Approve** is in its pinned foot) | pending execution |
| T-7d | Morgan Reyes (security lead) is an active admin, Ada is the only other admin, and Morgan has enrolled her authenticator (after `demo:set-passwords`, at her next sign-in) | pending execution |
| T-7d (prep) | **Morgan's AI policy** (deep scan #32): sign in as Morgan on **both** stacks and press **Acknowledge** on the AI-policy gate, not **Not now**. "Not now" lasts only for that browser session and leaves a banner on every page, which would show on her Inbox in S3. `demo:check` covers this only for Ada, Dana and Avery | pending execution |
| T-7d (prep) | **S4 Link stack pairing** (owner, #453, lane D4 #527). Seed data: the credit-memo finding links to the seeded agent `claude-opus` and the vendor `Anthropic · approved`, on FALLBACK and on a LIVE finding with matching SDK evidence; that agent's model card has no sign-off, so G1's **Stack** tab shows **Not signed off**. For a LIVE finding from another provider, use that provider's matching unsigned pair from the governance seed. Check on LIVE that nobody has signed off that model card (agent's model card shows **Not signed off**); repeat at T-24h before each run | pending execution |
| T-7d | **G1 "Found by discovery"** (lane D4, #527): on the fallback, after S4, the use case's header shows the **Found by discovery** chip, *discovery* opens the Shadow-AI **Findings** tab for Ada, and the finding's row reads *"Registered as <use case>"* | pending execution |
| T-7d | **G3 ALLOW** rehearsed on the fallback database (§7.5 owner step 1, with `staging`) | pending execution |
| T-3d | Code freeze held (2026-10-29: only demo-blocker fixes merge, ADR-0197 decision 9); the live instance runs the frozen build. Freeze notes: §7.7 | pending execution |
| T-24h | **Run now** on the three live network sources; each run **succeeded**. Re-import the demo laptop's inventory export (**Dry run**, then **Import**; §7.2) so its run is fresh. Choose the rows S2-S4 walk from the real findings on `/ui/admin/shadow-ai`, and fill in the 11-03 S3 plan text in `DEMO_PRESENTER_NOTES_2026-11-01.md` with the chosen repository and path | pending execution |
| T-24h | **E. Enforce it** (FS-8, owner 2026-10-24 and #453 comment 6387779914): on the stack the beat runs on (FALLBACK before 11-01, LIVE before 11-03), `/ui/admin/simulation` as Ada answers Dana · `repo-tools` · `search_code` with **deny** and `write_file` with **require approval** naming Avery. Each question writes one advisory audit row and nothing else. The beat is a *simulated decision* on both dates; it does not need the demo MCP server, so there is no MCP-server check (DEMO_SCRIPT E) | pending execution |
| T-24h | On the live database, the chosen finding has **no** remediation workflow yet and has **not** been registered as a use case (S3 and S4 each use it up: LIVE allows one workflow per finding, and one finding is one use case, ever; a second registration is refused 409). On 11-01 S3 and S4 run on the fallback, so the LIVE finding is chosen for 11-03. On the fallback, `gitlab:acme-bank-demo/credit-memo-assistant`'s workflow waits on Morgan (`demo:check` "1 Remediation plan" PASS); nobody approved it at rehearsal | pending execution |
| T-24h | `staging` is accepted on the live instance: `demo:check --live` shows "1 Remediation environment" PASS | pending execution |
| T-24h | **Re-run `demo:traffic` on LIVE, only that step** (deep scan #8, owner): the monitor counts off-stack serving and trace evaluation over **7 days** and resolves alerts that clear, so traffic made at prepare time no longer holds G3's second BLOCK line. Rehearse the re-run on a copy of the database first (once). Then, on LIVE: `sudo docker compose exec gateway node apps/gateway/dist/demo-traffic.js`, after the T-24h scans | pending execution |
| T-24h | **Capture `real-gate.txt`** after that traffic re-run (deep scans #5, #8, #11): run the G3 script (§7.6) with `staging` and copy its output to `real-gate.txt` on the presenting laptop. Expect `DENY "Real-Time Fraud Detection Engine" (approved, EU AI Act tier high) → staging` with two `BLOCK open_high_alert` lines. Do **not** acknowledge the alerts on LIVE at this check | pending execution |
| T-24h | **Signed export on LIVE** (deep scan #6, owner): `GET /v1/exports/signing-key` (signed in as Ada) reports `configured: true`, and one **Download signed bundle** on `/ui/admin/audit` as Ada succeeds | pending execution |
| T-24h | **S4 model card still unsigned on LIVE** (owner, #453): the agent chosen for S4's **Link stack** shows **Not signed off** on its model card | pending execution |
| T-24h | `demo:check --live` on the live instance (§7.1): 0 fail (no fictional-dataset trace, every real source listed with its last run) | pending execution |
| T-24h | Screen recording of one real scan captured and played back once | pending execution |
| T-24h | **Offline deck** opened on the presenting laptop with the network off: 31 slides (30 with `--no-gate`), S1 to G10 in script order | pending execution |
| T-24h, under 18 h before the start | **Gateway health on the laptop** (FS-37): after the prep has finished, `docker compose ps` shows the gateway **(healthy)**. During the prep it can read *unhealthy* on a slow laptop (the healthcheck's `start_period` is 90 s and does not cover the in-container prep); that is cosmetic, but present only once it reads healthy | pending execution |
| T-24h, under 18 h before the start | Fallback stack on the laptop prepared from empty (§1.3, with both `.env` lines); `demo:check` 0 fail, counts as in the latest green `Demo journey` run (re-check: §1.3); Ada, Avery and Morgan signed in there too, in a separate browser. Re-prepare it for 11-03: on 11-01 every state-changing beat runs on it (§7.3 "Between the runs") | pending execution |
| T-24h | F28: the laptop stack's **running gateway** has `REGULAIT_PUBLIC_URL` set, not only the `demo:prepare` step (the Cloud federation card then does not say the public URL is not configured; CI sets it only on the prepare step, so the screenshot pack shows that line) | pending execution |
| T-24h | Neither demo budget alert has fired (AWS USD 40 and Azure USD 10, USD 50 in total; each alerts at 80%, USD 32 and USD 8, `internal/product/DEMO_REAL_ACCOUNTS.md`); planted usage still within budget (ADR-0197 decision 4) | pending execution |
| Morning of each run | **Backup out of the window** (deep scan #13, owner): the dev host's backup timer runs `pg_dump` daily at 17:00 UTC, which is 12:00 EST on both days. Run the backup by hand before the window, stop the timer, and start it again after the run (§7.6) | pending execution — owner |
| T-1h | Browsers: Profile A (Ada), Profile B (Avery) and Profile C (Morgan) on the live instance, all signed in; the fallback browser signed in to the laptop stack; one spare browser installed | pending execution |
| T-1h | **Idle limit** (deep scan #7, owner): a session ends after **30 idle minutes** (the strict default; it is not relaxed for the demo). The only keep-alive is the Inbox's 30-second poll, which pauses while a window is hidden. Profiles signed in at T-1h will have timed out by S3 unless they are refreshed at T-10 min | pending execution |
| T-1h | A Session Manager shell open on the dev host for G3, the G3 script in place, and `real-gate.txt` open in a viewer on the laptop as its fallback (§7.6) | pending execution |
| T-1h | Navigation pinned in every profile (**Pin navigation**) | pending execution |
| T-1h | In each presenting profile, and in the fallback browser on the laptop stack, open the folded sections the script uses once, so they are open on the day: **Recent runs** on Discovery sources (Ada). The fold is remembered per person, page and section in that browser and origin only, so a fresh profile starts with Recent runs, the Inbox's **Recently decided** and Usage events folded | pending execution |
| T-1h | Every browser window at 1440 px wide or more, so the detail drawer (alerts, Inbox items, the remediation plan, the sign-off review) opens beside the page; at 900 px or less it is a modal that hides the page (DEMO_SCRIPT, "Detail drawer") | pending execution |
| T-1h | **Theme** (deep scan #35): the same look in every profile, chosen for the room's projector. Light or dark is the ☾ / ☀ button in the top bar (**Switch to dark theme** / **Switch to light theme**); the palette is on **Account** (`/ui/account`) → **Appearance**. Both are kept per browser, so set them in every profile and in the fallback browser | pending execution |
| T-1h | Ada's and Morgan's authenticators on the presenting phone; the phone charged and silenced | pending execution |
| T-1h | The live instance answers over HTTPS from the venue network (open `/ui` in each profile). The hosts-file line of §7.6 is ready in case the `sslip.io` name does not resolve there | pending execution |
| T-1h | **Presenter brief on SLA chips** (deep scan #13): on LIVE, prepared more than a week earlier, every open high and medium alert reads **SLA breached** (the G5 unowned-agent alert included), and the drawer adds that it was escalated to the admins. Say: "the product escalates overdue alerts". Acknowledging an alert does not stop its clock. Do not relax the SLAs, and do not re-prepare LIVE | pending execution |
| T-10 min | **Sessions** (deep scan #7, owner): in every profile, the fallback browser included, sign in again or bring the window to the front so it is active. Keep the windows tiled and never fully covered, so each stays visible and its poll keeps running | pending execution |
| T-5 min | **G3 shell** (deep scan #12, owner): reconnect the Session Manager shell (`aws ssm start-session`; the 20-minute idle default would close one opened at T-1h before G3) and check the G3 script is still there | pending execution |
| 11-01 run-through | **State-changing beats on FALLBACK only** (owner, 2026-10-23, #453). LIVE is never re-prepared, so anything changed there on 11-01 stays for 11-03 (a re-detected alert keeps its acknowledged status, so an acknowledged G3 alert would turn 11-03's DENY into ALLOW; S3 and S4 each use up their finding, one finding is one use case, ever). On 11-01 these run on the **FALLBACK** laptop stack: G3 acknowledge then ALLOW, G5 resolve, S3 **Start and link** (Ada's live half on the second finding, FS-7), S4 register, and E (Enforce it). **LIVE read-only**: every other beat, plus G3's DENY gate. The per-beat marks are in DEMO_SCRIPT_2026-11-01 (each beat's "11-01 run-through" line) and in "11-01 run-through: where each beat runs" below | decided — owner |
| Between the runs | **`demo:traffic` for 11-03**: re-run it on LIVE again at T-24h before 11-03 (Mon 11-02), after that day's scans, then capture a fresh `real-gate.txt`, so the monitor's 7-day window still holds G3's second BLOCK line on 11-03. The fallback is prepared again from empty, under 18 h before 11-03 | pending execution |
| After 11-03 | **Power schedule back on** (owner): `power_schedule_enabled = true`, plan and apply (`DEMO_TEARDOWN.md` T8). Start the backup timer if it is still stopped | pending execution — post-demo, owner |
| After 11-03 | **Remove the freeze branch rule** on `main` (deep scan #51, owner) | pending execution — post-demo, owner |
| After | Teardown of the sandbox resources and the Azure deployment, tracked as a follow-up (ADR-0197 consequences): [DEMO_TEARDOWN.md](DEMO_TEARDOWN.md) | pending execution — post-demo, owner |


**11-01 run-through: where each beat runs** (owner, 2026-10-23, #453). LIVE is prepared once and never re-prepared.
On 11-01 every step that changes state runs on the FALLBACK laptop stack, so LIVE stays as prepared for 11-03. On
11-03 every beat runs on LIVE as scripted.

| Beat | 11-01 | Why |
|---|---|---|
| Opening, S1, S2 | LIVE read-only | no **Run now**, no federation toggle, no disposition change |
| S3 Plan remediation, **Start and link**, Morgan's **Approve** | FALLBACK: Morgan approves the seeded workflow, then Ada walks **Plan remediation** → **Start and link** → **Finish planning** → **Submit for sign-off** on `gitlab:acme-bank-demo/support-ticket-triage` and Morgan approves again (FS-7) | LIVE allows one workflow per finding; the second finding rehearses the clicks Ada makes live on 11-03 |
| S4 Register as use case | FALLBACK | one finding is one use case, ever (409 on a second) |
| G1 record and risks, G2 independent review | FALLBACK | they work on S4's new use case; **Add risk** and the approval change state |
| E Enforce it | FALLBACK | owner, 2026-10-24; on 11-03 the same Simulation beat runs on LIVE (a simulated decision; it writes only advisory audit rows) |
| G3 step 1, DENY | LIVE read-only | the gate only reads and records the decision |
| G3 steps 2-3, acknowledge then ALLOW | FALLBACK | an acknowledged alert stays acknowledged and would turn 11-03's DENY into ALLOW |
| G4 trust dashboard | LIVE read-only | |
| G5 **Evaluate now**, acknowledge, propose, approve, resolve | FALLBACK | a resolved alert would be gone on 11-03 |
| G7, G8, Close | LIVE read-only | |
| G6, G9, G10 (optional) | LIVE read-only | change nothing |

Answer to the D5 open question ("Between the runs"): the 11-01 acknowledgements and resolutions are done on the
fallback only. Re-run `demo:traffic` on LIVE at T-24h before 11-03 (Mon 11-02), after that day's scans, and capture
`real-gate.txt` again after it.

### 7.4 If something breaks on the day

| Symptom | Cause | Do |
|---|---|---|
| A source's last run reads **failed** with an error code | a credential, trust or egress problem since T-24h | do not debug live: open **Recent runs** from its header if it is folded and show the previous succeeded run, or switch to the fallback stack |
| **Run now** stays *queued* | the worker has not leased the run yet | do not wait on it: the script never runs a scan live |
| The **Cloud federation** card reads *off* | federation was turned off, or the issuer URL is not set | federated cloud runs cannot run; switch to the fallback stack for S1 (its runs are recorded replays; its own card reads *off* by design) |
| Starting the remediation workflow answers *second_approver_unavailable* | no other active admin exists (Morgan missing or deactivated) | switch to the fallback stack; fix the personas after the demo |
| Morgan's **Approve** asks for a code she cannot give | her authenticator was not enrolled after `demo:set-passwords` | switch to the fallback stack; never relax MFA live |
| The remediation panel says **no workflow assigned** | an admin rule replaced the default assignment | link a workflow started another way, or switch to the fallback stack |
| An alert, Inbox item or plan opens over a dimmed page that cannot be clicked | the window is 900 px wide or less, so the detail drawer is a modal | **Close** the panel, widen the window (or zoom out) and open it again |
| The live instance does not load | network or instance failure | play the recording for S1-S2, then the fallback stack on the laptop or the screenshot deck |
| The live instance's name does not resolve (a DNS error such as "server not found", not a TLS or 5xx error) | the venue's DNS filter blocks `sslip.io`, or that wildcard DNS service is down | add the hosts-file line of §7.6 on the presenting laptop and reload; TLS stays valid because the name is unchanged. If it still fails, switch as in the row above |
| A screen is still loading after about 10 seconds | a slow or hung gateway or database: the UI has no request timeout, so a hang shows an endless loading state, not an error (deep scan #27) | do not wait or reload repeatedly: switch at once to the recording or the fallback stack at the same beat. A real error shows with **Retry**, and one press of **Retry** is fine |
| A profile shows the sign-in page | the 30-minute idle limit ended its session (§7.3, T-10 min) | sign in again (Morgan: password and authenticator code); her **Approve** may then ask for the next code. Never relax the session limit live |
| The G3 shell is gone or does not answer | Session Manager closed it on idle | open a new session and run the G3 script; if that takes more than a few seconds, show `real-gate.txt` and say it was captured from a real run (§7.6) |
| **Download signed bundle** shows *"Download failed (409 — export-signing-key-absent)"* | the live gateway was recreated without the §7.6 override | say the export is refused rather than unsigned, and move on; fix the override after the demo. Never set the demo switch on the live box |

### 7.5 Fallback rehearsal record (ADR-0197 decision 7)

The seeded fallback path, rehearsed in CI on 2026-10-21. **What was executed:** one manual dispatch of the `Demo
journey` workflow (`.github/workflows/demo.yml`), run [`39622055370`](https://github.com/dhruvmahendrapatel/RegulAIt/actions/runs/39622055370),
on branch `adr0197-rehearsal-teardown` at `4800bec88cd8917319581c0ca25fce397bfa31ed`. That head is main at
`2722e439fb81e31d553b04b0a4284e11c99fc51d` plus one change to `demo.yml` (the `demo-rehearsal` job below); no product
code differs from main. Every database is an empty CI Postgres; nothing ran on the dev instance host, the presenting
laptop or any real cloud account.

Why a dispatch: `demo.yml` has no `push` trigger, and the API lists **no run of it on `main`** (none on a `main` ref, by
`push` or `workflow_dispatch`). Its pull-request runs test a PR's merge ref, not main's commit; the latest before this
record, run `39613721998` for #478 (head `b586d88`, all jobs green), was not on main's tree.

| Step | Where | Job (id) | Result |
|---|---|---|---|
| `demo:prepare` on an empty database | `demo-rehearsal`, step "demo:prepare, first run" | `119297961420` | pass: every phase ran, `demo:check` 26 PASS, 1 WARN, 0 FAIL |
| `demo:gate` on the fresh database | `demo-rehearsal`, "demo:gate after the first run" | `119297961420` | pass: `DENY "Real-Time Fraud Detection Engine" (approved, EU AI Act tier high) → production` (the default environment then; `demo:gate` now defaults to `staging`), exactly two `BLOCK open_high_alert` lines (the inherited HIGH rating from *Acme Internal AI Platform*; the call served by fast-mock outside the approved stack), `assurance: enforced (mode enforce)`, exit 1 |
| `demo:prepare` again on the **same** database (re-run safety) | `demo-rehearsal`, "demo:prepare, second run" | `119297961420` | pass: exit 0, `demo:check` 26 PASS, 1 WARN, 0 FAIL |
| `demo:check` on its own after the re-run | `demo-rehearsal`, "demo:check after the second run" | `119297961420` | pass: 26 PASS, 1 WARN (`3 Monitor`, 17 active alerts), 0 FAIL |
| `demo:gate` after the re-run | `demo-rehearsal`, "demo:gate after the second run" | `119297961420` | pass: the same DENY and the same two BLOCK lines, exit 1 |
| `demo:gate` **ALLOW** after the two alerts are acknowledged | not in CI | none | **pending execution** (owner rehearsal step 1 below) |
| The real journey (`demo:prepare` → gateway → the seeded-database browser journey and the 2026-11-01 screen pack) | `demo-journey` | `119297961429` | pass |
| `demo:prepare --live` / `demo:check --live` on empty databases | `demo-live` | `119297961561` | pass |

The gate output of both gate steps is the run's `demo-rehearsal-gate` artifact (kept 7 days). The WARN is the same in
every check (`3 Monitor` lists active alerts); it is not a failure.

What the re-run changes. The second `demo:prepare` is accepted (exit 0, 0 FAIL), but it is not a no-op: it adds
traffic and the records derived from it. Between the first and the second check: sightings 617 → 807, active monitor
alerts 16 → 17, trace evaluations 70 → 78 (flagged 1 → 2), trust-dashboard compliance 79% → 83%. The service container's
log shows handled `duplicate key` errors in both prepares: 9 on agent grants during the first run on the empty
database, and 50 on the seed's grant, role, team and project-member inserts during the re-run. Every step still exits
0. So for the demo, prepare the fallback database **once, from empty**, as §7.1 says; a re-run is safe as a repair,
but its numbers differ from the screenshot pack's.

The `demo-rehearsal` job runs only on a manual dispatch, so pull requests are unaffected. Re-run it after any change to
the seed, the dataset or the gate: Actions → `Demo journey` → Run workflow.

**Owner rehearsal steps not covered by CI** (pending execution):

1. **G3 ALLOW.** On the prepared fallback database, as Ada, acknowledge both open high alerts on *Real-Time Fraud
   Detection Engine* (the inherited rating and the served-outside-stack call; the alert titles and where to
   acknowledge them are in DEMO_SCRIPT_2026-11-01 G3), then run
   `pnpm -s --filter @regulait/gateway demo:gate -- "Real-Time Fraud Detection Engine" staging <ref>` (on the compose
   stack: `docker compose exec -T gateway node apps/gateway/dist/demo-gate.js "Real-Time Fraud Detection Engine"
   staging <ref>`) and expect `ALLOW` with two `WARN acknowledged_high_alert` lines (DEMO_SCRIPT_2026-11-01 G3). Use
   `staging`, never `production` (deep scan #11, owner): the environment is only recorded, it does not change the
   decision, and nothing in this demo is production. CI covers the decision rule only in a
   gateway unit test (`apps/gateway/src/zz-adr0161-deploy-gate.test.ts`, "an open high alert on the use case blocks;
   acknowledging it leaves a warning"), not on the demo database. Pending execution.
2. **The laptop stack.** All of the above on the docker compose stack on the presenting laptop (§1.3), less than 18 hours before each run, with `REGULAIT_PUBLIC_URL` and the identity signing key set (§7.1). CI used a Postgres service and node
   directly, not compose. Pending execution.
3. **`demo:gate` on the dev instance host** (G3 live, and the T-24h `real-gate.txt` capture, §7.3), through the G3
   script of §7.6. Pending execution.

**Latest green run of the seeded path, for the expected counts.** `Demo journey` run
[`39940181481`](https://github.com/dhruvmahendrapatel/RegulAIt/actions/runs/39940181481) (2026-10-23, pull request #508;
it tested the merge ref `18a696dc`, which is `main` at `91c507a` plus #508): job `demo-journey` (`120371376649`),
`demo:prepare` then `demo:check` printed `26 pass, 1 warn, 0 fail`; `demo-live` (`120371376826`) passed. Its
`demo-rehearsal` job was skipped (dispatch only), so it has no gate output. Its `demo-screens` artifact
(`12497390750`, kept until 2026-11-22) is the pack of record (`DEMO_SCREENS_QA_2026-11-01.md`).

**Freeze-SHA validation (owner-approved dispatches; deep scan #21, #25).** After the 2026-10-29 freeze, dispatch these
on `main` at the freeze SHA and record them here. `demo.yml` has no `push` trigger, so a dispatch is the only run of
it on `main`. Also dispatch `ci.yml` on `main` once #510 merges, to warm the caches.

| Workflow | Run id | SHA (40 characters) | Result | Notes |
|---|---|---|---|---|
| `demo.yml` (`Demo journey`, all jobs incl. `demo-rehearsal`) | pending execution | pending | pending | copy the `demo-rehearsal-gate` output here; the 10-21 artifact expires 2026-10-28 15:06Z |
| `ci.yml` | pending execution | pending | pending | |
| `ui-enterprise.yml` | pending execution | pending | pending | |

### 7.6 Live host recipes (pending execution)

Everything in this subsection is **pending execution**: written from the code on `main`, not yet run on the dev host.
The owner runs each step. Real values (instance id, IP, account ids) stay in the owner's notes, never here.

**Power schedule (deep scan #2; owner decision).** In `infra/environments/regulait-dev-app`, set
`power_schedule_enabled = false` in the git-ignored `terraform.tfvars`, then plan and apply. `false` keeps both
schedules but disables them; nothing is destroyed and the Elastic IP is untouched. If the plan shows a `user_data`
change, the apply also stops and starts the box: run it outside rehearsal hours. Then confirm both schedules:

```bash
# pending execution — owner
aws scheduler get-schedule --group-name default --name regulait-dev-app-start --query State --output text   # DISABLED
aws scheduler get-schedule --group-name default --name regulait-dev-app-stop  --query State --output text   # DISABLED
```

Emergency fallback if the box is off on a run day: start it by hand (`aws ec2 start-instances --instance-ids
<instance id>`, from `terraform output instance_id`) and allow a few minutes for the stack. After 11-03, set it back to
`true` and apply (`DEMO_TEARDOWN.md` T8).

**Live gateway environment (deep scan #6; owner decision).** The live gateway needs the export-signing key, its id
and the licence keyring. Compose does not forward them, and user data sets only the data key, the bootstrap token and
HSTS. **Never set `REGULAIT_DEMO_LICENSE=1` on the live box** (§7.1).

1. Make the key. Either the demo key, inside the gateway container, on the named volume the gateway already mounts:

   ```bash
   # pending execution — on the dev host, in /opt/app
   sudo docker compose exec -e REGULAIT_DEMO_KEY_DIR=/app/demo-license-keys/export-signing gateway node apps/gateway/dist/demo-export-key.js
   ```

   It prints the key's path and its fingerprint (what an auditor pins), never the key, and reuses the key on later
   runs. It also writes a demo receipt key in the same folder: leave that unused, and do not set the receipt
   variables, because the gateway keeps the receipt key it made on its first boot. Or make the key **off the host**,
   as ADR-0116 and [`infra/export-keys/README.md`](../../infra/export-keys/README.md) describe, and mount it into the
   gateway read-only; the path you then set is the path inside the container.
2. Add three lines to the gateway's `environment:` in `/opt/app/docker-compose.override.yml`. That file was written by
   user data and already holds the data key and the bootstrap token: edit it in place with an editor, and never print,
   copy or commit it. With the demo key from step 1 the lines are:

   ```yaml
   services:
     gateway:
       environment:
         # (the existing lines stay as they are)
         REGULAIT_EXPORT_SIGNING_KEY: /app/demo-license-keys/export-signing/regulait-demo-export.key
         REGULAIT_EXPORT_SIGNING_KEY_ID: regulait-demo-export
         REGULAIT_LICENSE_KEYRING: /app/demo-license-keys
   ```

3. Check the file without printing it, then recreate the gateway:

   ```bash
   # pending execution
   cd /opt/app && sudo docker compose config --quiet && sudo docker compose --profile tls up -d gateway
   ```

4. Then run `demo:prepare --live` and `demo:check --live` through `docker compose exec` (§7.1). `demo:setup` writes the
   licence's public key to `/app/demo-license-keys`, the keyring the gateway now reads. Every `exec` process inherits
   the same variables, so `demo:check` tests what the gateway really has.
5. T-24h check (§7.3): signed in as Ada, `GET /v1/exports/signing-key` answers `configured: true` with key id
   `regulait-demo-export`, and one **Download signed bundle** on `/ui/admin/audit` succeeds.

**G3 terminal and script (deep scans #5, #11, #12; owner decisions).** The host has no SSH, so open a Session Manager
shell from the presenting laptop: `aws ssm start-session --target <instance id>` (the CLI's Identity Center
credentials last 10 hours, so no new sign-in is needed on the day). Session Manager closes a shell after 20 idle
minutes by default, so reconnect at T-5 min. Keep the gate command in a one-line script, made once:

```bash
# pending execution — on the dev host, once
printf '%s\n' '#!/bin/sh' 'cd /opt/app && sudo docker compose exec -T gateway node apps/gateway/dist/demo-gate.js "Real-Time Fraud Detection Engine" staging "${1:-demo-build}"' > ~/g3.sh && chmod +x ~/g3.sh
```

- Run it as `~/g3.sh <ref>`. It runs inside the gateway container, so it uses the container's build and migrations,
  never a host checkout, and the gateway's own `DATABASE_URL`, bootstrap token and data key. Exit 1 is DENY, 0 is
  ALLOW, 2 is a setup error.
- Expected output: the `$ regulait gate deploy … --env staging --ref <ref>` line and a blank line, then `DENY  "Real-Time Fraud Detection Engine" (approved, EU AI Act tier high) → staging`, two
  `BLOCK open_high_alert` lines, then `assurance: …`. After the two alerts are acknowledged (DEMO_SCRIPT G3): `ALLOW`
  with two `WARN acknowledged_high_alert` lines.
- T-24h capture: `~/g3.sh t24h > ~/real-gate.txt; cat ~/real-gate.txt`, then copy the text into `real-gate.txt` on the
  presenting laptop. It holds the decision lines only, no secret. Keep it open in a viewer during the demo as G3's
  fallback.

**Hosts-file line (deep scan #16).** The live URL and the federation issuer are `<a-b-c-d>.sslip.io` names, which rely
on a public wildcard DNS service. If the venue's DNS cannot resolve the name (§7.4), map it to the Elastic IP on the
presenting laptop: the line is `<elastic ip>  <a-b-c-d>.sslip.io`, the same IP written with dots, in `/etc/hosts`
(macOS, Linux; with sudo) or `C:\Windows\System32\drivers\etc\hosts` (Windows; as administrator). TLS stays valid
because the name does not change. It fixes only this laptop's browser; the clouds' fetch of the issuer is not affected,
and no scan runs live. Remove the line after the demo. Keep it written down, not applied, until it is needed.

**Backup timer (deep scan #13; owner decision).** The dev host's backup timer (`regulait-pg-backup.timer`) runs
`pg_dump` daily at 17:00 UTC, which is 12:00 EST on 11-01 and on 11-03. With the power schedule off it runs every day.
Keep it out of both demo windows:

```bash
# pending execution — on the dev host, the morning of each run, well before the window
sudo /usr/local/sbin/regulait-pg-backup.sh --run      # a fresh backup now
sudo systemctl stop regulait-pg-backup.timer          # nothing runs during the run
# after the run:
sudo systemctl start regulait-pg-backup.timer         # Persistent=true runs the missed backup at once
```

`stop` does not disable the timer, so a reboot also re-arms it. See `docs/ops/DB_BACKUP.md` for the status commands.

**Updating the hosts (deep scan #38, #43; owner decision).** Before 10-29, update the dev host and the laptop to
`main` after #508, and run `docker compose pull` while online, so the digest-pinned Postgres and Keycloak images are
present. On the dev host, close any long `psql` session before restarting the stack: the first boot after an update
builds an audit index concurrently and stops with `ConcurrentIndexBlockedError` if it cannot get its locks within
60 s. Then prepare and check. Do not pull again during the freeze.

### 7.7 Freeze notes (owner decisions of 2026-10-23, #453)

- **Bundle ceiling (deep scan #22).** The web entry chunk is about 20 B under its 137.3 kB JS ceiling and about 6 B
  under its 10.6 kB CSS ceiling, so any freeze fix to the kit, the shell or the global styles fails the size gate.
  Pre-approved: a demo-blocker fix may raise the entry JS and CSS ceilings by **at most 1 kB in total** (the two raises added together), recorded in its PR and in
  ADR-0198's +1 kB bundle note. Any other freeze fix stays in lazy chunks.
- **CI time caps (deep scan #25).** A temporary raise of the `spa-journeys` and mock-shard time caps until after
  11-03, recorded in [ADR-0198](../decisions/0198-freeze-week-ci-settings.md) (`spa-journeys` 16 → 25 min, mock UI shards 15 → 25 min). Dispatch `ci.yml` on `main` after any runner-image or Playwright cache
  key change, and once at the freeze SHA (§7.5).
- **Dependency updates (deep scans #17, #26).** Dependabot stays on. Every bump PR is held and reviewed by hand; none
  merges in freeze week unless it is a demo blocker. Runners are queueing: expect 1-2 hours from push to green, and do
  not push several PRs at once on 10-28 and 10-29.
- **Native build memory (deep scan #53).** The gateway's `tsc` step runs out of memory at Node 22's default heap. Build
  with `NODE_OPTIONS=--max-old-space-size=3072` (the Dockerfile already does; README's build lines say so).
