# Demo runbook — the seeded and hardened environment

For a **capability demo** driven by us, to a prospective customer. It is not a trial environment and
nothing in it is production: every provider is a mock, every upstream is a loopback double, and every
credential it mints is printed once and dies with the database.

Sections 1-6 describe that local, seeded environment. **§7** adds what the 2026-10-31 demo (first planned for 11-01) needs on top: the live
instance (since [ADR-0203](../decisions/0203-demo-hosting-after-aws-org-loss.md), the owner's laptop behind a Cloudflare
Tunnel; the hosted AWS dev instance no longer exists), the real-account discovery sources (read-only scans of a GitLab demo group, a non-production AWS sandbox
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

> **Not on the live laptop (owner, 2026-10-29, #453 c6485593621).** Under ADR-0203 the owner's laptop is the live
> instance, prepared from empty with `demo:prepare --live` (§7.6). This switch (`REGULAIT_DEMO_LICENSE=1`) is never set
> there: on an empty database it runs the sample-data prep below, which writes the fictional dataset into the live
> database. This subsection describes the sample-data stack only. On the demo laptop it runs as the **fallback stack** from a
> second checkout, with its own project, database and port (§7.8; owner, 2026-10-29, #453 c6486079064).

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
   docker compose down -v          # a sample-data stack only; never on the live laptop after its one wipe (§7.6)
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
     **26 pass, 2 warn, 0 fail**: one WARN is `3 Monitor`, listing the active alerts (run `39940181481`, 2026-10-23,
     and the 10-21 rehearsal agree); the other is `E External model and agent` until §7.10 is set up (a clean
     `demo:prepare` on `main` at 71e80b1, 2026-10-30). The last line is `demo prep: complete in <n>s`. If a later green `Demo journey` run
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
restart does not repair it: run `docker compose down -v`, then `up` again (sample-data stack only: **never `down -v` on
the live laptop** once `DEMO_REAL_ACCOUNTS.md` step 2 has created its sources, §7.6).

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

## 7. The 2026-10-31 demo: the live instance on the laptop and real-account discovery (ADR-0197, ADR-0203)

This section is for `DEMO_SCRIPT_2026-11-01.md`. Sections 1-6 above still describe the local, seeded environment.

**Live host (ADR-0203; owner, 2026-10-29, #453 c6485593621).** The hosted AWS dev instance (EC2, `/opt/app`, Session
Manager, user data, the `--profile tls` Caddy front door, the power schedule and the backup timer) was deleted with the
July AWS Organization. The live instance is now **the owner's laptop**, running the Docker compose stack behind a
Cloudflare Tunnel (`--profile tunnel`, [TUNNEL.md](../../docs/deployment/TUNNEL.md)) at `https://regulait.<domain>`.
Its database is wiped once and prepared from empty with `demo:prepare --live`, so the laptop is the real-accounts demo
and the sample-data walkthrough is no longer on it. Steps below that only applied to the AWS host are kept, marked
**superseded by ADR-0203**, so that older references still resolve; do not run them.

**Dates (owner, 2026-10-29, #453 c6508111468).** One run uses this section: the **customer demo on Sat 2026-10-31**.
The internal run-through on Sun 11-01 and the external demo on Tue 11-03 (owner, 2026-10-23) are gone. The code freeze
stays **Thu 2026-10-29**. The T-7d, T-24h, T-1h, T-10 min and T-5 min rows of §7.3 are counted from the 10-31 start
time: T-24h is Fri 10-30; T-7d (10-24) has passed, so any T-7d row not yet done is done now, before T-24h. DST ends
on 11-01, so 10-31 is still on EDT (UTC-4). Two owner-approved freeze exceptions are built by other PRs: Claude
through the Anthropic API as the model and the agent, pointed at our MCP endpoint, and the ABAP MCP server behind our
MCP proxy, so a live SAP change runs through governance. **Every step in this section is pending execution** (M-041)
unless it says otherwise: none of it has been run yet. The infrastructure itself (the AWS sandbox account, the Azure
app registration, the GitLab demo group, the public federation issuer) is Terraform and runbooks written by a
separate lane under `infra/`; the owner runs or approves every apply (ADR-0197 decision 6). Steps that depend on it
point there rather than repeating commands nobody has run.

### 7.1 What runs where

- **Live instance:** the owner's laptop, published at `https://regulait.<domain>` through the Cloudflare Tunnel
  (ADR-0203 decision 1; it replaces ADR-0197 decision 1's hosted dev instance). The same laptop presents. It must be on
  and online whenever a cloud fetches the federation issuer, at every scan, and for the run, on the same network as
  the 10-31 demo (ADR-0203 consequences). Its database carries the governance seed and the four real discovery sources (three
  network scanners and one device inventory import source), and **only real findings**: what the real GitLab, AWS and
  Azure scans and the real device's inventory export find (owner, 2026-10-19, ADR-0197 addendum decision 3, option A;
  device import: owner, 2026-10-24, ADR-0197 addendum of that date). **No endpoint agent on LIVE** (FS-1): `GET
  /v1/endpoint-agent/config` answers 503 `collection_pack_unavailable` until the signing stage (ADR-0195 SD4g) exists,
  and the agent's compiled keyring is empty, so a real agent never reaches the report stage. No seeded discovery
  dataset. Prepare it from empty with `demo:prepare --live`: the same pipeline without either `demo:shadow` phase,
  with `demo:intake --live` (the shipped signature catalogues, not the synthetic SaaS export), ending in `demo:check
  --live`. That check FAILs on any trace of the fictional dataset, and on "1 Real discovery sources" until one real
  source is enabled, so on a fresh database it ends with that one FAIL: add the sources (§7.2) and re-run the check. CI
  runs both on an empty database (`demo.yml`, `demo-live`); on the laptop this is **pending execution**. Every demo
  command runs inside the gateway container (`docker compose exec gateway node apps/gateway/dist/<script>.js`), after
  the live environment of §7.6 is in place: the compose `db` publishes no port, and the container's environment is the
  one the gateway has. The full order (override, the one wipe, up, key, prepare, passwords, MFA, check) is §7.6.
  - **Once only** (deep scan #522, #15). Each AWS and Azure trust policy names its discovery source's id, so prepare
    LIVE **once, before** `DEMO_REAL_ACCOUNTS.md` step 2 creates the sources. Re-preparing later creates new source ids,
    and every federated run fails until both stacks are re-applied. **`docker compose --profile tunnel down -v` runs
    exactly once on the laptop**, in §7.6 step 3, before any discovery source exists, and **never again** after
    `DEMO_REAL_ACCOUNTS.md` step 2. Rehearse remediation on a different real finding, never by re-preparing.
  - **`staging`** (deep scan #4, owner decision): `demo:prepare --live` creates an audited mock deploy target named
    `demo-staging` (environment `staging`), so a remediation workflow may target that environment, and
    `demo:check --live` asserts it with the beat "1 Remediation environment" (PASS: "'staging' is an accepted
    remediation environment: deploy target 'demo-staging' (mock)"). Detection is unaffected.
  - **Never the demo switch on the live laptop** (`REGULAIT_DEMO_LICENSE=1`). It runs the non-live intake and writes
    the fictional dataset into the live database, which `demo:check --live` then FAILs ("1 Fictional dataset"), and the
    audit is append-only, so it cannot be removed. The export key and licence keyring come from the local override in
    §7.6.
  - **HSTS** (deep scan #14). On the AWS host user data set `REGULAIT_HSTS`, so the gateway treated the box as deployed
    and refused offline auto-pass. **On the laptop this is an open question for the owner (§7.6, "Open questions"):**
    `docker-compose.yml` does not pass `REGULAIT_HSTS` from `.env` to the gateway, so the `.env` line TUNNEL.md step 3
    asks for does not reach it. Without that signal, a demo step that sets `REGULAIT_OFFLINE_CHECKS=1` for its own process
    (the seed does, `apps/gateway/src/seed.ts`) may auto-pass checks that the AWS host left unreported
    (`offlineAutoPassRefusal`, `apps/gateway/src/workflows.ts`), so the seeded pipeline and deploy workflows on LIVE may
    not rest where they did on the AWS host. Not observed yet: look once after the prepare, and do not open those
    pipelines on LIVE in Q&A. S3 is unaffected: its template has no check stage.
  - **Licence** (deep scan #39). `demo:setup` mints a 30-day demo licence with no grace and keeps any valid one. A LIVE
    database prepared from empty on 2026-10-29 holds a licence past 11-03; expiry would block expansion actions only.
    After the demo, re-mint when 7 days or less remain.
- **Fallback: a second, sample-data compose stack on the laptop** (owner, 2026-10-29, #453 c6486079064). It runs
  from a second checkout of the same commit, so it has its own compose project, database volume and `.env`, and it
  publishes the gateway on `127.0.0.1:3100` instead of `3000`. It has no tunnel and is presented locally. It is
  prepared with the §1.3 switch, which is set in that checkout only, and it never uses the `isolation`, `tunnel` or
  `sso` profiles. Setup, the 18-hour re-prepare and the guard against wiping the wrong stack are in §7.8. Every row
  below that says "FALLBACK" or "the fallback stack" means this stack, at `http://localhost:3100/ui`.
- **Deploy gate:** `demo:gate` runs live from a terminal on the laptop (addendum, decision 2), inside the gateway
  container, with the environment `staging` (§7.6), and the T-24h captured output as the fallback. It is **pending
  execution** on the laptop. (On the AWS host the terminal was a Session Manager shell: superseded by ADR-0203.)
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
| `endpoint_inventory` (MDM/EDR inventory export) | one descriptive line, e.g. `exporter=demo-laptop-export`; not read by the scanner | tick **Organisation-level scope**; fed by uploads, no schedule | none. No egress entry either: nothing is fetched. The import is described below the table |
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
4. The import is a state change on LIVE: do it at T-7d (first) and T-24h (refresh), never on stage.

Then, on the **Cloud federation** card: **Generate key** → **Turn on with this key** (a step-up). The card says the
issuer needs the deployment's public URL (`REGULAIT_PUBLIC_URL`); its discovery document and key set must be reachable
from AWS and Azure (ADR-0197 decision 3).

Real values (account, tenant, client and group identifiers) are never written into this repository. They live in the
owner's notes and the infrastructure lane's state.

### 7.3 Pre-demo checklist

Every row is **pending execution** unless it says otherwise. A **T-** row is counted from the start of the one run,
the customer demo on Sat 10-31 (owner, 2026-10-29, #453 c6508111468). Rows marked *once* are done a single time. The recipes the rows name are in §7.6.

| When | Check | Status |
|---|---|---|
| Before Sun 10-25, *once* | **Power schedule off**: **superseded by ADR-0203** (the EC2 box and its EventBridge schedules no longer exist). Instead: keep the laptop on, awake and online for the run and whenever a cloud must reach the issuer (`DEMO_REAL_ACCOUNTS.md` step 1a) | superseded |
| Before Thu 10-29, *once* | **The laptop on post-#508 main** (deep scan #38, owner): update the laptop's checkout to `main` after #508 (Postgres and Keycloak pinned by digest) and run `docker compose pull` while online, before the §7.6 wipe. The first boot after an update builds an audit index concurrently and stops with `ConcurrentIndexBlockedError` if it cannot get its locks within 60 s (#43): close any `psql` session first. **No `pull` during the freeze**; hold #521 until after the demo. (The dev host half is superseded by ADR-0203.) | pending execution — owner |
| Before Thu 10-29, *once* | **Live gateway environment** (deep scan #6, owner; #453 c6485593621): `REGULAIT_DEMO_LICENSE=1` removed from the laptop's `.env`, and the export-signing key, its id and `REGULAIT_LICENSE_KEYRING` in the laptop's git-ignored local `docker-compose.override.yml`, written before the wipe (§7.6 steps 1-2). **Never the demo switch on the live laptop** | done 2026-10-29 (#453 c6486350055) |
| Before Thu 10-29, *once* | **Branch rule on main** (deep scan #51, owner): require `ci.yml`'s `build-and-test` check on `main` for the freeze, with an admin bypass for docs-only PRs; remove it after 10-31 | pending execution — owner |
| *Once*, before `DEMO_REAL_ACCOUNTS.md` step 2 | The one wipe (`docker compose --profile tunnel down -v`) **done 2026-10-29, never again**, then `demo:prepare --live` from empty, passwords, admin MFA and `demo:check --live` on the laptop, through `docker compose exec` (§7.6 steps 3-8). It creates the mock deploy target `demo-staging` (environment `staging`). Never `down -v` again after step 2 | wipe, prep and passwords done 2026-10-29 (#453 c6486350055); admin MFA and `demo:check --live` pending — owner |
| Now, then after the freeze dispatch | **Offline deck** (deep scan #20): rebuild it from the `demo-screens` artifact of run `39940181481` (artifact `12497390750`, kept until 11-22) with `node apps/web/e2e/fallback-deck.mjs --pack 2026-11-01 --dark --no-gate`. After the freeze-SHA dispatch below, rebuild it from that run's artifact with `--gate <path to real-gate.txt>` in place of `--no-gate` (31 slides) | pending execution |
| Thu 10-29, *once* | **Freeze-SHA dispatches** (deep scan #21, owner): dispatch `demo.yml`, `ci.yml` and `ui-enterprise.yml` on `main` at the freeze SHA; record each run id and the SHA in §7.5. The 10-21 rehearsal's gate artifact expires 2026-10-28 15:06Z; the freeze dispatch replaces it | pending execution |
| T-7d | **Power schedule still off**: **superseded by ADR-0203**. Instead: the laptop's sleep settings keep it awake while plugged in, and the tunnel shows **HEALTHY** (TUNNEL.md, Verify) | superseded |
| T-7d | First real-account round trip done for each source: a run **succeeded**, **Reads** says *all read* or names what it could not read, findings appear | pending execution |
| T-7d | **Device inventory import** (FS-1, owner 2026-10-24): the `endpoint_inventory` source exists and is enabled; the demo laptop's export has a **Dry run** that matches the planted AI apps and refuses nothing unexpected, then one **Import**; its run reads *succeeded* in **Recent runs** and the device finding (*Endpoint inventory*) is on `/ui/admin/shadow-ai` (§7.2). No endpoint agent is enrolled on LIVE | pending execution |
| T-7d | **Audit anchor on LIVE** (scan Q12, owner 2026-10-24): signed in as Ada, `GET /v1/audit/verify` on the live instance; note whether the anchor reads tamper-resistant and that at least one anchor has been written. If not, brief the presenter for G8 with the §2 "graded down honestly" line (*"this install has no WORM medium, and rather than let me claim one, the product grades itself down"*) rather than avoiding the folded panels | pending execution |
| T-7d | The remediation workflow walked once on a rehearsal database as Ada: start → **Finish planning** → **Submit for sign-off** → Morgan's **Review** and **Approve** in `/ui/inbox` (the item opens in the panel on the right; **Approve** is in its pinned foot) | pending execution |
| T-7d | Morgan Reyes (security lead) is an active admin, Ada is the only other admin, and Morgan has enrolled her authenticator (after `demo:set-passwords`, at her next sign-in) | pending execution |
| T-7d (prep) | **Morgan's AI policy** (deep scan #32): sign in as Morgan on **both** stacks and press **Acknowledge** on the AI-policy gate, not **Not now**. "Not now" lasts only for that browser session and leaves a banner on every page, which would show on her Inbox in S3. `demo:check` covers this only for Ada, Dana and Avery | pending execution |
| T-7d (prep) | **S4 Link stack pairing** (owner, #453, lane D4 #527). Seed data: the credit-memo finding links to the seeded agent `claude-opus` and the vendor `Anthropic · approved`, on FALLBACK and on a LIVE finding with matching SDK evidence; that agent's model card has no sign-off, so G1's **Stack** tab shows **Not signed off**. For a LIVE finding from another provider, use that provider's matching unsigned pair from the governance seed. Check on LIVE that nobody has signed off that model card (agent's model card shows **Not signed off**); repeat at T-24h | pending execution |
| T-7d | **G1 "Found by discovery"** (lane D4, #527): on the fallback, after S4, the use case's header shows the **Found by discovery** chip, *discovery* opens the Shadow-AI **Findings** tab for Ada, and the finding's row reads *"Registered as <use case>"* | pending execution |
| T-7d | **G3 ALLOW** rehearsed on the fallback database (§7.5 owner step 1, with `staging`) | pending execution |
| T-3d | Code freeze held (2026-10-29: only demo-blocker fixes merge, ADR-0197 decision 9); the live instance runs the frozen build. Freeze notes: §7.7 | pending execution |
| T-24h | **Run now** on the three live network sources; each run **succeeded**. Re-import the demo laptop's inventory export (**Dry run**, then **Import**; §7.2) so its run is fresh. Choose the rows S2-S4 walk from the real findings on `/ui/admin/shadow-ai`, and fill in the 10-31 S3 plan text in `DEMO_PRESENTER_NOTES_2026-11-01.md` with the chosen repository and path | pending execution |
| T-24h | **E. Enforce it** (FS-8, owner 2026-10-24 and #453 comment 6387779914): on LIVE, and on FALLBACK for the failure fallback, `/ui/admin/simulation` as Ada answers Dana · `repo-tools` · `search_code` with **deny** and `write_file` with **require approval** naming Avery. Each question writes one advisory audit row and nothing else. The *simulated decision* does not need the demo MCP server, so there is no MCP-server check (DEMO_SCRIPT E) | pending execution |
| T-24h, before any E rehearsal | **E. Enforce it: the audited demo relaxation** (owner, #453 c6521685462; QA PR #607 item 1). Under the strict defaults Dana's `write_file` is **refused at queue time** (`approval-quorum-unsatisfiable`), not queued: her `hipaa-project` membership needs 2 approvers, and passkey signing counts only approvers who hold a passkey (no persona does). The fix is demo data, not product defaults: the **sensitive-data approval quorum to 1** and **approval signing off** (plain sign-off). Both are **org-wide** settings (the product has no per-project or per-rule scope for either), so on a demo stack they apply to its one org. Each run writes one `org-settings-updated` audit row naming both keys under *relaxed* (old -> new). **FALLBACK**: a `demo:prepare` from this change applies it in the seed (before Ada enrols TOTP) and prints `RELAXED for beat E`; a FALLBACK prepared earlier needs the LIVE recipe below. Rehearse E on FALLBACK after it. **LIVE** (prepared 10-29 with the older seed, so still strict; to confirm with `demo:check --live`): signed in as Ada on `/ui/admin/organization`, set *Approvers for calls on sensitive data* to 1 and *Tool-call approval signature* to *off*, and confirm the step-up; or, on a build that has it, `REGULAIT_DEMO_ADMIN_PASSWORD=… pnpm --filter @regulait/gateway demo:relax-e` (it signs in as Ada and asks for two authenticator codes, the second a newer one; it refuses a gateway that is not a demo one, and a second run writes nothing). Then `demo:check` row **E Enforce it** reads PASS. Do it once, at T-24h, never on stage | pending execution |
| T-24h | On the live database, the chosen finding has **no** remediation workflow yet and has **not** been registered as a use case (S3 and S4 each use it up: LIVE allows one workflow per finding, and one finding is one use case, ever; a second registration is refused 409). S3 and S4 run on LIVE on 10-31, so the LIVE finding is chosen for that run. On the fallback, `gitlab:acme-bank-demo/credit-memo-assistant`'s workflow waits on Morgan (`demo:check` "1 Remediation plan" PASS); nobody approved it at rehearsal | pending execution |
| T-24h | `staging` is accepted on the live instance: `demo:check --live` shows "1 Remediation environment" PASS | pending execution |
| T-24h | **Re-run `demo:traffic` on LIVE, only that step** (deep scan #8, owner): the monitor counts off-stack serving and trace evaluation over **7 days** and resolves alerts that clear, so traffic made at prepare time no longer holds G3's second BLOCK line. Rehearse the re-run on a copy of the database first (once). Then, on the laptop: `docker compose exec gateway node apps/gateway/dist/demo-traffic.js`, after the T-24h scans | pending execution |
| T-24h | **Capture `real-gate.txt`** after that traffic re-run (deep scans #5, #8, #11): run the G3 script (§7.6) with `staging` and copy its output to `real-gate.txt` on the presenting laptop. Expect `DENY "Real-Time Fraud Detection Engine" (approved, EU AI Act tier high) → staging` with two `BLOCK open_high_alert` lines. Do **not** acknowledge the alerts on LIVE at this check | pending execution |
| T-24h | **Signed export on LIVE** (deep scan #6, owner): `GET /v1/exports/signing-key` (signed in as Ada) reports `configured: true`, and one **Download signed bundle** on `/ui/admin/audit` as Ada succeeds | pending execution |
| T-24h | **S4 model card still unsigned on LIVE** (owner, #453): the agent chosen for S4's **Link stack** shows **Not signed off** on its model card | pending execution |
| T-24h | `demo:check --live` on the live instance (§7.1): 0 fail (no fictional-dataset trace, every real source listed with its last run) | pending execution |
| T-24h | Screen recording of one real scan captured and played back once | pending execution |
| T-24h | **Offline deck** opened on the presenting laptop with the network off: 31 slides (30 with `--no-gate`), S1 to G10 in script order | pending execution |
| T-24h | **Gateway health on the laptop** (FS-37): `docker compose ps` shows the gateway **(healthy)**, and `cloudflared` and `caddy-tunnel` running (TUNNEL.md, Verify) | pending execution |
| T-24h, under 18 h before the start | Fallback stack prepared from empty in the second checkout (§7.8, steps 4–6), then the prep result read from the log as in §7.8 step 6 (never a bare `demo-check.js`), on `http://localhost:3100` | pending execution |
| T-24h | F28: the live gateway has `REGULAIT_PUBLIC_URL` set to `https://regulait.<domain>` (TUNNEL.md step 4), so the Cloud federation card shows the issuer and does not say the public URL is not configured | pending execution |
| T-24h | Neither demo budget alert has fired (AWS USD 40 and Azure USD 10, USD 50 in total; each alerts at 80%, USD 32 and USD 8, `internal/product/DEMO_REAL_ACCOUNTS.md`); planted usage still within budget (ADR-0197 decision 4) | pending execution |
| Morning of 10-31 | **Backup out of the window**: **superseded by ADR-0203** (the dev host's `regulait-pg-backup.timer` no longer exists; the laptop runs no backup timer, so nothing runs in the window) | superseded |
| T-1h | Browsers: Profile A (Ada), Profile B (Avery) and Profile C (Morgan) on the live instance (`https://regulait.<domain>/ui`), all signed in; a fallback browser profile signed in on the fallback stack (`http://localhost:3100/ui`, §7.8); one spare browser installed | pending execution |
| T-1h | **Idle limit** (deep scan #7, owner): a session ends after **30 idle minutes** (the strict default; it is not relaxed for the demo). The only keep-alive is the Inbox's 30-second poll, which pauses while a window is hidden. Profiles signed in at T-1h will have timed out by S3 unless they are refreshed at T-10 min | pending execution |
| T-1h | A terminal open on the laptop in the repository checkout for G3, the G3 script in place, and `real-gate.txt` open in a viewer as its fallback (§7.6) | pending execution |
| T-1h | Navigation pinned in every profile (**Pin navigation**) | pending execution |
| T-1h | In each presenting profile, and in the fallback browser on the laptop stack, open the folded sections the script uses once, so they are open on the day: **Recent runs** on Discovery sources (Ada). The fold is remembered per person, page and section in that browser and origin only, so a fresh profile starts with Recent runs, the Inbox's **Recently decided** and Usage events folded | pending execution |
| T-1h | Every browser window at 1440 px wide or more, so the detail drawer (alerts, Inbox items, the remediation plan, the sign-off review) opens beside the page; at 900 px or less it is a modal that hides the page (DEMO_SCRIPT, "Detail drawer") | pending execution |
| T-1h | **Theme** (deep scan #35): the same look in every profile, chosen for the room's projector. Light or dark is the ☾ / ☀ button in the top bar (**Switch to dark theme** / **Switch to light theme**); the palette is on **Account** (`/ui/account`) → **Appearance**. Both are kept per browser, so set them in every profile and in the fallback browser | pending execution |
| T-1h | Ada's and Morgan's authenticators on the presenting phone; the phone charged and silenced | pending execution |
| T-1h | The live instance answers over HTTPS from the venue network (open `/ui` in each profile) and the tunnel shows **HEALTHY**. (The `sslip.io` hosts-file line is superseded by ADR-0203: the name is on Cloudflare DNS.) | pending execution |
| T-1h | **Presenter brief on SLA chips** (deep scan #13): on LIVE, prepared on 10-29 (about two days before the demo), every open high alert reads **SLA breached** (the G5 unowned-agent alert included) and the drawer adds that it was escalated to the admins; open medium alerts read *SLA on track* or *SLA due soon* (due soon from 54 h, breached at 72 h), so check them at this row. Say: "the product escalates overdue alerts". Acknowledging an alert does not stop its clock. Do not relax the SLAs, and do not re-prepare LIVE | pending execution |
| T-10 min | **Sessions** (deep scan #7, owner): in every profile, the fallback browser included, sign in again or bring the window to the front so it is active. Keep the windows tiled and never fully covered, so each stays visible and its poll keeps running | pending execution |
| T-5 min | **G3 terminal**: the laptop terminal is still open and the G3 script is still there. (Reconnecting a Session Manager shell is superseded by ADR-0203.) | pending execution |
| Sat 10-31 | **Every beat on LIVE, once** (owner, 2026-10-29, #453 c6508111468; it replaces the 11-01 run-through row of 2026-10-23). LIVE is never re-prepared, so a state-changing step (G3 acknowledge then ALLOW, G5 resolve, S3 **Start and link**, S4 register, G1/G2 on S4's use case, E) runs on it only once: at the demo. Rehearse those steps on the **FALLBACK** stack only; FALLBACK stays the failure fallback. The per-beat marks are in DEMO_SCRIPT_2026-11-01 (each beat's "Sat 10-31" line) and in "Sat 10-31: where each beat runs" below | decided — owner |
| Between the runs | **Superseded by the single date** (owner, 2026-10-29): there is one run, so the T-24h row (Fri 10-30) is the only `demo:traffic` re-run and `real-gate.txt` capture, and the fallback is prepared from empty once, under 18 h before 10-31 | superseded |
| After 10-31 | **Power schedule back on**: **superseded by ADR-0203** (no EC2 box). Stop the tunnel when the demo is over (TUNNEL.md, "Stopping and rolling back") | superseded |
| After 10-31 | **Remove the freeze branch rule** on `main` (deep scan #51, owner) | pending execution — post-demo, owner |
| After | Teardown of the sandbox resources and the Azure deployment, tracked as a follow-up (ADR-0197 consequences): [DEMO_TEARDOWN.md](DEMO_TEARDOWN.md) | pending execution — post-demo, owner |


**Sat 10-31: where each beat runs** (owner, 2026-10-29, #453 c6508111468; it replaces the 11-01 run-through table of
2026-10-23). FALLBACK is the second, sample-data stack on the laptop (§7.8, `http://localhost:3100/ui`). LIVE is
prepared once and never re-prepared, so each state-changing step can run on it only once. With one date that once is
the demo: every beat runs on LIVE as scripted, and FALLBACK is the failure fallback and the only place to rehearse.

| Beat | 10-31 | Rehearse before 10-31 on |
|---|---|---|
| Opening, S1, S2 | LIVE read-only | LIVE (read-only: no **Run now**, no federation toggle, no disposition change) |
| S3 Plan remediation, **Start and link**, Morgan's **Approve** | LIVE, on the finding chosen at T-24h | FALLBACK: Morgan approves the seeded workflow, then Ada walks **Plan remediation** → **Start and link** → **Finish planning** → **Submit for sign-off** on `gitlab:acme-bank-demo/support-ticket-triage` and Morgan approves again (FS-7); LIVE allows one workflow per finding |
| S4 Register as use case | LIVE | FALLBACK only: one finding is one use case, ever (409 on a second) |
| G1 record and risks, G2 independent review | LIVE (S4's new use case) | FALLBACK only: **Add risk** and the approval change state |
| E Enforce it | LIVE (a live governed call, ADR-0202) | FALLBACK only |
| G3 step 1, DENY | LIVE | LIVE or FALLBACK: the gate only reads and records the decision |
| G3 steps 2-3, acknowledge then ALLOW | LIVE | FALLBACK only: an acknowledged alert stays acknowledged and would turn the demo's DENY into ALLOW |
| G4 trust dashboard | LIVE read-only | either |
| G5 **Evaluate now**, acknowledge, propose, approve, resolve | LIVE | FALLBACK only: a resolved alert would be gone at the demo |
| G7, G8, Close | LIVE read-only | either |
| G6, G9, G10 (optional) | LIVE read-only | either; change nothing |

The D5 open question ("Between the runs") no longer arises: there is one run. Re-run `demo:traffic` on LIVE at T-24h
(Fri 10-30), after that day's scans, and capture `real-gate.txt` after it.

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
| The live instance does not load | the laptop, its network, the tunnel or Cloudflare | check `docker compose ps` and the tunnel's state in the dashboard (TUNNEL.md, Verify) only if it takes seconds; otherwise play the recording for S1-S2, then the screenshot deck. If only the tunnel is down and the laptop is fine, switch to the fallback stack (`http://localhost:3100/ui`, §7.8) |
| The live instance's name does not resolve (a DNS error such as "server not found", not a TLS or 5xx error) | the venue's DNS filter blocks the name | switch as in the row above. (The `sslip.io` hosts-file workaround is superseded by ADR-0203: a hosts-file line cannot reach a tunnel, which has no public IP of its own) |
| A screen is still loading after about 10 seconds | a slow or hung gateway or database: the UI has no request timeout, so a hang shows an endless loading state, not an error (deep scan #27) | do not wait or reload repeatedly: switch at once to the recording or the fallback stack at the same beat. A real error shows with **Retry**, and one press of **Retry** is fine |
| A profile shows the sign-in page | the 30-minute idle limit ended its session (§7.3, T-10 min) | sign in again (Morgan: password and authenticator code); her **Approve** may then ask for the next code. Never relax the session limit live |
| The G3 terminal is gone or does not answer | the terminal was closed, or Docker is not answering | open a new terminal in the checkout and run the G3 script; if that takes more than a few seconds, show `real-gate.txt` and say it was captured from a real run (§7.6) |
| **Download signed bundle** shows *"Download failed (409 — export-signing-key-absent)"* | the live gateway was recreated without the §7.6 local override (or the key file was not made after the wipe) | say the export is refused rather than unsigned, and move on; fix the override after the demo. Never set the demo switch on the live laptop |

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
2. **The sample-data stack.** All of the above on a docker compose sample-data stack (§1.3), less than 18 hours before
   the run, with `REGULAIT_PUBLIC_URL` and the identity signing key set. CI used a Postgres service and node directly,
   not compose. On the laptop it is the fallback stack in the second checkout (§7.8), with `REGULAIT_PUBLIC_URL` set to
   `http://localhost:3100` (an `http` origin is accepted for localhost only). Pending execution.
3. **`demo:gate` on the live laptop** (G3 live, and the T-24h `real-gate.txt` capture, §7.3), through the G3
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

### 7.6 Live host recipes (steps 1–6 done 2026-10-29; the rest pending execution)

Steps 1–6 were run on the laptop on 2026-10-29 (#453 c6486350055), including **the one wipe, which is never run again**. The steps after them are **pending execution**: written from the code on `main`, not yet run on the laptop.
The owner runs each step. The live host is the owner's laptop (ADR-0203); the order below is the owner decision of
2026-10-29 (#453 c6485593621). Real values (the public name, account ids, keys, passwords) stay in the owner's notes,
`.env` and the password manager, never here.

**Shell.** The tunnel token lives only in the PowerShell session of TUNNEL.md step 4. Run every step below in Git for
Windows' bash **started from that session**, so it inherits the token: `& "$env:ProgramFiles\Git\bin\bash.exe"`, then
`cd` to the repository checkout. In that bash, first run `export MSYS_NO_PATHCONV=1`: without it Git Bash rewrites
container paths such as `/app/demo-license-keys` in `docker compose exec` arguments into Windows paths. On macOS or
Linux, any bash in the checkout works, with the token set as TUNNEL.md describes.

**Steps 1-8 run once, in this order, before `DEMO_REAL_ACCOUNTS.md` step 2.** Stop and report on any failure; do not
improvise around it (c6485593621).

1. **`.env`: no demo switch.** Remove the `REGULAIT_DEMO_LICENSE=1` line from the laptop's `.env` with an editor (it
   makes the container run the sample-data prep on an empty database, §7.1). Then check, without printing the file:

   ```bash
   # done on the laptop 2026-10-29 (#453 c6486350055)
   grep -c '^REGULAIT_DEMO_LICENSE' .env    # 0
   grep -c '^REGULAIT_PUBLIC_URL=https://' .env   # 1: the tunnel URL of TUNNEL.md step 4
   ```

2. **The local override.** Compose merges a `docker-compose.override.yml` next to `docker-compose.yml` into every
   command. The repository's `.gitignore` does **not** list that name, so first make git ignore it on this checkout only
   (`.git/info/exclude` is local and never committed), then confirm:

   ```bash
   # done on the laptop 2026-10-29 (#453 c6486350055)
   test -e docker-compose.override.yml && echo "an override already exists: stop and report" || echo "none yet"
   echo 'docker-compose.override.yml' >> .git/info/exclude
   git check-ignore -q docker-compose.override.yml && echo ignored    # must print "ignored"
   ```

   Then write the file. The three export-signing and keyring lines are the ones c6485593621 names. The data key and
   the bootstrap token are generated into the file and never shown: `docker-compose.yml` otherwise falls back to the
   published development values (`REGULAIT_DATA_KEY` of 64 `a`, `REGULAIT_BOOTSTRAP_TOKEN=dev-bootstrap`), a full-admin
   credential anyone with the repository knows (`apps/gateway/src/dev-secrets.ts`), and the AWS host's override held
   real values for both. They must be in place before the wipe in step 3, because the data key encrypts the stored
   credentials. If `.env` already sets either name to a real value, the override's value wins for the gateway.

   ```bash
   # done on the laptop 2026-10-29 (#453 c6486350055); — writes secrets into the file; prints nothing
   ( umask 077
     { printf '%s\n' 'services:' '  gateway:' '    environment:'
       printf '      REGULAIT_DATA_KEY: "%s"\n' "$(openssl rand -hex 32)"
       printf '      REGULAIT_BOOTSTRAP_TOKEN: "%s"\n' "$(openssl rand -hex 24)"
       printf '%s\n' \
         '      REGULAIT_EXPORT_SIGNING_KEY: /app/demo-license-keys/export-signing/regulait-demo-export.key' \
         '      REGULAIT_EXPORT_SIGNING_KEY_ID: regulait-demo-export' \
         '      REGULAIT_LICENSE_KEYRING: /app/demo-license-keys'
     } > docker-compose.override.yml )
   docker compose --profile tunnel config --quiet && echo "compose config ok"
   git status --short docker-compose.override.yml    # prints nothing
   ```

   Never print, copy, paste or commit the file (`config` without `--quiet` prints it, and the tunnel token with it;
   TUNNEL.md step 4). Losing it loses the data key: keep the laptop's checkout until the demo is over. Do not add the
   receipt-key variables: with none set, the gateway's first boot makes its own receipt key (`docker-compose.yml`,
   ADR-0189 R25).

3. **The one wipe. Done on 2026-10-29; never run it again.** It was allowed then only because no discovery source or
   trust policy existed yet:

   ```bash
   # DONE 2026-10-29 (#453 c6486350055). Do NOT run it again: it was the one wipe
   docker compose --profile tunnel down -v
   ```

   It deletes every compose volume: the database, the demo keyring volume, the install secrets and the audit-anchor
   objects. `.env`, the override and the tunnel token (a shell variable) survive it.

4. **Bring the stack up:**

   ```bash
   # done on the laptop 2026-10-29 (#453 c6486350055)
   docker compose --profile tunnel up -d --build
   docker compose ps    # gateway (healthy), cloudflared and caddy-tunnel running
   docker compose logs gateway | grep -c "demo prep"    # 0: no sample-data prep ran
   ```

   A `demo prep` line means the switch is still set somewhere (the `.env` or the session): stop and report, before
   any further step.

5. **The export-signing key**, inside the gateway container, on the keyring volume step 3 recreated:

   ```bash
   # done on the laptop 2026-10-29 (#453 c6486350055)
   docker compose exec -e REGULAIT_DEMO_KEY_DIR=/app/demo-license-keys/export-signing gateway node apps/gateway/dist/demo-export-key.js
   ```

   It prints the key's path and its fingerprint (what an auditor pins), never the key, and reuses the key on later
   runs. It also writes a demo receipt key in the same folder: leave that unused. The gateway reads the key file at
   each signed export (`resolveExportSigningKey`, `apps/gateway/src/export-bundle.ts`), so no restart is needed. Or
   make the key **off the laptop**, as ADR-0116 and [`infra/export-keys/README.md`](../../infra/export-keys/README.md)
   describe, mount it into the gateway read-only in the override, and set the path inside the container instead.

6. **Live prep:**

   ```bash
   # done on the laptop 2026-10-29 (#453 c6486350055)
   docker compose exec gateway node apps/gateway/dist/demo-prepare.js --live
   ```

   It runs seed → `demo:setup` → `demo:intake --live` → `demo:traffic` → `demo:check --live`
   (`apps/gateway/src/demo-prepare-steps.ts`). `demo:setup` writes the licence's public key to `/app/demo-license-keys`,
   the keyring the gateway reads through the override, and every `exec` process inherits the same variables, so
   `demo:check` tests what the gateway really has. Expect exactly **one FAIL, "1 Real discovery sources"**, until a
   source is enabled (§7.1). Any other FAIL: stop and report.

7. **Passwords and admin MFA.** The password goes from a hidden prompt into one `docker compose exec` process and is
   never on a command line or in a file (README, "Demo with your own password (Docker)"):

   ```bash
   # pending execution
   printf 'Demo password: '; read -rs REGULAIT_DEMO_USER_PASSWORD; echo
   export REGULAIT_DEMO_USER_PASSWORD
   docker compose exec -e REGULAIT_DEMO_USER_PASSWORD gateway node apps/gateway/dist/demo-set-passwords.js
   unset REGULAIT_DEMO_USER_PASSWORD
   ```

   It also clears the authenticators of the two admins, `admin` and `morgan`, and their lockouts (c6485284493). Then,
   in a **new private browser window** (not an older tab), sign in at `https://regulait.<domain>/ui` as `admin` →
   **Generate enrollment secret** → scan it on the presenting phone → activate. Repeat for `morgan` in another new
   private window. If the "Two-step verification: enter the 6-digit code" screen appears instead of the enrolment
   screen, stop and post the output of the audit query in #453 c6485284493 step 4.

8. **Check:**

   ```bash
   # pending execution
   docker compose exec gateway node apps/gateway/dist/demo-check.js --live
   ```

   On a database with no source yet, it ends with the same single FAIL as step 6. Continue with
   `DEMO_REAL_ACCOUNTS.md` step 1b (federation on), step 2 (the four sources, created disabled; copy their ids) and
   step 4 (the `demo-sandbox/aws` plan, shown to the owner before any apply). After one source is enabled
   (`DEMO_REAL_ACCOUNTS.md` step 7), run step 8 again: 0 FAIL, and post the result on #453.

**From here on, never `docker compose --profile tunnel down -v`** (§7.1, "Once only"). `docker compose --profile
tunnel down`, `up -d` and `restart gateway` keep the volumes. If the gateway is recreated, the override comes with it;
check it with `docker compose --profile tunnel config --quiet` before `docker compose --profile tunnel up -d gateway`.

**T-24h signed-export check** (§7.3): signed in as Ada, `GET /v1/exports/signing-key` answers `configured: true` with
key id `regulait-demo-export`, and one **Download signed bundle** on `/ui/admin/audit` succeeds.

**G3 terminal and script (deep scans #5, #11, #12; owner decisions).** A terminal on the laptop, in the checkout, in
the bash described under **Shell**. Keep the gate command in a one-line script outside the checkout, made once:

```bash
# pending execution — in the checkout, once
printf '#!/bin/sh\ncd %s && docker compose exec -T gateway node apps/gateway/dist/demo-gate.js "Real-Time Fraud Detection Engine" staging "${1:-demo-build}"\n' "'$PWD'" > ~/g3.sh && chmod +x ~/g3.sh
```

- Run it as `~/g3.sh <ref>`. It runs inside the gateway container, so it uses the container's build and migrations,
  never a host checkout, and the gateway's own `DATABASE_URL`, bootstrap token and data key. Exit 1 is DENY, 0 is
  ALLOW, 2 is a setup error.
- Expected output: the `$ regulait gate deploy … --env staging --ref <ref>` line and a blank line, then `DENY  "Real-Time Fraud Detection Engine" (approved, EU AI Act tier high) → staging`, two
  `BLOCK open_high_alert` lines, then `assurance: …`. After the two alerts are acknowledged (DEMO_SCRIPT G3): `ALLOW`
  with two `WARN acknowledged_high_alert` lines.
- T-24h capture: `~/g3.sh t24h > ~/real-gate.txt; cat ~/real-gate.txt`. It holds the decision lines only, no secret.
  Keep it open in a viewer during the demo as G3's fallback.

**Open questions for the owner (#453).**

- ~~**Fallback.**~~ **Decided** (owner, 2026-10-29, #453 c6486079064): a second, sample-data stack on the laptop (§7.8).
- **HSTS.** TUNNEL.md step 3 puts `REGULAIT_HSTS=max-age=86400` in `.env`, but `docker-compose.yml` does not pass that
  name to the gateway, so the gateway sends no HSTS header and does not see the deployed signal (§7.1, "HSTS"). The
  owner saw a single `max-age=15552000; includeSubDomains` header from the Cloudflare zone (#453 c6485165280).
  Adding `REGULAIT_HSTS` to the override would make two layers set it unless the zone setting is turned off, and with
  it set the gateway refuses to boot on the published development secrets (step 2 replaces them). Not changed here.

**Superseded by ADR-0203 (the AWS dev host; kept for the record, do not run).** The power schedule
(`power_schedule_enabled` in `infra/environments/regulait-dev-app`, the `regulait-dev-app-start` and
`regulait-dev-app-stop` EventBridge schedules, starting the instance by hand with `aws ec2 start-instances`), the
gateway override in `/opt/app/docker-compose.override.yml` written by user data and recreated with `sudo docker compose
--profile tls up -d gateway`, the Session Manager shell (`aws ssm start-session`) for G3, the `sslip.io` hosts-file
line mapped to the Elastic IP, and the backup timer (`regulait-pg-backup.timer`, `docs/ops/DB_BACKUP.md`). None of
these exist on the laptop. `DEMO_TEARDOWN.md` still names the power schedule; it is not changed here.

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

### 7.8 The fallback stack on the laptop (owner, 2026-10-29, #453 c6486079064)

The fallback is the sample-data stack of §1.3, run on the same laptop as the live instance but fully apart from it:

| | Live stack | Fallback stack |
|---|---|---|
| Checkout | the repository checkout (§7.6) | a second checkout of the **same commit**, in a sibling folder named `regulait-fallback` |
| Compose project | that folder's name | `regulait-fallback` (compose names a project after its folder) |
| Database | the live volumes | its own `regulait-fallback_*` volumes |
| `.env` | live values, **no** demo switch | `REGULAIT_DEMO_LICENSE=1` and `REGULAIT_PUBLIC_URL=http://localhost:3100` only |
| Gateway port | `127.0.0.1:3000` | `127.0.0.1:3100` |
| Compose network | `172.28.0.0/16` (`docker-compose.yml`) | `172.29.0.0/16`, set in its override (two projects cannot share a pinned subnet) |
| Profiles | `tunnel` | **none**: never `tunnel` (one tunnel per token), `sso`, or `isolation` (its volumes have fixed names shared by every project on the host) |
| Reached at | `https://regulait.<domain>/ui` | `http://localhost:3100/ui`, on the laptop only |

Run every fallback command from inside `regulait-fallback`. Never run a fallback command in the live checkout, and
never run `down -v` anywhere else (§7.6, step 3).

1. **The second checkout.** From the live checkout, at the commit the live stack runs:

   ```bash
   # pending execution — in the live checkout
   git worktree add ../regulait-fallback HEAD
   cd ../regulait-fallback
   ```

   A git worktree shares `.git/info/exclude` with the live checkout, so the `docker-compose.override.yml` line from
   §7.6 step 2 already covers this folder. Confirm with `git check-ignore -q docker-compose.override.yml && echo ignored`.
2. **Its `.env`.** Create `.env` in `regulait-fallback` with exactly these two lines, and nothing from the live `.env`
   (no tunnel name or token, no live integration settings):

   ```bash
   # pending execution — in regulait-fallback
   printf '%s\n' 'REGULAIT_DEMO_LICENSE=1' 'REGULAIT_PUBLIC_URL=http://localhost:3100' > .env
   ```

3. **Its port and network.** Both stacks pin their compose network, and Docker refuses a second network on the
   same subnet, so the fallback moves to `172.29.0.0/16` and moves `REGULAIT_TRUSTED_PROXIES` with it, as the comment
   above the `networks:` block in `docker-compose.yml` requires. Nothing listens at `172.29.0.2` without the `tls`
   profile, so nothing is trusted. First check that the range is free on the laptop (the output must not show
   `172.29.`):

   ```bash
   # pending execution
   docker network inspect $(docker network ls -q) --format '{{.Name}} {{range .IPAM.Config}}{{.Subnet}}{{end}}' | grep 172.29. || echo "172.29.0.0/16 is free"
   ```

   Then create `docker-compose.override.yml` in `regulait-fallback` with exactly this content. The `!override` tags
   replace the lists instead of adding to them (Docker Compose 2.24.4 or later):

   ```yaml
   services:
     gateway:
       ports: !override
         - "127.0.0.1:3100:3000"
       environment:
         REGULAIT_TRUSTED_PROXIES: 172.29.0.2
   networks:
     regulait:
       ipam: !override
         config:
           - subnet: 172.29.0.0/16
             gateway: 172.29.0.1
             ip_range: 172.29.1.0/24
   ```

   Check it. The gateway must publish only `3100`, and the network must be `172.29.0.0/16`:

   ```bash
   # pending execution — in regulait-fallback
   docker compose config --quiet && docker compose config --format json \
     | node -e 'const c=JSON.parse(require("fs").readFileSync(0));console.log(JSON.stringify(c.services.gateway.ports), JSON.stringify(c.networks.regulait.ipam.config))'
   ```

4. **The wipe guard.** Before any `down -v` on this stack, check the folder and the project, and stop if either is
   wrong:

   ```bash
   # pending execution — in regulait-fallback
   [ "$(basename "$PWD")" = regulait-fallback ] && docker compose config --format json | grep -q '"name": "regulait-fallback"' && echo ok
   ```

5. **Prepare from empty** (under 18 hours before the run, ADR-0197 decision 7): after step 4 prints `ok`, run
   `docker compose down -v`, then `docker compose up -d --build`. The §1.3 switch runs the sample-data prep on the empty
   database. Then set the demo passwords and enrol the two admins' authenticators exactly as §1.3 describes (read
   `http://localhost:3100` wherever §1.3 says `3000`), in a
   **separate** browser profile at `http://localhost:3100/ui`, never in a live profile.
6. **Check it** the way §1.3 says ("Re-checking later"): read the prep's result with
   `docker compose logs gateway | grep -E "pass, .* warn, .* fail"`, or run §1.3's re-check block, in `regulait-fallback`.
   A bare `demo-check.js` FAILs "3 Evidence" by design, so do not use it. From Git Bash on Windows, run
   `export MSYS_NO_PATHCONV=1` first (§7.6).
7. **On the day:** keep the fallback stack running from T-1h with its browser profile signed in, so switching is
   instant. If the laptop runs short of memory, `docker compose stop` it after the check and `docker compose start` it
   at T-10 min. After the demo, `docker compose down -v` in `regulait-fallback` (after step 4), then
   `git worktree remove ../regulait-fallback` from the live checkout.

### 7.9 The ABAP MCP server behind the proxy (owner, 2026-10-29, #453 c6508111468; ADR-0204)

The ABAP MCP server is a separate product. Registered behind our MCP proxy, a live change in that system runs through
governance. It reads its API keys only from `Authorization: Bearer`, so the gateway authenticates to it with a static
upstream credential under the Bearer scheme (the default). The full agreed configuration is in #453, in the master
session's latest comment. Everything below is placeholders: the real host and key are entered by the owner in the
product, never in chat, the repo or a ticket.

1. **Allow the host.** Add `<abap-host>` to the egress allow-list (a public-internet URL needs an allow-host entry).
2. **Register the server.** In `/ui`, **Integrations → MCP servers**: name `<abap-mcp-name>`, transport
   `streamable_http`, URL `https://<abap-host>/mcp`.
3. **Set the credential.** Select the server, then on the **Upstream credential** card choose **Bearer token in
   Authorization** and paste an `rgk_<…>` key issued from the server's `admin` profile. Save, and confirm it's you when
   asked. The card then shows the scheme and the key's last four characters only. (The named-header option exists, but
   the demo does not use it.)
4. **Identity to upstream: leave it `none`.** The server's OIDC verifier does not accept our EdDSA assertion.
5. **Grants.** Grant the demo persona the tools `SAPWrite` and `SAPActivate`; everyone else stays denied by default.
6. **Approval rule.** Require approval for any call to `SAPWrite` or `SAPActivate`, with the approver notified in Slack
   and by email.
7. **Check it.** Sync the server's tools (open its tools, or make one governed read-only call); the server's own log
   should show the request authenticated. A `mcp-upstream-credential-unavailable` refusal on the audit page means the
   gateway's data key differs from the one the key was saved under: set the credential again.
8. **What to say.** SAP records a technical user, because principal propagation is off. The person is governed and
   audited in RegulAIt: who asked, which tool, the approval and the outcome.
9. **The refused case to show.** A write outside the allowed package produces the server's `safety_blocked` event and
   never reaches SAP.
10. **Do not** change the server's URL after setting the credential unless you mean to: a URL change clears it
    (audited), and it must be set again. Rotate or clear on the same card; Clear is the secondary button and asks for a
    confirmation.

### 7.10 Claude as model and agent (owner, 2026-10-29, #453 c6508111468; freeze exception)

Claude appears in two roles: as a **model** that a persona dispatches through the gateway, and as an **agent** whose
tool calls reach the governed MCP proxy (`POST /mcp/:serverId`) and get a deny or an approval request. Every value
below is a placeholder. The Anthropic key and every `rgl_` key are read into the shell with `read -rs`, so they never
land in a file, a shell history, a log or this repository. Use a **demo-scoped** Anthropic key with a spend limit set
in the Anthropic Console.

**Placeholders used below** (set them in the terminal you run the steps from):

```bash
# pending execution
export GW='https://regulait.<domain>'          # the tunnel front door (docs/deployment/TUNNEL.md); on the laptop alone, http://localhost:3000
read -rs BOOT && export BOOT                   # the bootstrap token (admin setup calls only)
read -rs RGL_KEY && export RGL_KEY             # Dana's rgl_ key, printed once by the seed (or minted below)
H_BOOT="authorization: Bearer $BOOT"
```

**Defaults that stay strict** (ADR-0180, ADR-0181), and what each one means for this beat:

- The egress posture is strict, so the compiled vendor endpoint is refused until an admin adds its host (step 1).
- The env-key fallback is off, so the key is stored through the API, encrypted under `REGULAIT_DATA_KEY` (step 2).
- An agent dispatches only with an approved model card (MRM), a project id, and a project whose use case is approved
  (steps 3–5).
- Every MCP call must name a project (`require_mcp_attribution`). Claude Code sends the `x-regulait-project-id` header.
  The Messages API MCP connector cannot send custom headers, so it names the project in the URL as `?project=<id>`.
  That parameter goes through the same check as the header, and a request whose header and query name different
  projects is refused with 400 `project_attribution_conflict`.

#### Model: claude-opus-5-5 through the gateway

1. **Egress host (admin, step-up).** Adding a host is a stepped-up relaxation (ADR-0186 A). Ada adds it in the UI:
   **Admin → Custom providers → Egress allow-list → Add host**. Enter host `api.anthropic.com`, leave private ranges
   and plain HTTP off, and add the note "Claude beat (#453 c6508111468)". She confirms the step-up prompt.
   Check it:

   ```bash
   curl -sS "$GW/v1/egress-allow-hosts" -H "$H_BOOT" | jq '.hosts[] | select(.host=="api.anthropic.com")'
   ```

2. **The key, stored through the API, encrypted.** The key is read without echo and piped as the request body. It is
   never an argument and never in a file:

   ```bash
   # pending execution
   read -rs ANTHROPIC_DEMO_KEY
   jq -n --arg k "$ANTHROPIC_DEMO_KEY" '{provider:"anthropic", apiKey:$k}' \
     | curl -sS -X POST "$GW/v1/model-credentials" -H "$H_BOOT" -H 'content-type: application/json' --data-binary @- \
     | jq '{provider, baseUrl, createdAt}'
   ```

   Expect `201` with `provider: "anthropic"` and `baseUrl: null`. The response never contains the key. The audit row
   `model-credential-stored` records the provider, never the key. Without `REGULAIT_DATA_KEY` the answer is
   `503 no_data_key`. Keep `ANTHROPIC_DEMO_KEY` set only if you will run the Messages API example below; otherwise
   `unset ANTHROPIC_DEMO_KEY` now.

3. **Register the model connection, priced** (the beat's cost view must not read "Unpriced"). The list price is
   $4 per million input tokens and $20 per million output tokens; check the Anthropic pricing page on the day. Tier
   must be 2 or lower, because Dana's ceiling is tier 2:

   ```bash
   # pending execution
   AGENT_ID=$(curl -sS -X POST "$GW/v1/agents" -H "$H_BOOT" -H 'content-type: application/json' \
     -d '{"name":"claude-demo","provider":"anthropic","tier":2,"model":"claude-opus-5-5","costPerMTokIn":4,"costPerMTokOut":20}' \
     | jq -r .id)
   ```

   To fix the prices later, use `PATCH /v1/agents/$AGENT_ID` with `{"costPerMTokIn":4,"costPerMTokOut":20}`.

4. **Grant Dana the model.** Look up the personas and the project, then grant the agent to Dana:

   ```bash
   # pending execution
   DANA_ID=$(curl -sS "$GW/v1/users" -H "$H_BOOT" | jq -r '.users[] | select(.email=="dana@regulait.local") | .id')
   AVERY_ID=$(curl -sS "$GW/v1/users" -H "$H_BOOT" | jq -r '.users[] | select(.email=="avery@regulait.local") | .id')
   PROJECT_ID=$(curl -sS "$GW/v1/projects" -H "$H_BOOT" | jq -r '.projects[] | select(.name=="demo-project") | .id')
   curl -sS -X POST "$GW/v1/grants/agents" -H "$H_BOOT" -H 'content-type: application/json' \
     -d "{\"userId\":\"$DANA_ID\",\"agentId\":\"$AGENT_ID\",\"allowedModes\":[\"execute\"]}" | jq '{id, userId, agentId}'
   ```

5. **Model card and sign-off (MRM is enforced).** Author the card, request Avery's sign-off, and have Avery decide in
   his **Inbox** (Profile B). Give a reason; it is mandatory here because the request row names him.

   ```bash
   # pending execution
   CARD_ID=$(curl -sS -X POST "$GW/v1/mrm/cards" -H "$H_BOOT" -H 'content-type: application/json' \
     -d "{\"agentId\":\"$AGENT_ID\",\"intendedUse\":\"Demo: governed general-purpose assistant for the demo project\"}" | jq -r .card.id)
   curl -sS -X POST "$GW/v1/mrm/cards/$CARD_ID/sign-off" -H "$H_BOOT" -H 'content-type: application/json' \
     -d "{\"approverUserId\":\"$AVERY_ID\",\"validUntil\":\"$(date -u -d '+30 days' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -v+30d +%Y-%m-%dT%H:%M:%SZ)\"}" | jq '{approvalId}'
   ```

   Without this step every dispatch answers `409 mrm_approval_required`, which is the right answer for an unreviewed model.

6. **Dispatch as Dana.** Check the project budget first: demo-project has a $0.20 monthly budget, and earlier demo
   traffic bills it (`GET /v1/projects/$PROJECT_ID/costs`). Then:

   ```bash
   # pending execution
   curl -sS -X POST "$GW/v1/agents/$AGENT_ID/invoke" -H "authorization: Bearer $RGL_KEY" -H 'content-type: application/json' \
     -d "{\"mode\":\"execute\",\"input\":\"In one sentence: what does an AI gateway do?\",\"dispatch\":true,\"projectId\":\"$PROJECT_ID\",\"maxTokens\":512}" \
     | jq '{model: .dispatch.model, costUsd: .dispatch.costUsd, text: .dispatch.outputText}'
   ```

   Expect the answer text and a non-null `costUsd`. The call is in the audit log and in the project's cost view.

#### Agent: Claude's tool calls through the governed MCP proxy

The persona is Dana. The server is the demo MCP server `repo-tools` (`demo:mcp`), with the seed's rules: her
`search_code` is **denied** (her role's read grant is revoked for her), and her `write_file` is **queued for Avery**.
Look up the server id:

```bash
SERVER_ID=$(curl -sS "$GW/v1/servers" -H "$H_BOOT" | jq -r '.servers[] | select(.name=="repo-tools") | .id')
```

**Path 1: Claude Code pointed at the gateway.** The gateway accepts the `rgl_` key only as
`Authorization: Bearer` (the RFC 9728 metadata at `/.well-known/oauth-protected-resource/mcp/<id>` says the same). It
speaks stateless Streamable HTTP: `POST` only, and `GET` answers `405 Allow: POST`, which clients treat as "no server
stream". In a terminal where `RGL_KEY`, `PROJECT_ID` and `SERVER_ID` are set:

```bash
# pending execution
claude mcp add --transport http regulait-repo-tools "$GW/mcp/$SERVER_ID" \
  --header "Authorization: Bearer $RGL_KEY" \
  --header "x-regulait-project-id: $PROJECT_ID"
claude mcp list        # expect: regulait-repo-tools … connected
```

`claude mcp add` stores the header values in the local Claude Code config. Remove the entry after the demo with
`claude mcp remove regulait-repo-tools`, and revoke the key. Then ask Claude Code to "search the code for TODO with
the repo-tools search_code tool", and then to "write docs/enforce-it.md with repo-tools write_file".

**Path 2: the Messages API MCP connector.** Anthropic's servers call the gateway, so the URL must be publicly
reachable through the tunnel (docs/deployment/TUNNEL.md). The connector sends `authorization_token` as
`Authorization: Bearer`, which is how the gateway takes the `rgl_` key. It cannot set custom headers, so the project
rides on the URL. The model call itself goes from this terminal straight to the Anthropic API with the demo key, so
only the tool calls are governed and attributed by RegulAIt here; the model-path dispatch above is the governed model call.

```bash
# pending execution — needs ANTHROPIC_DEMO_KEY (step 2) and the tunnel up
jq -n --arg url "$GW/mcp/$SERVER_ID?project=$PROJECT_ID" --arg tok "$RGL_KEY" '{
  model: "claude-opus-5-5",
  max_tokens: 2048,
  mcp_servers: [{type: "url", url: $url, name: "repo-tools", authorization_token: $tok}],
  tools: [{type: "mcp_toolset", mcp_server_name: "repo-tools"}],
  messages: [{role: "user", content: "Use repo-tools search_code to search for TODO, then report exactly what the tool returned."}]
}' | curl -sS https://api.anthropic.com/v1/messages \
  -H "x-api-key: $ANTHROPIC_DEMO_KEY" -H 'anthropic-version: 2023-06-01' \
  -H 'anthropic-beta: mcp-client-2025-11-20' -H 'content-type: application/json' --data-binary @- \
  | jq '.content[] | select(.type=="mcp_tool_use" or .type=="mcp_tool_result")'
unset ANTHROPIC_DEMO_KEY
```

**Expected output, both paths:**

| Call | What Claude receives | Audit (`/ui/admin/audit`) |
|---|---|---|
| `search_code` | an error result: `Denied by policy: …` naming the rule (`default-deny`; her role's grant revoked for her) | a deny row with the rule chain |
| `write_file` | an error result: `Approval required: approval '<id>' is pending sign-off by approver 'Avery …' (…). Retry after approval.` | the queued approval; the request is in Avery's **Inbox** |
| `write_file`, retried after Avery approves | the demo server's answer, `committed … as commit demo01a` | the decision and the executed call |

On the connector path the result arrives as an `mcp_tool_result` block with `is_error: true` and the same text. A
`400 mcp_attribution_required` means the project is missing from the header or the URL. A `401` means the key is
missing, expired or revoked. A `403 egress_blocked` on the model path means step 1 is missing.

**Check it:** `demo:check` reports the beat as `E External model and agent`. It shows a WARN while the beat is not set
up, and FAILs if the agent is unpriced or lacks its credential or egress entry. It reads no key and makes no model call.

**Not verified in this repository** (verify at rehearsal): a real call to the Anthropic API with the demo key; the
connector reaching the gateway through the Cloudflare edge (a WAF or bot rule there could block Anthropic's servers);
and the exact rendering of the error results in the Claude Code UI.

**Teardown:** revoke Dana's demo key if you minted one (`POST /v1/keys/<keyId>/revoke`), remove the Claude
Code entry, delete the stored credential (`DELETE /v1/model-credentials/anthropic`), and remove the egress host in the
UI. Disable the Anthropic key in the Console.

### 7.11 Act 3 "Build it": set-up checklist (2026-10-31 addendum)

The beats are in `DEMO_SCRIPT_2026-11-01.md`, "Addendum (2026-10-31): Act 3 — Build it". Every row is **pending
execution**. The keep-in-order rule from §7.3 still applies: the `demo:relax-e` row (beat E's audited relaxation) is
done at T-24h, before any E rehearsal, and before the steps below. Nothing here changes it.

**Order matters: store the Claude key after the T-24h `demo:traffic` re-run.** The seed grants `claude-opus` to Ada,
Dana and Avery (`apps/gateway/src/seed.ts`, the grant loop after the agent catalogue). Once the org key is stored,
`claude-opus` can serve, and a mock agent stops being a routing candidate for anyone whose entitled roster holds a live
agent that can serve (`mockShadowedByLive`, `apps/gateway/src/agents-connectors.ts`); the decompose roster follows the
same rule. A mock that is chosen explicitly still serves. So `demo:traffic` run after the key would route Dana's traffic
to Claude: it would be refused by MRM before the card is signed, and would spend real money after.

| When | Check | Status |
|---|---|---|
| T-24h, after the `demo:traffic` re-run and `real-gate.txt` | **`REGULAIT_DATA_KEY` is set** on the live gateway: `POST /v1/model-credentials` answers `503 no_data_key` without it | pending execution |
| T-24h | **Egress host** for the provider added by Ada with step-up (§7.10, step 1). Without it the call is refused `403 egress_blocked` | pending execution |
| T-24h | **The owner enters the Claude key themselves**, signed in as Ada, on `/ui/admin/model-credentials` → **Add or rotate a platform credential** (**Provider**, **API key**, **Save credential**). Use a demo-scoped key with a spend limit set in the provider console. The key is never written in a file, chat, environment variable, terminal history or this repository, and nobody else is asked for it or shown it. Per-user keys are refused (`409 key_custody_enforced`) while key custody is on, which is the default; use this page | pending execution — owner |
| T-24h | **Provider status:** `GET /v1/model-providers/status` (any signed-in user) shows the provider `configured: true`. It returns booleans only, never a key | pending execution |
| T-24h | **The `claude-opus` model id is current.** Compare its stored model id with the provider's current model list in the provider console. If it is stale, correct it on `/ui/admin/agents` → **Model & pricing** card: pick the agent, edit **Model id (empty = not dispatchable)**, **Save model & pricing** (or `PATCH /v1/agents/:agentId` with `model`). Check the prices against the provider's pricing page in the same card. Do not write the model id into any document | pending execution |
| T-24h | **Model card: signed live, not before.** Decided here: B2 shows the `409 mrm_approval_required` refusal and the sign-off on stage, and G1 needs `claude-opus`'s card **Not signed off** until then (§7.3, "S4 Link stack pairing"). So check that `claude-opus` has **no** signed-off card on LIVE at T-24h and at T-1h. Rehearse the card and sign-off on FALLBACK only | pending execution |
| T-24h | **Presenter persona grant:** on `/ui/admin/agents` → **Per-user entitlement**, Ada holds a grant for `claude-opus` (the seed made it; re-grant with **Grant an agent** if it is missing). Avery is the model-card approver; he needs no grant | pending execution |
| T-24h | **A small run budget**, so the live run cannot overspend. On `/ui/admin/agents` → **Per-user agent policy — default, ceiling, routing, run budget**, set Ada's **Run budget USD** to a small amount and **On breach** to *approve* (a run over the cap waits for approval instead of running). There is no per-run field on the run itself: the cap comes from the initiator's policy when the run is planned | pending execution |
| T-24h | **Project budget headroom.** B2 and B3 bill `demo-project`, which has a small monthly budget that earlier demo traffic already uses (`GET /v1/projects/:projectId/costs`). If there is no headroom the call is refused `project_budget_exceeded`. If needed, an admin raises it on the project's edit form (**Budget USD**, **Save changes**); that change is audited | pending execution |
| T-24h, only if PR #611 is merged | **Claude-assisted set-up:** turn on `agent_setup_assist_enabled` through the org settings as Ada; it is a relaxation, so it needs a step-up and is audited old → new. Then open `/ui/admin/agents` and check that the set-up panel is on **Register an agent**. If #611 is not merged, B1 skips the step and nobody mentions it | pending execution |
| T-24h | **Guardrails:** `/ui/admin/guardrails` loads; **Try a sample** with the presenter-notes sample shows a finding. Write the sample and B3's goal into `DEMO_PRESENTER_NOTES_2026-11-01.md` | pending execution |
| T-1h | One live call as Ada in `/ui/builder/playground` with an explicitly chosen **mock** model, to check the page and the project billing without spending. No live Claude call before the demo on LIVE: the first one is B2's refusal | pending execution |

**Fallback, per beat** (switch at once; never retry in front of the audience; always say it):

| Beat | If the network or the provider fails | Say |
|---|---|---|
| B1 set-up assistant | Skip it; register nothing, grant nothing | nothing (the panel is optional) |
| B1 builder agent | Choose a mock agent under **Advanced → Model** | "I'll build it on a mock model" |
| B2 chat, playground, builder chat | Choose `balanced-mock` explicitly in the **Agent** / **Model** picker; skip the playground and builder chat | "the provider is not answering, so I'll switch this to a mock agent" |
| B3 task graph | **Lead agent** `balanced-mock`, then set every **Owner agent** to a mock agent before **Plan run** | "I'll run this plan on mock agents" |
| B4 guardrails | Nothing changes: the sample tester and the decisions log do not call a provider | — |
| Everything | Switch to the FALLBACK stack, which has no provider key and runs on mocks | "this is the same product on a prepared copy, with a mock model" |

As a last resort, deleting the stored credential (`DELETE /v1/model-credentials/anthropic`, audited) puts every
persona back on mocks at once. Do it after the act, not on stage.

**What the act must never claim** (each is a limit in the code on `main` on 2026-10-31):

- Task-graph nodes are owned by **registry** agents only (`ownerAgentId` is a registry agent id). A builder agent cannot
  own a node.
- Builder sub-agents are **configuration only** (`PUT /v1/builder/agents/:id/subagents` and the export manifest); no
  runtime dispatches them. Never say builder agents call each other.
- The lead agent's suggestions are resolved only against the caller's entitlements: an ungranted or unknown agent is
  swapped for the caller's fallback agent and the swap is recorded; a plan a person edits back to an ungranted agent is
  refused at **Plan run** (`422 entitlement_exceeded`) and the deny is audited. Nobody's access is widened by a lead.
- Review is a human gate unless **auto-accept reviews** is ticked; tick it off on stage.
- The per-run budget is the initiator's policy (**Run budget USD**), not a field on the run.
- A workflow stage can carry a nested run (`workflowInstanceId`); this act does not show it.
- The model-card page has no approve button; the named approver decides in the Inbox. A requester deciding their own
  sign-off needs a recorded self-review reason; on stage, Avery decides.
- PII on a model call is block, warn or log. Redaction applies only on MCP and connector tool calls, never inside a
  model call.
- The playground's API answer includes the PII and guardrails verdicts; the playground page does not show them.
- Claude-assisted set-up exists only if PR #611 is merged and its switch is on.

**Teardown:** as §7.10, plus: delete the builder agent and the B1 agent if one was registered, set Ada's run budget
back, and leave the model card signed off only if the owner wants it kept (its sign-off expires on the **Recertify by**
date).

**Test:** `apps/gateway/src/zz-demo-build-it-task-graph.test.ts` runs B3's chain on the demo's three mock agents
against real Postgres: decompose, the ungranted suggestion swapped, the edited plan refused and audited, the run created
and auto-advanced to completion, every node done through a metered, audited governed dispatch.

### 7.12 Act 4 "What's new": set-up checklist (2026-10-31 addendum)

The beats are in `DEMO_SCRIPT_2026-11-01.md`, "Addendum (2026-10-31, owner): Act 4 — What's new". Every row is
**pending execution**.

**Rules that still apply:**
- The keep-in-order rule of §7.3 and §7.11: `demo:relax-e` at T-24h before any E rehearsal, and the Claude key after
  the `demo:traffic` re-run.
- The owner enters keys only in the UI. No row here asks for, writes or echoes a secret, and Act 4 needs no new key.
  Two beats do create a single-use sign-in link on screen (V2 **Copy link**, P2 **Sign-in link for …**). Each is a
  bearer credential: copy it with the projector frozen or mirrored off, and never paste it anywhere but the private
  window.
- Agent and key names in this section (for example the seeded `claude-opus` agent and the Claude key of §7.11) are for
  the presenter only. Keep them off screen and out of what is said.
- The SAP gateway is shown as intake use cases only, never as governed. Act 4 does not touch it.

**Where the switches are.** Every org switch below is done signed in as Ada, on LIVE, at T-24h, after the §7.11 rows.
A "step-up" is Ada's fresh authenticator code. Each change writes an audited old → new row. Most switches are on
`/ui/admin/organization` (nav **Settings** → **Organization**); the rows say where the others are.

**Seed status.** None of the Act 4 switches is turned on by `demo:prepare`. The data the beats need comes from:
- the seed (`apps/gateway/src/seed.ts`);
- the `demo:intake` step that `demo:prepare` runs (`apps/gateway/src/demo-prepare-steps.ts`,
  `demo-intake-seed-lib.ts`, fixtures in `packages/shared/src/demo-intake/fixtures.ts`);
- the live steps below.

| When | Beat | Switch, default, step-up | Data the beat needs, and whether the seed provides it | Status |
|---|---|---|---|---|
| T-24h | V1 | `/ui/admin/organization` → card **5e · Vendor questionnaire drafts**: set **Vendor questionnaire drafts** to *on — offer labelled drafts* and press **Save vendor draft setting**. Default **off**; turning it on is a relaxation: step-up, audited | `demo:intake` seeds five vendors and leaves one *proposed*. Write its name in the presenter notes; do not read it aloud. No model is needed: the beat uses **records only** | pending execution |
| T-24h | V2 | `/ui/admin/vendors/questionnaires` (from **Vendors**, the header link **Supplier questionnaires**) → card **Supplier portal**: press **Turn the portal on**. Default **off**; step-up, audited. Leave **Accept unscanned files** off (default off) | `demo:intake` leaves one vendor *under assessment* with its questionnaire submitted. Write its name in the presenter notes; confirm at rehearsal that it is the only one. An active pack is needed for **Framework**: `demo:prepare` activates the NIST and EU packs under the ephemeral demo licence (§1, step 4). Put a reserved test address (`…@example.test`) for the supplier contact in the presenter notes. The private window (profile C) must have no session | pending execution |
| T-24h | V3 | `/ui/admin/organization` → card **5d · Framework imports**: set **Framework imports** to *on — allow reviewed imports* and press **Save framework-import setting**. Default **off**; step-up, audited | Nothing to seed: the sources ship inside the build (`packages/shared/src/framework-imports-data/`), with no download at run time. Do **not** propose an import before the demo, or the stage shows **Review import** only | pending execution |
| — | R1 | None: always on | The seed and `demo:intake` feed it. Check at T-1h that the **Posture estimate** section renders with a figure and a **What to fix first** list | pending execution |
| T-24h | R2 | `/ui/admin/organization` → card **5b1a · Risk treatments: transferred and avoided**: set **Transferred and avoided treatments** to *on* and press **Save risk treatments**. Default **off**; step-up, audited | `demo:intake` seeds use-case risks that are *open* and *mitigating*. Pick one open risk that no Act 1–3 beat uses (not on S4's use case). Write its title and a placeholder policy reference ("<demo-policy-ref>, clause 7", never a real policy) in the presenter notes | pending execution |
| — | R3 | `/ui/admin/model-risk` → card **Re-test after a model change**. Default **off**. **Leave it off on LIVE**: the beat only shows it | Nothing. **R3/I3 model-change rule:** never save a model or price change on `/ui/admin/agents` on LIVE from T-24h onward, except the §7.11 `claude-opus` model-id check. A change counts as a "model or configuration change" in the drift of that agent's model card. Whether it then holds the agent's dispatch is **to confirm at rehearsal** on FALLBACK | pending execution |
| — | D1 | No org switch: one row per detector, absent = off. **Leave all three off.** Turning one on needs a scoring service registered on **External scorers** that has passed its connection test, plus an egress entry (step-up) | The reference service (`agents/trained-detectors/`, about 2 GB) is not in the product image or CI. **Do not set it up for the demo**; the beat is show-only | pending execution |
| — | D2 | `/ui/admin/organization` → card **3b1 · Remote agents (A2A)**, setting `a2aEnabled`. Default **off**; turning it on is a step-up relaxation. **Leave it off**: the beat shows the **Off (default)** badge | Registration fetches the remote agent's card live, so it needs a reachable A2A endpoint and an egress entry. Calls are API only. **Skip any registration** unless a test endpoint is set up and rehearsed on FALLBACK first | pending execution |
| T-24h | I1 | None for sync. Each **Sync tools now** asks for a step-up; a sync that runs is audited, allowed or refused by a gate, but a rate-limit `429` or a failed step-up writes no sync row. The limit is 6 per server per minute, so press it once | Seeded: `repo-tools` and `data-warehouse`, back-dated past the 7-day release waiting period, with a loopback egress entry; `demo:setup` points them at the `demo:mcp` server (§1, step 3). **The `demo:mcp` server must be running.** Do not register a new server on stage: it would hit `mcp_release_age_cooldown`. One rehearsal sync on FALLBACK only | pending execution |
| — | I2 | None (read-only) | Seeded: one connector on the mock adapter and one governance-only connector. Never type a credential on stage | pending execution |
| On stage, then teardown | I3 | `/ui/admin/rules` → **Per-model limits**: **Turn enforcement on** (`modelRateLimitsEnabled`, default **off**). The step-up is asked in both directions, and the change is audited | Seeded `fast-mock`. The limit (User Ada, `fast-mock`, 1 call per 60 s) is added on stage. Check at T-24h that `fast-mock` explicitly chosen in `/ui/chat` still serves after the Claude key is stored. §7.11 says an explicitly chosen mock always serves | pending execution |
| T-24h | P1 | The processing limit (`privacyOpsEnabled`) is switched **on stage** on `/ui/admin/privacy`: **Turn the processing limit on**. Default **off**; turning it on needs no step-up, turning it off is a step-up relaxation | **Not seeded.** At T-24h on `/ui/admin/privacy` → **Add a record**: **Name** "Claims triage", **Lawful basis** any, **Retention (days)** 30, **Project** `hipaa-project`, **Data categories** *Email address*, a one-line **Purpose**, then **Add record** (step-up). Leave the limit **off** until the beat. Put a placeholder e-mail address (`…@example.test`) in the presenter notes for the data subject request. **P1 sends no chat:** an e-mail address in a call is refused `pii_blocked` by the org PII mode (*block*) before the processing gate (`enforcePII` runs before `privacyDispatchGate` in `apps/gateway/src/agents-connectors.ts`) | pending execution |
| T-24h | P2 | `/ui/admin/trust-publishing` → card **Public trust pages**: tick **Public trust pages and auditor access** and press **Save**. Default **off**; step-up, audited | **Not seeded.** At T-24h: **Trust centre heading** tab, using the demo org's placeholder name, then **Save heading** (a step-up while the pages are on). Then **Controls and evidence** → **Start a draft from a control**: pick a control of an active pack, **Publish as** *Evidence summary*, **Create draft**, **Edit** in plain words, **Save draft**, **Publish** to *Anyone, on the public trust centre* (step-up). Without a published control or evidence summary, `/ui/trust` shows no **Controls and evidence** heading. Then **AI system cards** → **Start an AI system card from the register**: pick a seeded use case (not S4's), **Draft card**, **Edit** the fields in plain words with no claim words, **Save draft**, **Publish**, **Who can see it**: *Anyone, on the public trust centre* (step-up). Check `/ui/trust` in the private window. Do **not** create an auditor grant before the demo | pending execution |
| T-1h | All | — | The private window (profile C) is open with no session. The `demo:mcp` server is running. The presenter notes hold every name and placeholder above | pending execution |

**The laptop after `demo:prepare` (FALLBACK).** A re-prepare puts every Act 4 switch back to its default and drops the
T-24h records. After each `demo:prepare` on FALLBACK, repeat the T-24h rows for V1, V2, V3, R2, P1 and P2. Then
rehearse Act 4 there, never on LIVE.

**Fallback, per beat** (switch at once; never retry in front of the audience; always say it):

| Beat | If it fails | Say |
|---|---|---|
| V1, V3, R2 | Switch missed or refused: show the off notice and move on | "this is off by default; an admin turns it on with a second factor" |
| V2 | Grant refused: show the **Supplier portal** card; the link fails: move on | "it needs an active framework and a vendor under assessment" / "the link is single-use, which is the point" |
| I1 | Sync fails: open `/ui/admin/audit` | "the tool server isn't answering, and the refusal is audited" |
| I3 | No refusal: open `/ui/admin/audit` | "we'll see it in the audit" |
| P1 | Asked to show the refusal live: do not send personal data | "the PII mode refuses that first; the processing limit is the next check" |
| P2 | `/ui/trust` unavailable: show the tabs only; auditor link fails: **New link** once (step-up) | "it is off by default" / "it's single-use" |
| R1, R3, D1, D2, I2 | Read-only; nothing to fall back to | — |
| Everything | Switch to the FALLBACK stack, prepared and set up as above | "this is the same product on a prepared copy" |

**What Act 4 must never claim** (each is a limit in an ADR or in the code on `main` on 2026-10-31):

- **Vendor drafts (ADR-0213):** a draft never submits, attests or changes the vendor's status. Draft quality against a
  real model is not measured. Supplier documents are pasted text only.
- **Supplier portal (ADR-0221):**
  - no e-mail and no supplier MFA;
  - no malware scanner, so files are refused by default;
  - supplier reads are not audited;
  - an accepted answer is a claim the vendor made, not verified evidence;
  - answers do not flow into the questionnaire artifact;
  - no row-level security: isolation comes from the route class and grant-keyed queries;
  - the supplier sees every control in the chosen framework's active pack, not a hand-picked subset;
  - the step-up prompt still reads "changing an agent identity".
- **Framework imports (ADR-0215):**
  - accepting does not activate a pack;
  - new controls start unmapped, and feed entries map to no control;
  - no scheduled refresh;
  - no US state-law packs, no SP 800-53 catalogue and no AI RMF Playbook actions.
- **Posture estimate (ADR-0214):**
  - an estimate of the records, not a compliance verdict, audit opinion or certification;
  - fixed weights;
  - org-wide only;
  - deterministic, with no AI;
  - an unmeasured objective counts as 0.
- **Risk treatments (ADR-0211):**
  - transfer keeps the rating, the heat map, the tolerance check and the deploy-gate hold;
  - a treated risk can only be reopened or closed;
  - "avoided" is not "resolved";
  - switching off does not undo treatments.
- **Re-test (ADR-0217):**
  - signs nothing off and clears no drift;
  - hourly, not instant;
  - reruns existing baselines and red-team libraries only (up to 10 suites);
  - no custom-provider cards;
  - spends tokens and is refused over budget.
- **Trained detectors (ADR-0220):**
  - not in the product image or the air-gapped bundle yet;
  - no accuracy figures;
  - **Try a sample** is rule-based only;
  - injection is scanned on input only;
  - groundedness is not a run-time detector;
  - fails closed by default.
- **A2A (ADR-0219):**
  - API-only calls;
  - orchestration does not call remote agents;
  - the card signature is not verified;
  - no policy-kernel or guardrail rules on message text; the outgoing message gets the project's PII mode only;
  - replies are not checked for PII;
  - a skill grant is advisory;
  - no streaming, polling, cancellation or A2A rate limit.
- **MCP sync (#609, #625):**
  - the button is **Register**;
  - registering grants no one;
  - a sync goes through every gate;
  - discovery classifies supplied evidence only, and stdio servers never show up.
- **Connectors (#616):** the governance-only connector executes nothing, and a credential is never shown again.
- **Modality pricing and per-model limits (ADR-0212):**
  - modality spend is measured, never estimated; most providers, including the ones in this demo, report no split;
  - limits bind only once an admin turns enforcement on;
  - limits can be overrun by in-flight calls;
  - role and team limits count per user;
  - no fallback on refusal;
  - no back-fill.
- **Privacy (ADR-0224):**
  - not consent tracking: consent is one lawful basis, and the limit is per project or use case;
  - only governed model dispatch is limited, not connectors, MCP tools or training ingest;
  - objections are not enforced per person;
  - **Locate data** searches four RegulAIt stores only;
  - erasure replaces the identifier as typed, and audit rows are tombstoned, not edited;
  - phone numbers are matched as typed, the message `detail` column is not searched, and erasure has no step-up;
  - open requests stop matching after the data key is rotated.
- **Trust pages (ADR-0225):**
  - never "certified", "compliant", "accredited" or "guarantee";
  - no auditor e-mail or MFA;
  - no download or export;
  - an unpublish may stay cached for up to 5 minutes;
  - a republished item does not reach existing grants;
  - an auditor session lasts at most 1 hour.
- **MCP identity assertion (ADR-0210, PR #612):** no beat. API only, no UI control, and it needs an operator-provisioned
  signing key.

**Teardown (after the demo, not on stage):**
1. Remove the `fast-mock` per-model limit (step-up), or **Turn enforcement off** (step-up).
2. **Turn the processing limit off** (step-up).
3. Revoke the auditor and the supplier: **Revoke**, then **Revoke access** in **Auditors with access**, and the
   revoke in **Supplier access**.
4. Unpublish the trust-centre item.
5. Set the T-24h switches back to off, or leave them on if the owner wants them kept. Each change is a step-up and
   audited.

## 8. AWS demo host (ADR-0228)

Addendum of 2026-11-01. Owner decisions ([ADR-0228](../decisions/0228-demo-host-single-ec2-company-account.md)):
"EC2 now, Fargate after", and **"Terminal only, keep Terraform"**. The demo stack moves from the laptop to **one
hardened EC2 instance** in a new member account of the company AWS Organization, behind the **same Cloudflare Tunnel
and hostname**. It is a demo environment, never production. **The demo is Monday morning, 2026-11-02**; every step
below runs on **Sunday 2026-11-01**. Every step is **pending execution** and the owner runs it; no agent runs `plan`
or `apply`. Nothing above this section changes.

**What still depends on the laptop after step 8.7: only the browser used to present.** Keep the laptop stack and its
volumes untouched until teardown (8.11). The laptop is the rollback (8.10).

### 8.0 How to read this section

- **Every step is a terminal command.** Nothing is done in the AWS console, except the one step AWS offers no CLI
  for, enabling the IAM Identity Center organization instance (8.2). That step is marked **CONSOLE FALLBACK**.
- **The laptop is Windows, so commands are PowerShell** (5.1 or 7), run from the repository checkout. Where the shell
  matters, a **bash** block follows for macOS or Linux. Commands marked **on the host** run in the instance's SSM
  shell (Amazon Linux bash), whatever the laptop runs.
- **Placeholders:** `<profile>` is the company account's Identity Center CLI profile; `<region>` is for example
  `us-east-1`; `<company account id>` and `<host account id>` are 12 digits; `<sha>` is the commit of `main` to deploy;
  `regulait.<domain>` is the public hostname. Real values go only into git-ignored `terraform.tfvars` and
  `backend.hcl`, SSM, and the password manager.
- **Secrets are never typed into a command line, never stored in shell history and never echoed.** Each one is read
  at a hidden prompt or generated into a temporary file outside the checkout, uploaded with `file://`, and the file
  is deleted.
- Each step gives the command, **Success:** (what you should see) and **Check:** (a command that proves it).

### 8.1 Sunday 2026-11-01 plan

| When (Sunday) | Steps | Time |
| --- | --- | --- |
| Morning | 8.2 tools, Identity Center, the deployer permission set and MFA; 8.3 backend; 8.4 Terraform apply, patch, security-control checks | 2 to 3 h |
| Late morning | 8.5 secrets, 8.6 deploy the stack (secrets in tmpfs, container hardening) | about 45 min |
| Midday | 8.7 move the tunnel; 8.7 b Cloudflare Access, TLS and rate limit | 30 min |
| Afternoon | 8.8 live prepare, discovery trust, §7.11, §7.12, `demo:relax-e`, then 8.9 rehearsal on the instance | 2 to 3 h |
| Evening | **Buffer.** 8.13 rotate the demo password; 8.9 a go-live posture checklist; a backup; rehearse the rollback command (8.10) up to the point of running it | 1 h |
| Monday 2026-11-02 | The demo, on the host. 8.10 stays ready in an open PowerShell window | — |

### 8.2 Tools, sign-in and IAM Identity Center (about 20 to 40 minutes)

**a. Tools on the laptop.** You need AWS CLI v2, the Session Manager plugin, Terraform 1.9 or later, and Git for
Windows (its bash runs the two bash scripts below).

```powershell
aws --version                      # Success: aws-cli/2.x
session-manager-plugin --version   # Success: a version number
terraform version                  # Success: Terraform v1.9 or later
git --version
```

If any is missing, install it with `winget install Amazon.AWSCLI`, `winget install Amazon.SessionManagerPlugin`,
`winget install Hashicorp.Terraform` or `winget install Git.Git`. Then open a new PowerShell window.

**b. Is Identity Center already set up?** ADR-0203 asked for it. If this succeeds, skip to **d**:

```powershell
aws configure sso --profile <profile>   # interactive: start URL, region, the company account, the admin permission set
aws sso login --profile <profile>
aws sts get-caller-identity --profile <profile> --query Arn --output text
# Success: arn:aws:sts::<company account id>:assumed-role/AWSReservedSSO_<permission set>_.../<you>
```

**c. Only if b failed: Organizations and Identity Center from scratch.** There is no Identity Center session yet,
and ADR-0004 forbids access keys. So run these commands in **AWS CloudShell**, signed in to the company account. It
is a terminal with your sign-in's own short-lived credentials, and no key is created. Start `pwsh` in it to use the
PowerShell below.

```powershell
# Organizations, all features (skip if `aws organizations describe-organization` already answers)
aws organizations create-organization --feature-set ALL
aws organizations describe-organization --query 'Organization.[MasterAccountId,FeatureSet]' --output text
# Success: <company account id>  ALL
```

**CONSOLE FALLBACK (about 2 minutes):** AWS has no CLI or API call that enables the **organization** instance of IAM
Identity Center (`aws sso-admin create-instance` creates only a standalone account instance, which is not what
ADR-0004 needs). In the console, go to **IAM Identity Center** › **Enable**, choosing the region you will use as
`<region>`. Then return to the terminal:

```powershell
$Ic  = aws sso-admin list-instances --query 'Instances[0].InstanceArn' --output text
$Ids = aws sso-admin list-instances --query 'Instances[0].IdentityStoreId' --output text
# Success: $Ic starts with arn:aws:sso:::instance/ ; $Ids starts with d-

# your user (no password is set here; see the note below)
$UserId = aws identitystore create-user --identity-store-id $Ids --user-name '<your-user-name>' `
  --display-name '<Your Name>' --name 'GivenName=<Given>,FamilyName=<Family>' `
  --emails 'Value=<your-email>,Type=work,Primary=true' --query UserId --output text

# an admin permission set with a 4-hour session, and its assignment to the company account
$Ps = aws sso-admin create-permission-set --instance-arn $Ic --name RegulAItAdmin --session-duration PT4H `
  --query PermissionSet.PermissionSetArn --output text
aws sso-admin attach-managed-policy-to-permission-set --instance-arn $Ic --permission-set-arn $Ps `
  --managed-policy-arn arn:aws:iam::aws:policy/AdministratorAccess
aws sso-admin create-account-assignment --instance-arn $Ic --target-id <company account id> --target-type AWS_ACCOUNT `
  --permission-set-arn $Ps --principal-type USER --principal-id $UserId

# Check:
aws sso-admin list-account-assignments --instance-arn $Ic --account-id <company account id> --permission-set-arn $Ps `
  --query 'AccountAssignments[].PrincipalId' --output text
# Success: prints $UserId
```

**CONSOLE FALLBACK for the first password (about 2 minutes):** the CLI cannot set or send an Identity Center
password. In **IAM Identity Center** › **Users** › your user, choose **Reset password** and **Send an email**. Set the
password and register an MFA device at the link. Then run **b** on the laptop.

**d. Trusted access for the baseline's organization services** (once per Organization):

```powershell
foreach ($p in 'cloudtrail.amazonaws.com','guardduty.amazonaws.com','securityhub.amazonaws.com','config.amazonaws.com','config-multiaccountsetup.amazonaws.com') {
  aws organizations enable-aws-service-access --service-principal $p --profile <profile>
}
aws organizations list-aws-service-access-for-organization --profile <profile> `
  --query 'EnabledServicePrincipals[].ServicePrincipal' --output text
# Success: all five names listed
```

**e. The operator: a least-privilege permission set, with MFA (security-team addendum).** Run `apply` as this
permission set, **not** `Admin-BreakGlass` or `AdministratorAccess`. Its policy covers what the three stacks and the
bootstrap call in the management account, and the one role it may assume in a member account:

```powershell
$Policy = @'
{
  "Version": "2012-10-17",
  "Statement": [
    { "Sid": "OrgAndAccount", "Effect": "Allow", "Action": [
        "organizations:Describe*", "organizations:List*", "organizations:CreateAccount", "organizations:TagResource",
        "organizations:CloseAccount", "organizations:MoveAccount", "organizations:CreatePolicy", "organizations:UpdatePolicy",
        "organizations:DeletePolicy", "organizations:AttachPolicy", "organizations:DetachPolicy",
        "organizations:EnablePolicyType", "organizations:EnableAWSServiceAccess", "organizations:RegisterDelegatedAdministrator",
        "organizations:UntagResource"], "Resource": "*" },
    { "Sid": "BaselineServices", "Effect": "Allow", "Action": [
        "cloudtrail:*", "guardduty:*", "securityhub:*", "config:*", "budgets:*", "access-analyzer:*", "inspector2:*",
        "kms:*", "s3:*", "dynamodb:*", "logs:*", "sns:*"], "Resource": "*" },
    { "Sid": "IamForServiceRolesOnly", "Effect": "Allow", "Action": [
        "iam:Get*", "iam:List*", "iam:CreateRole", "iam:DeleteRole", "iam:TagRole", "iam:UntagRole", "iam:PutRolePolicy",
        "iam:DeleteRolePolicy", "iam:AttachRolePolicy", "iam:DetachRolePolicy", "iam:PassRole", "iam:CreatePolicy",
        "iam:DeletePolicy", "iam:CreatePolicyVersion", "iam:DeletePolicyVersion", "iam:CreateServiceLinkedRole",
        "iam:UpdateAssumeRolePolicy"], "Resource": "*" },
    { "Sid": "DenyHumanCredentials", "Effect": "Deny", "Action": [
        "iam:CreateUser", "iam:CreateAccessKey", "iam:CreateLoginProfile", "iam:UpdateLoginProfile"], "Resource": "*" },
    { "Sid": "IntoMemberAccountsOnlyThroughTheOrgRole", "Effect": "Allow", "Action": "sts:AssumeRole",
      "Resource": "arn:aws:iam::*:role/OrganizationAccountAccessRole" },
    { "Sid": "ReadPublicParameters", "Effect": "Allow", "Action": ["ssm:GetParameter", "ssm:GetParameters"],
      "Resource": "arn:aws:ssm:*::parameter/aws/service/*" }
  ]
}
'@
$PolicyFile = New-TemporaryFile; [IO.File]::WriteAllText($PolicyFile.FullName, $Policy)
$Ic = aws sso-admin list-instances --profile <profile> --query 'Instances[0].InstanceArn' --output text
$Dep = aws sso-admin create-permission-set --profile <profile> --instance-arn $Ic --name RegulAItDemoDeployer `
  --session-duration PT4H --description 'ADR-0228 demo host deployer' --query PermissionSet.PermissionSetArn --output text
aws sso-admin put-inline-policy-to-permission-set --profile <profile> --instance-arn $Ic --permission-set-arn $Dep `
  --inline-policy "file://$($PolicyFile.FullName)"
Remove-Item $PolicyFile
$Me = aws identitystore list-users --profile <profile> --identity-store-id (aws sso-admin list-instances --profile <profile> --query 'Instances[0].IdentityStoreId' --output text) `
  --filter 'AttributePath=UserName,AttributeValue=<your-user-name>' --query 'Users[0].UserId' --output text
aws sso-admin create-account-assignment --profile <profile> --instance-arn $Ic --target-id <company account id> `
  --target-type AWS_ACCOUNT --permission-set-arn $Dep --principal-type USER --principal-id $Me
aws configure sso --profile regulait-deployer   # choose the RegulAItDemoDeployer role; use it as <profile> from 8.3 on
```

**Success:** `aws sts get-caller-identity --profile regulait-deployer --query Arn --output text` shows
`AWSReservedSSO_RegulAItDemoDeployer_...`.

What this does not narrow: inside the member account, Terraform acts as `OrganizationAccountAccessRole`, which
Organizations creates with administrator rights. A scoped deploy role there is part of the ADR-0013 successor
(DEMO_HOST_SECURITY_BRIEF.md, residual risks).

**CONSOLE FALLBACK for MFA (about 1 minute):** there is no CLI or API for Identity Center's MFA settings. Go to **IAM
Identity Center** › **Settings** › **Authentication** › **Multi-factor authentication** and set **Every time they sign
in**, with **Require them to register an MFA device at sign-in**. **Check:** your next `aws sso login` asks for the
MFA code.

### 8.3 State backend bootstrap (about 5 minutes)

The July state bucket was deleted. `infra/bootstrap/bootstrap-backend.sh` uses the AWS CLI and holds no account id.
It creates the backend in the company account and writes `backend.hcl` for every stack, including the three
`demo-host` stacks. It is bash, so run it through Git for Windows' bash:

```powershell
$env:AWS_PROFILE = '<profile>'; $env:AWS_REGION = '<region>'; $env:EXPECTED_ACCOUNT_ID = '<company account id>'
$Bash = "$env:ProgramFiles\Git\bin\bash.exe"
& $Bash infra/bootstrap/bootstrap-backend.sh --preflight-only
# Success: "Preflight passed; nothing created (--preflight-only)."
# If the backend does NOT exist yet:
& $Bash infra/bootstrap/bootstrap-backend.sh
# If it ALREADY exists (the demo-sandbox runbook created it), this creates nothing and writes only missing backend.hcl files:
& $Bash infra/bootstrap/bootstrap-backend.sh --write-backend-config
```

```bash
AWS_PROFILE=<profile> AWS_REGION=<region> EXPECTED_ACCOUNT_ID=<company account id> infra/bootstrap/bootstrap-backend.sh --preflight-only
AWS_PROFILE=<profile> AWS_REGION=<region> EXPECTED_ACCOUNT_ID=<company account id> infra/bootstrap/bootstrap-backend.sh   # or --write-backend-config
```

**Check:**

```powershell
Get-ChildItem infra/environments/demo-host/*/backend.hcl | Select-Object FullName   # Success: three files
git status --short infra/                                                         # Success: prints nothing (git-ignored)
aws s3api get-bucket-encryption --bucket "regulait-terraform-state-$env:EXPECTED_ACCOUNT_ID" --profile <profile> `
  --query 'ServerSideEncryptionConfiguration.Rules[0].ApplyServerSideEncryptionByDefault.SSEAlgorithm' --output text
# Success: aws:kms
```

### 8.4 `terraform init`, `plan`, `apply` (about 60 to 90 minutes, mostly waiting)

There are three stacks, applied in this order. In each one, `Copy-Item terraform.tfvars.example terraform.tfvars`,
then fill it in with `notepad terraform.tfvars`. **Read every plan before applying it.** The commands are the same in
bash.

```powershell
# 1. the member account (5 to 15 minutes; account creation is asynchronous)
Set-Location infra/environments/demo-host/account
terraform init -backend-config=backend.hcl
terraform plan -out=tfplan      # Success: creates the account, budget and SCPs; "0 to destroy"
terraform apply tfplan
$HostAccount = terraform output -raw host_account_id   # put it into ../baseline and ../host terraform.tfvars
Set-Location ../../../..

# 2. the security baseline (15 to 30 minutes; Config and Security Hub are slow)
Set-Location infra/environments/demo-host/baseline
terraform init -backend-config=backend.hcl
terraform plan -out=tfplan      # Success: CloudTrail, GuardDuty, Security Hub, Config, SCPs, budget; "0 to destroy"
terraform apply tfplan
Set-Location ../../../..

# 3. the host (about 5 minutes, then about 5 minutes of boot)
Set-Location infra/environments/demo-host/host
terraform init -backend-config=backend.hcl
terraform plan -out=tfplan      # Success: no ingress block on the security group, no key_name, encrypted = true on both volumes
terraform apply tfplan
$env:DEMO_INSTANCE = terraform output -raw instance_id
$SrcBucket = terraform output -raw source_bucket
terraform output ingress_rule_count   # Success: 0
Set-Location ../../../..
```

If the baseline's first apply fails on an organization prerequisite, the error names the service. Enable its trusted
access (8.2 d) and apply again.

**A CLI profile for the host account.** It holds no secret: it chains from your Identity Center session to the role
Organizations created, the same way the Terraform provider does.

```powershell
aws configure set profile.regulait-demo-host.source_profile <profile>
aws configure set profile.regulait-demo-host.role_arn "arn:aws:iam::$($HostAccount):role/OrganizationAccountAccessRole"
aws configure set profile.regulait-demo-host.region <region>
```

**Check (SSM only, no SSH, no inbound rule, IMDSv2):**

```powershell
aws ssm describe-instance-information --profile regulait-demo-host `
  --query "InstanceInformationList[?InstanceId=='$env:DEMO_INSTANCE'].PingStatus" --output text
# Success: Online (it can take 5 minutes after the apply)
aws ec2 describe-instances --profile regulait-demo-host --instance-ids $env:DEMO_INSTANCE `
  --query 'Reservations[0].Instances[0].[State.Name,KeyName,MetadataOptions.HttpTokens,MetadataOptions.HttpPutResponseHopLimit,ImageId]' --output text
# Success: running  None  required  1  ami-...
aws ec2 describe-security-groups --profile regulait-demo-host `
  --filters Name=group-name,Values=regulait-demo-host-app --query 'SecurityGroups[0].IpPermissions' --output text
# Success: prints nothing (no inbound rule)
```

Then **pin the AMI**: put the `ami-...` value into `ami_id` in `host/terraform.tfvars`. `terraform plan` must then
show `No changes`.

**A helper for host commands (paste once per PowerShell window).** It sends commands to the host through
`aws ssm send-command`, waits, and prints the status and output. It uses no SSH and no inbound port.

```powershell
function Invoke-DemoHost {
  param([Parameter(Mandatory)][string[]]$Commands, [int]$TimeoutSeconds = 3600)
  $json = ConvertTo-Json -Compress -InputObject @{ commands = $Commands; executionTimeout = @("$TimeoutSeconds") }
  $f = New-TemporaryFile
  [IO.File]::WriteAllText($f.FullName, $json)
  $id = aws ssm send-command --profile regulait-demo-host --instance-ids $env:DEMO_INSTANCE `
    --document-name AWS-RunShellScript --parameters "file://$($f.FullName)" --query Command.CommandId --output text
  Remove-Item $f
  do {
    Start-Sleep 10
    $s = aws ssm get-command-invocation --profile regulait-demo-host --command-id $id --instance-id $env:DEMO_INSTANCE --query Status --output text 2>$null
  } while ($s -in @('Pending', 'InProgress', 'Delayed', $null, ''))
  aws ssm get-command-invocation --profile regulait-demo-host --command-id $id --instance-id $env:DEMO_INSTANCE `
    --query '{status:Status,out:StandardOutputContent,err:StandardErrorContent}' --output yaml
}
```

```bash
# bash equivalent (needs jq); export DEMO_INSTANCE=<instance id> first
demo_host() {
  local json id s
  json=$(jq -n --args '{commands: $ARGS.positional, executionTimeout: ["3600"]}' "$@")
  id=$(aws ssm send-command --profile regulait-demo-host --instance-ids "$DEMO_INSTANCE" \
    --document-name AWS-RunShellScript --parameters "$json" --query Command.CommandId --output text)
  while sleep 10; do
    s=$(aws ssm get-command-invocation --profile regulait-demo-host --command-id "$id" --instance-id "$DEMO_INSTANCE" --query Status --output text 2>/dev/null)
    case "$s" in Pending|InProgress|Delayed|"") ;; *) break ;; esac
  done
  aws ssm get-command-invocation --profile regulait-demo-host --command-id "$id" --instance-id "$DEMO_INSTANCE" \
    --query '{status:Status,out:StandardOutputContent,err:StandardErrorContent}' --output yaml
}
```

**Check the host is prepared:**

```powershell
Invoke-DemoHost 'tail -2 /var/log/app-boot.log', 'mountpoint /var/lib/docker', 'docker compose version'
# Success: status Success; "app-boot: host ready ..."; "/var/lib/docker is a mountpoint"; "Docker Compose version v2.29.7"
```

**Patch the host now, before anything is deployed** (the daily association only scans, so nothing reboots the host
during the demo):

```powershell
$PatchCmd = aws ssm send-command --profile regulait-demo-host --instance-ids $env:DEMO_INSTANCE --document-name AWS-RunPatchBaseline `
  --parameters 'Operation=Install,RebootOption=RebootIfNeeded' --query Command.CommandId --output text
Start-Sleep 300
aws ssm list-command-invocations --profile regulait-demo-host --command-id $PatchCmd --query 'CommandInvocations[0].Status' --output text   # Success: Success
aws ssm describe-instance-patch-states --profile regulait-demo-host --instance-ids $env:DEMO_INSTANCE `
  --query 'InstancePatchStates[0].[MissingCount,FailedCount,InstalledPendingRebootCount]' --output text                              # Success: 0  0  0
```

**If the Session Manager preferences document already exists** (someone opened the preferences page in the console),
the host apply fails on `SSM-SessionManagerRunShell`. Adopt it, then apply again:
`terraform import aws_ssm_document.session_preferences SSM-SessionManagerRunShell`.

**Check the security controls (the evidence the security team will ask for; DEMO_HOST_SECURITY_BRIEF.md):**

```powershell
$H = 'regulait-demo-host'
aws ec2 describe-instances --profile $H --instance-ids $env:DEMO_INSTANCE --query 'Reservations[0].Instances[0].[PublicIpAddress,SubnetId]' --output text
# Success: None  subnet-...   (no public IPv4)
aws ec2 describe-security-groups --profile $H --filters Name=group-name,Values=regulait-demo-host-app `
  --query 'SecurityGroups[0].[length(IpPermissions),IpPermissionsEgress[].[IpProtocol,FromPort]]' --output json
# Success: 0 ingress rules; egress tcp 443, tcp 7844, udp 7844 only
aws ec2 describe-vpc-endpoints --profile $H --query 'VpcEndpoints[].[ServiceName,VpcEndpointType,State]' --output text
# Success: ssm, ssmmessages, ec2messages, kms, logs (Interface) and s3 (Gateway), all available
aws ec2 describe-flow-logs --profile $H --query 'FlowLogs[].[ResourceId,TrafficType,FlowLogStatus]' --output text   # Success: vpc-...  ALL  ACTIVE
aws ssm get-document --profile $H --name SSM-SessionManagerRunShell --query Content --output text | ConvertFrom-Json |
  Select-Object -ExpandProperty inputs | Select-Object cloudWatchLogGroupName,cloudWatchEncryptionEnabled,kmsKeyId,idleSessionTimeout
# Success: /regulait/demo-host/ssm-sessions  True  <key id>  20
aws kms get-key-rotation-status --profile $H --key-id alias/regulait-demo-host --query KeyRotationEnabled   # Success: true
aws accessanalyzer list-analyzers --profile $H --type ACCOUNT --query 'analyzers[].status' --output text   # Success: ACTIVE
aws inspector2 batch-get-account-status --profile $H --query 'accounts[0].resourceState.[ec2.status,ecr.status]' --output text   # Success: ENABLED ENABLED
aws guardduty list-detectors --profile $H --query 'DetectorIds' --output text                            # Success: a detector id
aws securityhub get-enabled-standards --profile $H --query 'StandardsSubscriptions[].StandardsArn' --output text   # Success: FSBP and CIS
aws dlm get-lifecycle-policies --profile $H --query 'Policies[].[PolicyId,State]' --output text           # Success: policy-...  ENABLED
```

### 8.5 Secrets into SSM Parameter Store (about 10 minutes)

There are five parameters under `/regulait/demo-host/`. Each secret is a **SecureString encrypted with
`alias/regulait-demo-host`**.

| Name | Type | Value |
| --- | --- | --- |
| `public-host` | String | the same hostname as the laptop, `regulait.<domain>` (no scheme) |
| `cf-tunnel-token` | SecureString | the **same** tunnel's token, from the password manager (TUNNEL.md step 1), read at a hidden prompt |
| `data-key` | SecureString | 64 hex characters, generated |
| `bootstrap-token` | SecureString | 48 hex characters, generated |
| `db-password` | SecureString | 48 hex characters, generated |

```powershell
$P = 'regulait-demo-host'; $K = 'alias/regulait-demo-host'; $D = '/regulait/demo-host'
aws ssm put-parameter --profile $P --name "$D/public-host" --type String --value 'regulait.<domain>'

# Each secret goes through a temporary file (your user's temp folder, readable only by you), then the file is deleted.
function Put-DemoSecret([string]$Name, [string]$Value) {
  $f = New-TemporaryFile
  try {
    [IO.File]::WriteAllText($f.FullName, $Value)
    aws ssm put-parameter --profile $P --name "$D/$Name" --type SecureString --key-id $K --value "file://$($f.FullName)" --overwrite --query Version --output text
  } finally { Remove-Item $f -Force }
}
function New-HexSecret([int]$Bytes) {
  $b = New-Object byte[] $Bytes
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
  ($b | ForEach-Object { $_.ToString('x2') }) -join ''
}

$s = Read-Host -AsSecureString 'Tunnel token'      # paste from the password manager; nothing is shown
Put-DemoSecret 'cf-tunnel-token' ([Net.NetworkCredential]::new('', $s).Password)
Remove-Variable s
Put-DemoSecret 'data-key'        (New-HexSecret 32)
Put-DemoSecret 'bootstrap-token' (New-HexSecret 24)
Put-DemoSecret 'db-password'     (New-HexSecret 24)
# Success: each put-parameter prints its version (1 the first time)
```

```bash
P=regulait-demo-host; K=alias/regulait-demo-host; D=/regulait/demo-host
aws ssm put-parameter --profile $P --name $D/public-host --type String --value 'regulait.<domain>'
( umask 077; T=$(mktemp)
  printf 'Tunnel token: '; read -rs v; echo; printf '%s' "$v" > "$T"; unset v
  aws ssm put-parameter --profile $P --name $D/cf-tunnel-token --type SecureString --key-id $K --value "file://$T"
  for n in data-key:32 bootstrap-token:24 db-password:24; do
    openssl rand -hex "${n#*:}" | tr -d '\n' > "$T"
    aws ssm put-parameter --profile $P --name "$D/${n%%:*}" --type SecureString --key-id $K --value "file://$T"
  done
  rm -f "$T" )
```

**Check (names and types only; never add `--with-decryption` on the laptop):**

```powershell
aws ssm get-parameters-by-path --profile $P --path $D --query 'Parameters[].[Name,Type]' --output text
# Success: five names, four SecureString and one String
```

(The host's own read is checked in 8.6 by `demo-host-env.sh check`.) The bootstrap token is the full-admin credential
of §7.10's `BOOT`. When you need it, read it on the host (8.8) and never onto the laptop's screen.

### 8.6 Deploy the stack on the host (about 20 to 30 minutes, mostly the first build)

Ship the exact commit as a `git archive` through the host's own source bucket. The host holds no Git credential.

```powershell
git fetch origin main
$Sha = git rev-parse origin/main            # or the commit you choose; check: git branch -r --contains $Sha lists origin/main
$Tar = Join-Path $env:TEMP "regulait-$Sha.tar.gz"
git archive --format=tar.gz -o $Tar $Sha
aws s3 cp $Tar "s3://$SrcBucket/regulait-$Sha.tar.gz" --profile regulait-demo-host --only-show-errors
Remove-Item $Tar
aws s3 ls "s3://$SrcBucket/" --profile regulait-demo-host   # Success: regulait-<sha>.tar.gz listed
```

Extract, write `.env` from SSM, run the checks, and build. The stack starts **without** the tunnel connector, so the
laptop keeps serving until 8.7:

```powershell
Invoke-DemoHost @(
  "set -e",
  "mkdir -p /opt/releases/$Sha && cd /opt/releases/$Sha",
  "aws s3 cp s3://$SrcBucket/regulait-$Sha.tar.gz - | tar xz",
  "ln -sfn /opt/releases/$Sha /opt/app && cd /opt/app",
  "bash infra/scripts/demo-host-env.sh check",
  "bash infra/scripts/demo-host-env.sh write",
  "echo project=`$(grep -c '^COMPOSE_PROJECT_NAME=regulait$' .env) demo_license=`$(grep -c '^REGULAIT_DEMO_LICENSE' .env || true) token_in_file=`$(grep -c '^REGULAIT_CF_TUNNEL_TOKEN' .env || true)",
  "bash infra/scripts/demo-host-env.sh tunnel-check",
  "bash infra/scripts/demo-host-env.sh compose --profile tunnel up -d --build --scale cloudflared=0",
  "docker compose ps --format '{{.Service}} {{.State}} {{.Health}}'"
)
# Success: status Success; "all five parameters present and well-formed"; project=1 demo_license=0 token_in_file=0;
#          one tunnel-check "ok" line; gateway running healthy, caddy-tunnel running, no cloudflared
```

In bash, use `demo_host` with the same strings, written without the PowerShell backticks before `$(`.

**Check:**

```powershell
Invoke-DemoHost 'cd /opt/app && docker compose logs gateway | grep -c "demo prep" || true'   # Success: 0
```

**The export-signing key** (§7.6 step 5) and **the nightly backup** (ADR-0035):

```powershell
Invoke-DemoHost 'cd /opt/app && docker compose exec -T -e REGULAIT_DEMO_KEY_DIR=/app/demo-license-keys/export-signing gateway node apps/gateway/dist/demo-export-key.js'
# Success: prints the key's path and fingerprint (never the key)

$env:ENV_DIR = 'infra/environments/demo-host/host'; $env:AWS_PROFILE = 'regulait-demo-host'; $env:AWS_REGION = '<region>'
& "$env:ProgramFiles\Git\bin\bash.exe" infra/scripts/install-pg-backup.sh
Remove-Item Env:ENV_DIR; $env:AWS_PROFILE = '<profile>'
Invoke-DemoHost '/usr/local/sbin/regulait-pg-backup.sh --run', '/usr/local/sbin/regulait-pg-backup.sh --check'
# Success: RESULT=OK, and the newest object listed under s3://<backup bucket>/postgres/
```

**Secrets in tmpfs at every boot, and the hardening fallback.** `write` puts the env file in `/run/regulait` (tmpfs)
and links `/opt/app/.env` to it. Install the boot unit once, so a reboot rebuilds it from SSM before Docker starts:

```powershell
Invoke-DemoHost 'cd /opt/app && bash infra/scripts/demo-host-env.sh install-boot', 'stat -f -c %T /run', 'readlink /opt/app/.env', 'systemctl is-enabled regulait-env.service'
# Success: "regulait-env.service enabled"; tmpfs; /run/regulait/env; enabled
```

The override adds `no-new-privileges` and dropped capabilities to `gateway`, `db` and the object store. These are
untested on a real host. **If a container fails to start** (`docker compose ps` shows it restarting), rebuild the
override without them and record it on #453:
`Invoke-DemoHost 'cd /opt/app && bash infra/scripts/demo-host-env.sh write --no-harden && bash infra/scripts/demo-host-env.sh compose --profile tunnel up -d'`.
**Never `cat` or print `.env` in an SSM shell:** session transcripts go to CloudWatch.

**A later redeploy** of a new `<sha>` repeats this step. It goes into a new `/opt/releases/<sha>` and re-points the
symlink, and the fixed project name keeps the same containers and volumes. Before 8.8 that is safe; after 8.8, run
`--run` (a backup) first. Never `docker compose ... down -v` on the host after 8.8, for the same reason as §7.6
("Once only").

### 8.7 Move the tunnel connector to the host (about 2 minutes)

The host's `cloudflared` reads the token **from SSM, on the host** (`demo-host-env.sh compose`), and keeps it only in
that one process's environment. Both connectors use the same token, and Cloudflare would split traffic between two
databases if both ran. So the laptop's connector stops first.

```powershell
# laptop, in the checkout
docker compose --profile tunnel stop cloudflared
docker compose ps cloudflared --format '{{.State}}'     # Success: exited (or nothing)
# host
Invoke-DemoHost 'cd /opt/app && bash infra/scripts/demo-host-env.sh compose --profile tunnel up -d cloudflared', 'sleep 15', 'cd /opt/app && docker compose logs cloudflared | grep -c "Registered tunnel connection"'
# Success: a number of 1 or more
```

**Check from the laptop:**

```powershell
(Invoke-WebRequest -UseBasicParsing -Uri 'https://regulait.<domain>/ui' -Method Head).StatusCode   # Success: 200
Invoke-DemoHost 'cd /opt/app && docker compose ps cloudflared --format "{{.State}}"'           # Success: running
```

From now until a rollback, **never run `docker compose --profile tunnel up -d` on the laptop without
`--scale cloudflared=0`**, or the laptop rejoins the tunnel.

### 8.7 b Cloudflare edge: Access, TLS and a rate limit (about 20 minutes)

Put **Cloudflare Access** in front of the hostname, so only the security team and the presenters reach it. Run these
from PowerShell with a **Cloudflare API token** that has *Access: Apps and Policies Edit*, *Zone Settings Edit* and
*Zone WAF Edit*. Read the token at a hidden prompt; it lives only in this window. Account id, zone id, e-mail
addresses and the security team's addresses go into the variables here and nowhere in the repository.

```powershell
$cf = Read-Host -AsSecureString 'Cloudflare API token'
$Hd = @{ Authorization = 'Bearer ' + [Net.NetworkCredential]::new('', $cf).Password; 'Content-Type' = 'application/json' }
Remove-Variable cf
$Acct = '<cloudflare account id>'; $Zone = '<zone id>'; $Hn = 'regulait.<domain>'
$Api = 'https://api.cloudflare.com/client/v4'

# 1. who may in: named people (or swap in the security team's IdP group, or an IP list)
$allow = @{ name = 'regulait-demo-allow'; decision = 'allow'; session_duration = '8h'
  include = @(@{ email = @{ email = '<presenter@company>' } }, @{ email_domain = @{ domain = '<security team e-mail domain>' } }) } | ConvertTo-Json -Depth 6
$AllowId = (Invoke-RestMethod -Method Post -Uri "$Api/accounts/$Acct/access/policies" -Headers $Hd -Body $allow).result.id
$bypass = @{ name = 'regulait-machine-paths'; decision = 'bypass'; include = @(@{ everyone = @{} }) } | ConvertTo-Json -Depth 6
$BypassId = (Invoke-RestMethod -Method Post -Uri "$Api/accounts/$Acct/access/policies" -Headers $Hd -Body $bypass).result.id

# 2. the app for people
$app = @{ name = 'regulait-demo'; type = 'self_hosted'; domain = $Hn; session_duration = '8h'
  app_launcher_visible = $false; policies = @(@{ id = $AllowId; precedence = 1 }) } | ConvertTo-Json -Depth 6
Invoke-RestMethod -Method Post -Uri "$Api/accounts/$Acct/access/apps" -Headers $Hd -Body $app | Select-Object success

# 3. machine paths that must stay reachable without a browser sign-in. Each is authenticated by RegulAIt itself:
#    the federation issuer (AWS and Azure fetch its JWKS), the MCP endpoint (the agent beat), PM and chat-ops webhooks
#    (signed). Without these, live discovery and the agent beats fail.
foreach ($path in '/federation', '/mcp', '/v1/pm/webhooks', '/v1/chatops') {
  $b = @{ name = "regulait-bypass$($path -replace '/','-')"; type = 'self_hosted'; domain = "$Hn$path"
    policies = @(@{ id = $BypassId; precedence = 1 }) } | ConvertTo-Json -Depth 6
  Invoke-RestMethod -Method Post -Uri "$Api/accounts/$Acct/access/apps" -Headers $Hd -Body $b | Select-Object success
}

# 4. TLS Full (strict) and TLS 1.2 minimum
Invoke-RestMethod -Method Patch -Uri "$Api/zones/$Zone/settings/ssl" -Headers $Hd -Body '{"value":"strict"}' | Select-Object success
Invoke-RestMethod -Method Patch -Uri "$Api/zones/$Zone/settings/min_tls_version" -Headers $Hd -Body '{"value":"1.2"}' | Select-Object success

# 5. a rate limit on the hostname (free-plan limits: 10-second period and timeout; raise both on a paid plan)
$rl = @{ rules = @(@{ description = 'regulait-demo rate limit'; action = 'block'
  expression = "(http.host eq `"$Hn`")"
  ratelimit = @{ characteristics = @('ip.src', 'cf.colo.id'); period = 10; requests_per_period = 100; mitigation_timeout = 10 } }) } | ConvertTo-Json -Depth 8
Invoke-RestMethod -Method Put -Uri "$Api/zones/$Zone/rulesets/phases/http_ratelimit/entrypoint" -Headers $Hd -Body $rl | Select-Object success
Remove-Variable Hd
```

**Success:** every call prints `success: True`. **Check:**

```powershell
(Invoke-WebRequest -UseBasicParsing -Uri 'https://regulait.<domain>/ui' -MaximumRedirection 0 -ErrorAction SilentlyContinue).StatusCode
# Success: 302 (to the Access sign-in) in a fresh window with no Access cookie
(Invoke-WebRequest -UseBasicParsing -Uri 'https://regulait.<domain>/federation/.well-known/openid-configuration').StatusCode
# Success: 200 (the issuer stays public, after federation is on in 8.8 step 4)
```

The laptop's §7.10 calls (`GW=https://regulait.<domain>`) are now behind Access. Run them **on the host** with
`GW=http://127.0.0.1:3000` (the gateway is published on the host's loopback only), or authenticate the laptop's
terminal with `cloudflared access login`. **Rollback of the edge:** delete the five Access apps in the same way (`DELETE
$Api/accounts/$Acct/access/apps/<id>`). The tunnel itself is unchanged.

### 8.8 Live prepare and checks over SSM (about 60 to 90 minutes)

These are the laptop recipes of §7.6, run on the host. Non-interactive steps go through `Invoke-DemoHost`. Steps that
ask for a password or an authenticator code use an SSM shell (`aws ssm start-session`), because `send-command` cannot
answer a prompt.

1. **Live prep** (§7.6 step 6):

   ```powershell
   Invoke-DemoHost 'cd /opt/app && docker compose exec -T gateway node apps/gateway/dist/demo-prepare.js --live'
   # Success: exactly one FAIL, "1 Real discovery sources"; any other FAIL: stop and report
   ```

2. **Passwords and admin MFA** (§7.6 step 7). Open an SSM shell. On the host the password is read at a hidden prompt:

   ```powershell
   aws ssm start-session --profile regulait-demo-host --target $env:DEMO_INSTANCE
   ```

   ```bash
   # on the host
   sudo -i
   cd /opt/app
   printf 'Demo password: '; read -rs REGULAIT_DEMO_USER_PASSWORD; echo; export REGULAIT_DEMO_USER_PASSWORD
   docker compose exec -e REGULAIT_DEMO_USER_PASSWORD gateway node apps/gateway/dist/demo-set-passwords.js
   unset REGULAIT_DEMO_USER_PASSWORD
   exit; exit
   ```

   Then do the `admin` and `morgan` authenticator enrolment in new private browser windows, as in §7.6 step 7.

3. **Check** (§7.6 step 8):

   ```powershell
   Invoke-DemoHost 'cd /opt/app && docker compose exec -T gateway node apps/gateway/dist/demo-check.js --live'
   # Success: the single FAIL of step 1, nothing else
   ```

4. **Discovery and the sandbox trust.** The federation **issuer is unchanged** (ADR-0228: same `REGULAIT_PUBLIC_URL`),
   so the OIDC provider and the key trust need no re-pointing. The sources, however, are new rows with **new ids**,
   and each trust pins its source id. So: run `DEMO_REAL_ACCOUNTS.md` step 1b (federation on) and step 2 (create the
   sources and copy their ids). Then put the new ids into `aws_discovery_source_id` and `azure_discovery_source_id`
   and re-plan both sandbox stacks:

   ```powershell
   Set-Location infra/environments/demo-sandbox/aws;   terraform plan -out=tfplan
   # Success: only the role's trust policy changes (the subject). Then:
   terraform apply tfplan; Set-Location ../../../..
   Set-Location infra/environments/demo-sandbox/azure; terraform plan -out=tfplan
   # Success: only the federated credential's subject changes. Then:
   terraform apply tfplan; Set-Location ../../../..
   ```

   Enable one source (`DEMO_REAL_ACCOUNTS.md` step 7), then run step 3 again. **Success: 0 FAIL.**

5. **§7.11 (Act 3) and §7.12 (Act 4)** set-up rows, in their stated order (the Claude key goes in after the
   `demo:traffic` re-run). `GW` is the same `https://regulait.<domain>`. Where §7.10 reads `BOOT` with `read -rs`,
   read it on the host instead, in an SSM shell, without printing it:

   ```bash
   # on the host, as root
   BOOT=$(aws ssm get-parameter --name /regulait/demo-host/bootstrap-token --with-decryption --query Parameter.Value --output text \
     --region "$(curl -fsS -H "X-aws-ec2-metadata-token: $(curl -fsS -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 60')" http://169.254.169.254/latest/meta-data/placement/region)")
   export BOOT
   ```

6. **`demo:relax-e`** at T-24h, before any E rehearsal (§7.3 row E). Do it either in the UI as Ada, or in an SSM shell:

   ```bash
   # on the host, as root, in /opt/app
   printf 'Ada password: '; read -rs REGULAIT_DEMO_ADMIN_PASSWORD; echo; export REGULAIT_DEMO_ADMIN_PASSWORD
   docker compose exec -e REGULAIT_DEMO_ADMIN_PASSWORD gateway node apps/gateway/dist/demo-relax-e.js
   unset REGULAIT_DEMO_ADMIN_PASSWORD
   ```

7. **G3** (§7.6): the stage terminal is an SSM shell on the host. Make the script once:

   ```bash
   # on the host, as root
   printf '#!/bin/sh\ncd /opt/app && docker compose exec -T gateway node apps/gateway/dist/demo-gate.js "Real-Time Fraud Detection Engine" staging "${1:-demo-build}"\n' > /root/g3.sh && chmod +x /root/g3.sh
   /root/g3.sh t24h > /root/real-gate.txt; cat /root/real-gate.txt   # Success: the DENY line and two BLOCK lines
   ```

### 8.9 Rehearsal on the instance (Sunday afternoon)

Run the run of show (§3) end to end against `https://regulait.<domain>`. Beats that change state go on FALLBACK only
(§7.3). Then:

```powershell
Invoke-DemoHost 'cd /opt/app && docker compose exec -T gateway node apps/gateway/dist/demo-check.js --live'   # Success: 0 FAIL
Invoke-DemoHost '/usr/local/sbin/regulait-pg-backup.sh --run'                                                  # Success: RESULT=OK (Sunday evening's backup)
aws cloudwatch describe-alarms --profile regulait-demo-host --alarm-name-prefix regulait-demo-host `
  --query 'MetricAlarms[].[AlarmName,StateValue]' --output text                                                # Success: OK
```

**Owner alternative, not scripted here:** instead of preparing afresh in 8.8, you could restore the laptop's live
database, data key and volumes onto the host. That keeps the source ids, the federation key and the MFA enrolments, so
8.8 step 4's re-apply is not needed. It is a manual data migration with its own risk. Decide before 8.8.

### 8.9 a Go-live posture checklist (Sunday evening; every row must pass)

Run these on the host in an SSM shell, as root in `/opt/app`, with `BOOT` read as in 8.8 step 5 and
`GW=http://127.0.0.1:3000`. No command prints a secret.

| # | Check | Command (on the host) | Pass |
| --- | --- | --- | --- |
| 1 | **Step-up on** (it is off on the laptop stacks) | `curl -fsS -H "authorization: Bearer $BOOT" $GW/v1/org/settings \| jq -r .step_up_mode` | `required`. If not, set **Step-up** to required on `/ui/admin/organization` as Ada (a tightening, so no step-up is asked) |
| 2 | **Admin MFA** on `admin` and `morgan` (8.8 step 2) | sign in as each in a private window | the 6-digit code screen appears |
| 3 | **Synthetic data only** | `grep -c '^REGULAIT_DEMO_LICENSE' .env` is `0`, and the seed's fictional company names only; no customer data was imported | `0`; reviewed |
| 4 | **Demo password rotated** after any rehearsal it was shown in (8.13) | `demo-set-passwords.js` re-run in 8.13 | done Sunday evening |
| 5 | **Strict CSP and CORS** | `curl -sSI $GW/ui \| grep -i '^content-security-policy'` and `curl -sSI -H 'Origin: https://evil.invalid' $GW/v1/org/posture \| grep -ci '^access-control-allow-origin'` | a CSP with no `unsafe-inline` in `script-src`; `0` |
| 6 | **Bootstrap token posture** | `curl -fsS -H "authorization: Bearer $BOOT" $GW/v1/org/posture \| jq .` | review `bootstrap_token_configured`; rotate it after set-up (8.13) |
| 7 | **No public IP, no ingress, egress 3 rules, endpoints, flow logs, session logging** | 8.4 "Check the security controls" | all as stated there |
| 8 | **Backups and snapshots** | `/usr/local/sbin/regulait-pg-backup.sh --check`; `aws dlm get-lifecycle-policies` (laptop) | a backup from today; ENABLED |

### 8.10 Rollback to the laptop (about 2 minutes; keep this window open on Monday)

```powershell
Invoke-DemoHost 'cd /opt/app && docker compose --profile tunnel stop cloudflared'   # host connector off
docker compose --profile tunnel up -d cloudflared                                     # laptop, in the TUNNEL.md window (token set)
docker compose logs cloudflared | Select-String -Pattern 'Registered tunnel connection' | Measure-Object | Select-Object -ExpandProperty Count
# Success: 1 or more
(Invoke-WebRequest -UseBasicParsing -Uri 'https://regulait.<domain>/ui' -Method Head).StatusCode   # Success: 200
```

The laptop's stack and database were left untouched, so it serves exactly what it served before 8.7. If 8.8 step 4
re-applied the sandbox trust for the host's source ids, live discovery on the laptop fails until the trust is
re-applied with the laptop's ids. The seeded discovery dataset remains its fallback (ADR-0203 decision 2). To return
to the host, run 8.7 again.

### 8.11 Teardown after the demo (about 30 minutes)

```powershell
# 1. stop the host's connector; take and check a last backup
Invoke-DemoHost 'cd /opt/app && docker compose --profile tunnel stop cloudflared', '/usr/local/sbin/regulait-pg-backup.sh --run'
# 2. the host. The backup bucket refuses to be destroyed while it holds backups (force_destroy = false):
#    empty it only once the backups are no longer wanted. The KMS key enters a 30-day deletion window.
Set-Location infra/environments/demo-host/host; terraform plan -destroy -out=tfplan; terraform apply tfplan; Set-Location ../../../..
# 3. the parameters
aws ssm delete-parameters --profile regulait-demo-host --names /regulait/demo-host/public-host /regulait/demo-host/cf-tunnel-token /regulait/demo-host/data-key /regulait/demo-host/bootstrap-token /regulait/demo-host/db-password
# 4. keep demo-host/baseline until the ADR-0013 successor (Fargate, RDS, WAF, HA) replaces it, or destroy it the same way
# 5. the member account (closed; AWS keeps it suspended for 90 days)
Set-Location infra/environments/demo-host/account; terraform plan -destroy -out=tfplan; terraform apply tfplan; Set-Location ../../../..
```

**Check:**

```powershell
aws ec2 describe-instances --profile regulait-demo-host --filters Name=tag:Stack,Values=demo-host-host `
  --query 'Reservations[].Instances[].State.Name' --output text   # Success: terminated (or nothing)
aws ssm get-parameters-by-path --profile regulait-demo-host --path /regulait/demo-host --query 'length(Parameters)'   # Success: 0
```

Keep the laptop stack until the host's backups are confirmed. After that, the laptop holds nothing the demo needs.

### 8.12 Cost

| Item | About, per month (`us-east-1`, on demand) |
| --- | --- |
| `t3.xlarge` (4 vCPU, 16 GiB), always on | USD 120 |
| EBS gp3, 40 GB root and 60 GB data | USD 8 |
| public IPv4 (the NAT gateway's only; the instance has none) | USD 4 |
| KMS key, CloudWatch logs (30 days), backups (30 days) | under USD 5 |
| baseline: Config, Security Hub, GuardDuty, CloudTrail | about USD 5 to 15 |
| NAT gateway (one, plus data) | about USD 35 |
| 5 interface VPC endpoints, one AZ | about USD 37 |
| flow logs, Inspector, DLM snapshots (7 days) | about USD 5 to 10 |

That is about USD 7 to 8 a day while the host runs. The demo-host account's budget alert is USD 100, with 80 % and
forecast alerts. A `t3.large` (8 GiB) halves the instance cost but leaves little headroom for the on-host build. **The
sandbox keeps its USD 50 cap** (ADR-0197): the host does not count against it and does not change it.

### 8.13 Rotation and revocation (demo password, tunnel token, model API key)

Each secret has a rotate step, which keeps the demo running, and a revoke step, which runs after the demo or on any
suspicion of exposure.

**Demo password.** Rotate it Sunday evening, after the last rehearsal, and again after the demo. On the host, in an
SSM shell, re-run 8.8 step 2. It reads the new password at a hidden prompt, sets it for every persona, and clears the
two admins' lockouts. **Revoke:** the same command with a long random value nobody records. **Check:** signing in with
the old password fails.

**Tunnel token.** **Rotate:** in Cloudflare, refresh the tunnel's token (TUNNEL.md, "Stopping and rolling back"), then:

```powershell
$s = Read-Host -AsSecureString 'New tunnel token'
Put-DemoSecret 'cf-tunnel-token' ([Net.NetworkCredential]::new('', $s).Password)   # 8.5's helper (it overwrites)
Remove-Variable s
Invoke-DemoHost 'cd /opt/app && bash infra/scripts/demo-host-env.sh compose --profile tunnel up -d --force-recreate cloudflared'
```

**Check:** the connector registers again (8.7), and the old token no longer connects. **Revoke:** delete the tunnel
(TUNNEL.md) and the parameter (8.11). The laptop's copy of the token in the password manager is then dead too.

**Model API key (the Claude key of §7.10 and §7.11).** Use a **dedicated** key, created for the demo in the provider's
console with a **spend limit** set there. It is entered only in the RegulAIt UI (§7.11), which stores it encrypted with
the data key. It is never in SSM, a file or a terminal. **Rotate:** create a new key in the provider console, replace
the credential in the UI (step-up), and delete the old key in the console. **Revoke after the demo:** delete the key
in the provider's console, then delete the credential in the UI. **Check:** the provider console lists no active demo
key.

**Data key, bootstrap token, database password.** They are not rotated during the demo: rotating the data key needs
the product's re-encryption procedure. After the demo, 8.11 deletes them with the host. The bootstrap token is the
full-admin credential: after set-up, remove it from use by deleting the parameter and recreating the gateway without
it, or leave it until teardown and list it as a residual (DEMO_HOST_SECURITY_BRIEF.md).
