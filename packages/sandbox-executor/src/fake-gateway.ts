/**
 * Test-only: an in-memory gateway for the executor channel, behind the
 * `ExecutorHttp` seam. It verifies every request proof the way the gateway
 * does (signature under the registered key, `typ`, `iss`/`sub`, `aud`,
 * `htm`, `htu`, `bh`, `iat` window, one-use `jti`) and evaluates reports with
 * the shared evaluator, so the executor package's tests exercise the real
 * contract end to end without a database. The gateway's own suite
 * (`zz-adr0190-i3-executor-core.test.ts`) drives the same executor code
 * against the real app.
 */
import { createHash, randomUUID } from "node:crypto";
import { importJWK, jwtVerify, type JWK } from "jose";
import {
  attestationMaxAgeMinutes,
  canonicalExecutorReport,
  evaluateExecutorReport,
  executionProfileDigest,
  EXECUTOR_PROOF_HEADER,
  EXECUTOR_PROOF_MAX_AGE_SECONDS,
  EXECUTOR_PROOF_MAX_FUTURE_SECONDS,
  EXECUTOR_PROOF_TYP,
  executorAnnounceSchema,
  executorDeclineSchema,
  executorEndSchema,
  executorPlacementReportSchema,
  executorReportDigest,
  executorSelfTestSchema,
  SHIPPED_EXECUTION_PROFILES,
  type AppliedIsolationKind,
  type ExecutionOffer,
  type ExecutionProfileBody,
  type ExecutorBackend,
  type ExecutorNext,
  type ExecutorProfileRef,
  type ExecutorQuarantineCode,
  type ExecutorStreamMessage,
  type ExecutorView,
  type ReportFailure,
} from "@regulait/shared";
import type { ExecutorHttp, ExecutorHttpResponse } from "./client.js";

export interface FakeGatewayOptions {
  issuer: string;
  /** the registered executor: its identity identifier, public key and the admin's registration */
  identifier: string;
  publicJwk: JWK;
  name?: string;
  backend?: ExecutorBackend;
  classesDeclared?: AppliedIsolationKind[];
  /** org ceiling (minutes) */
  attestationMaxAgeMinutes?: number;
  profiles?: ExecutionProfileBody[];
  now?: () => Date;
}

interface Attestation {
  cls: AppliedIsolationKind;
  expiresAt: Date;
}

export interface FakeOfferRecord {
  offer: ExecutionOffer;
  status: "offered" | "accepted" | "placed" | "mismatch" | "declined" | "ended";
  declineReason?: string;
  endOutcome?: string;
  placementId?: string;
  reportSha256?: string;
  failures?: ReportFailure[];
}

/** what the fake gateway did, for assertions */
export interface FakeGatewayLog {
  requests: Array<{ method: string; path: string; status: number; code?: string }>;
  audit: string[];
}

export class FakeExecutorGateway {
  readonly log: FakeGatewayLog = { requests: [], audit: [] };
  readonly offers = new Map<string, FakeOfferRecord>();
  readonly attestations = new Map<string, Attestation>();
  readonly seenJti = new Set<string>();
  status: ExecutorView["status"] = "active";
  quarantineCode: ExecutorQuarantineCode | null = null;
  /** queued stream messages beyond offers (status changes) */
  private readonly pending: ExecutorStreamMessage[] = [];
  /** force the next N requests to answer 503 (transient) */
  failNext = 0;
  /** refuse the proof outright (e.g. the identity was revoked) */
  refuseProof: { status: number; code: string; next?: ExecutorNext } | null = null;
  /** false = the executor is not registered (announce → 401 executor_not_registered) */
  registered = true;
  announced = false;
  runtimeVersion: string | null = null;
  private readonly profiles: ExecutorProfileRef[];
  private readonly opts: Required<Pick<FakeGatewayOptions, "name" | "backend" | "classesDeclared" | "attestationMaxAgeMinutes">> & FakeGatewayOptions;

  constructor(opts: FakeGatewayOptions) {
    this.opts = { name: "fake-exec", backend: "gvisor", classesDeclared: ["hardened_container", "user_space_kernel"], attestationMaxAgeMinutes: 120, ...opts };
    const bodies: ExecutionProfileBody[] = opts.profiles ?? Object.values(SHIPPED_EXECUTION_PROFILES);
    this.profiles = bodies.map((body) => ({ digest: executionProfileDigest(body), name: body.name, version: 1, minClass: body.minClass, body }));
  }

  private now(): Date {
    return (this.opts.now ?? (() => new Date()))();
  }

  view(): ExecutorView {
    return { executorId: "00000000-0000-4000-8000-000000000001", name: this.opts.name, backend: this.opts.backend, classesDeclared: this.opts.classesDeclared, status: this.status, quarantineCode: this.quarantineCode };
  }

  /** the gateway's placement side: offer work to this executor (returns the offer) */
  offer(o: Partial<ExecutionOffer> & { requiredClass: ExecutionOffer["requiredClass"]; profileDigest?: string }): ExecutionOffer {
    const offer: ExecutionOffer = {
      id: randomUUID(),
      workloadKind: "mcp_stdio",
      requiredBy: "workload_kind",
      enforcement: "enforce",
      profileDigest: o.profileDigest ?? this.profiles[0]!.digest,
      imageDigest: `sha256:${"a".repeat(64)}`,
      expiresAt: new Date(this.now().getTime() + 30_000).toISOString(),
      ...o,
    };
    this.offers.set(offer.id, { offer, status: "offered" });
    this.pending.push({ type: "offer", offer });
    return offer;
  }

  quarantine(code: ExecutorQuarantineCode): void {
    this.status = "quarantined";
    this.quarantineCode = code;
    this.log.audit.push(`executor-quarantined:${code}`);
    this.pending.push({ type: "status", status: "quarantined", quarantineCode: code });
    for (const r of this.offers.values()) if (r.status === "offered" || r.status === "accepted") r.status = "declined";
  }
  reenable(): void {
    this.status = "active";
    this.quarantineCode = null;
    this.log.audit.push("executor-reenabled");
    this.pending.push({ type: "status", status: "active", quarantineCode: null });
  }
  revoke(): void {
    this.status = "revoked";
    this.log.audit.push("executor-revoked");
    this.pending.push({ type: "status", status: "revoked", quarantineCode: null });
  }

  private next(): ExecutorNext {
    return this.status === "revoked" ? "revoked" : this.status === "quarantined" ? "quarantined" : "ok";
  }

  /** verify the request proof exactly as the gateway's `executor-channel-auth.ts` does */
  private async verifyProof(method: string, url: string, headers: Record<string, string>, body: string | undefined): Promise<{ ok: true } | { ok: false; code: string }> {
    const proof = headers[EXECUTOR_PROOF_HEADER];
    if (!proof) return { ok: false, code: "proof_missing" };
    const key = await importJWK(this.opts.publicJwk, "EdDSA");
    let payload;
    try {
      const v = await jwtVerify(proof, key, { typ: EXECUTOR_PROOF_TYP, issuer: this.opts.identifier, subject: this.opts.identifier, audience: this.opts.issuer, algorithms: ["EdDSA"], clockTolerance: EXECUTOR_PROOF_MAX_FUTURE_SECONDS, maxTokenAge: `${EXECUTOR_PROOF_MAX_AGE_SECONDS}s`, currentDate: this.now() });
      payload = v.payload;
    } catch {
      return { ok: false, code: "proof_invalid" };
    }
    const u = new URL(url);
    if (payload.htm !== method.toUpperCase()) return { ok: false, code: "proof_htm" };
    if (payload.htu !== `${u.origin}${u.pathname}`) return { ok: false, code: "proof_htu" };
    if (payload.bh !== createHash("sha256").update(body ?? "", "utf8").digest("base64url")) return { ok: false, code: "proof_body" };
    const nowS = Math.floor(this.now().getTime() / 1000);
    if (typeof payload.iat !== "number" || payload.iat > nowS + EXECUTOR_PROOF_MAX_FUTURE_SECONDS || payload.iat < nowS - EXECUTOR_PROOF_MAX_AGE_SECONDS) return { ok: false, code: "proof_stale" };
    if (typeof payload.jti !== "string" || this.seenJti.has(payload.jti)) return { ok: false, code: "proof_replayed" };
    this.seenJti.add(payload.jti);
    return { ok: true };
  }

  private async verifyReportSignature(signed: { report: unknown; signature: { protected: string; signature: string } }): Promise<boolean> {
    const { flattenedVerify } = await import("jose");
    const key = await importJWK(this.opts.publicJwk, "EdDSA");
    try {
      await flattenedVerify({ protected: signed.signature.protected, signature: signed.signature.signature, payload: canonicalExecutorReport(signed.report as never) }, key, { algorithms: ["EdDSA"] });
      return true;
    } catch {
      return false;
    }
  }

  private evaluate(signed: { report: Parameters<typeof evaluateExecutorReport>[0] }, requiredClass?: ExecutionOffer["requiredClass"]) {
    const ref = this.profiles.find((p) => p.digest === signed.report.profileDigest);
    if (!ref) return { verdict: "fail" as const, failures: [{ probe: "report" as const, code: "profile_digest_mismatch" as const }], ref: null };
    const v = evaluateExecutorReport(signed.report, { profile: ref.body, profileDigest: ref.digest, backend: this.opts.backend, classesDeclared: this.opts.classesDeclared, ...(requiredClass ? { requiredClass } : {}) });
    return { ...v, ref };
  }

  /** the `ExecutorHttp` seam */
  http(): ExecutorHttp {
    return async (url, init) => {
      const u = new URL(url);
      const path = u.pathname.replace("/v1/executor-channel", "");
      const answer = (status: number, body: unknown, code?: string): ExecutorHttpResponse => {
        this.log.requests.push({ method: init.method, path, status, ...(code ? { code } : {}) });
        return { status, text: async () => (body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body)) };
      };
      const refuse = (status: number, code: string, extra: Record<string, unknown> = {}) => answer(status, { error: code, next: this.next(), ...extra }, code);
      if (this.failNext > 0) {
        this.failNext -= 1;
        return answer(503, { error: "unavailable" }, "unavailable");
      }
      if (this.refuseProof) return answer(this.refuseProof.status, { error: this.refuseProof.code, ...(this.refuseProof.next ? { next: this.refuseProof.next } : {}) }, this.refuseProof.code);
      const proof = await this.verifyProof(init.method, url, init.headers, init.body);
      if (!proof.ok) return answer(401, { error: proof.code }, proof.code);
      if (!this.registered) return answer(401, { error: "executor_not_registered" }, "executor_not_registered");
      if (this.status === "revoked") return refuse(403, "executor_revoked");
      const json = init.body ? (JSON.parse(init.body) as unknown) : undefined;

      if (path === "/announce" && init.method === "POST") {
        const a = executorAnnounceSchema.safeParse(json);
        if (!a.success) return refuse(400, "invalid_body");
        if (a.data.backend !== this.opts.backend) return refuse(409, "executor_backend_mismatch");
        if (!a.data.classesDeclared.every((c) => this.opts.classesDeclared.includes(c))) return refuse(409, "executor_classes_not_declared");
        this.announced = true;
        this.runtimeVersion = a.data.runtimeVersion;
        this.log.audit.push("executor-announced");
        return answer(200, { executor: this.view(), profiles: this.profiles, attestationMaxAgeMinutes: this.opts.attestationMaxAgeMinutes, next: this.next() });
      }
      if (path === "/self-test" && init.method === "POST") {
        const b = executorSelfTestSchema.safeParse(json);
        if (!b.success) return refuse(400, "invalid_body");
        const results = [];
        for (const signed of b.data.reports) {
          if (!(await this.verifyReportSignature(signed))) return refuse(401, "report_signature_invalid");
          if (signed.report.kind !== "self_test") return refuse(400, "report_kind");
          const v = this.evaluate(signed);
          const expiresAt = v.verdict === "pass" && v.ref ? new Date(this.now().getTime() + attestationMaxAgeMinutes(v.ref.body, this.opts.attestationMaxAgeMinutes) * 60_000) : null;
          if (expiresAt) this.attestations.set(signed.report.profileDigest, { cls: signed.report.class, expiresAt });
          else this.attestations.delete(signed.report.profileDigest);
          this.log.audit.push(`executor-attestation-${v.verdict === "pass" ? "passed" : "failed"}:${signed.report.profileDigest.slice(0, 8)}`);
          results.push({ profileDigest: signed.report.profileDigest, class: signed.report.class, verdict: v.verdict, failures: v.failures, expiresAt: expiresAt?.toISOString() ?? null });
        }
        return answer(200, { results, next: this.next() });
      }
      if (path === "/stream" && init.method === "GET") {
        const lines: ExecutorStreamMessage[] = [{ type: "hello", executor: this.view(), profiles: this.profiles, attestationMaxAgeMinutes: this.opts.attestationMaxAgeMinutes }, ...this.pending.splice(0), { type: "bye", reason: "window" }];
        return answer(200, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
      }
      const m = /^\/offers\/([0-9a-f-]{36})\/(accept|decline|report|end)$/.exec(path);
      if (m && init.method === "POST") {
        const rec = this.offers.get(m[1]!);
        if (!rec) return refuse(404, "offer_unknown");
        if (m[2] === "accept") {
          if (this.status !== "active") return refuse(409, "executor_quarantined");
          if (rec.status !== "offered") return refuse(409, "offer_unavailable");
          if (Date.parse(rec.offer.expiresAt) <= this.now().getTime()) return refuse(409, "offer_expired");
          const att = this.attestations.get(rec.offer.profileDigest);
          if (!att || att.expiresAt.getTime() <= this.now().getTime()) return refuse(409, "attestation_stale");
          rec.status = "accepted";
          return answer(200, { offer: rec.offer, next: this.next() });
        }
        if (m[2] === "decline") {
          const d = executorDeclineSchema.safeParse(json);
          if (!d.success) return refuse(400, "invalid_body");
          if (rec.status !== "offered") return refuse(409, "offer_unavailable");
          rec.status = "declined";
          rec.declineReason = d.data.reason;
          return answer(204, undefined);
        }
        if (m[2] === "report") {
          const r = executorPlacementReportSchema.safeParse(json);
          if (!r.success) return refuse(400, "invalid_body");
          if (rec.status !== "accepted") return refuse(409, "offer_unavailable");
          if (!(await this.verifyReportSignature(r.data.report))) return refuse(401, "report_signature_invalid");
          const rep = r.data.report.report;
          if (rep.kind !== "placement" || rep.offerId !== rec.offer.id) return refuse(400, "report_offer_mismatch");
          const v = this.evaluate(r.data.report, rec.offer.requiredClass);
          rec.reportSha256 = executorReportDigest(rep);
          if (v.verdict === "fail") {
            rec.status = "mismatch";
            rec.failures = v.failures;
            this.log.audit.push("execution-profile-mismatch");
            this.quarantine("execution_profile_mismatch");
            return answer(409, { error: "execution_profile_mismatch", next: "quarantined", failures: v.failures }, "execution_profile_mismatch");
          }
          rec.status = "placed";
          rec.placementId = randomUUID();
          this.log.audit.push("execution-placed");
          return answer(200, { release: true, placementId: rec.placementId, reportSha256: rec.reportSha256, next: this.next() });
        }
        const e = executorEndSchema.safeParse(json);
        if (!e.success) return refuse(400, "invalid_body");
        if (rec.status !== "placed") return refuse(409, "offer_unavailable");
        rec.status = "ended";
        rec.endOutcome = e.data.outcome;
        return answer(204, undefined);
      }
      return answer(404, { error: "not_found" }, "not_found");
    };
  }
}
