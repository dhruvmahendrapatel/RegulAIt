/**
 * Data key custody (ADR-0063).
 *
 * This page exists because of one sentence in ADR-0035 that was true for a long
 * time and never actionable:
 *
 *   > Restoring that backup onto a NEW machine WITHOUT this key recovers every
 *   > user, every audit row, every project — and leaves every credential
 *   > PERMANENTLY undecryptable.
 *
 * The key is deliberately not in the backup, and that is correct. What was
 * missing was any way for an operator to know, before they needed it, whether
 * the key they hold is the right one — and whether anybody holds it at all.
 *
 * So the page renders three facts and nothing decorative:
 *
 *  - the FINGERPRINT this deployment's ciphertext was written under. Non-secret
 *    by construction (a truncated HMAC), and the string an operator compares
 *    against a backup's manifest before restoring it.
 *  - whether the running key MATCHES it. A mismatch here is a gateway that
 *    would refuse to start — shown as a real alarm, not a hint.
 *  - whether anyone has ATTESTED custody, and the page is deliberately blunt
 *    when nobody has. An unattested backup is a backup that may not be
 *    restorable.
 *
 * And it is honest about the attestation's limit in the UI itself, not only in
 * the ADR: submitting the form records a CLAIM. RegulAIt cannot look inside a
 * password manager and does not pretend to.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";
import { PageHeader } from "../../../shell/AppShell";
import { Badge, Button, Card, EmptyState, Field, Input, Select, Table } from "../../../ui/kit";
import { KV, QueryGate, Stat, useAction } from "../adminKit";
import a from "../admin.module.css";
import v from "../../views.module.css";

interface Attestation {
  id: string;
  fingerprint: string;
  attestedByUserId: string | null;
  attestedByLabel: string;
  method: string;
  locationHint: string | null;
  note?: string | null;
  attestedAt: string;
}

interface Status {
  fingerprint: string | null;
  recordedFingerprint: string | null;
  recordedAt: string | null;
  lastVerifiedAt: string | null;
  rotatedFrom: string | null;
  rotatedAt: string | null;
  matches: boolean;
  attested: boolean;
  attestationCount: number;
  latestAttestation: Attestation | null;
  warnings: string[];
  derivation: string;
  posture: string;
}

const METHODS = [
  { value: "password_manager", label: "Password manager (1Password, Bitwarden, …)" },
  { value: "kms", label: "KMS / secret store under an independent key" },
  { value: "escrow", label: "Escrow with a third party" },
  { value: "offline", label: "Offline / physical safe" },
  { value: "other", label: "Other" },
];

export default function DataKeyPage() {
  const act = useAction();
  const [method, setMethod] = useState("password_manager");
  const [locationHint, setLocationHint] = useState("");
  const [note, setNote] = useState("");

  const status = useQuery({
    queryKey: ["admin", "data-key"],
    queryFn: () => api.get<Status>("/v1/security/data-key"),
  });
  const list = useQuery({
    queryKey: ["admin", "data-key-attestations"],
    queryFn: () => api.get<{ attestations: Attestation[] }>("/v1/security/data-key/attestations"),
  });

  const s = status.data;

  const attest = () =>
    void act.run(async () => {
      await api.post("/v1/security/data-key/attestations", {
        method,
        ...(locationHint.trim() ? { locationHint: locationHint.trim() } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
        confirmRecordedOutOfBand: true,
      });
      setLocationHint("");
      setNote("");
      await status.refetch();
      await list.refetch();
    }, "Custody attestation recorded");

  return (
    <>
      <PageHeader
        title="Data key custody"
        sub="REGULAIT_DATA_KEY is the AES-256-GCM envelope over every stored secret — OIDC client secrets, TOTP secrets, model API keys, connector/git/PM tokens, SAML SP keys. It is deliberately NOT in the backup: a key stored beside the ciphertext it protects is not an envelope. This page is how you prove, before you need it, that the key you hold is this deployment's key."
      />
      <div className={v.stack}>
        <QueryGate loading={status.isLoading} error={status.error} onRetry={() => void status.refetch()}>
          <Card title="This deployment's key">
            <div className={a.statRow}>
              <Stat
                value={<code>{s?.recordedFingerprint ?? "—"}</code>}
                label="recorded fingerprint (what the ciphertext was written under)"
              />
              <Stat value={<code>{s?.fingerprint ?? "not set"}</code>} label="running key in the gateway" />
              <Stat
                value={
                  <Badge tone={s?.matches ? "ok" : "danger"}>{s?.matches ? "matches" : "does NOT match"}</Badge>
                }
                label="agreement"
              />
              <Stat
                value={<Badge tone={s?.attested ? "ok" : "danger"}>{s?.attested ? "attested" : "UNATTESTED"}</Badge>}
                label="custody"
              />
            </div>

            {s && !s.matches && (
              <EmptyState
                title="The running key is NOT the key this deployment's data was encrypted under"
                body="A gateway boot would refuse to start in this state, and it should: an app that comes up and then silently fails every decryption looks healthy while it hides the fault. Recover the key whose fingerprint is shown above, or declare a deliberate rotation with REGULAIT_DATA_KEY_ROTATED_FROM."
              />
            )}
            {s && s.matches && !s.attested && (
              <EmptyState
                title="Nobody has ever recorded that this key exists anywhere but this machine"
                body="The key is not in the backup, by design. If this host is lost, a restore recovers every row and leaves every credential permanently undecryptable. Record the key out of band now — then say so below, so the absence stops being invisible."
              />
            )}

            <KV
              rows={[
                ["Fingerprint first recorded", s?.recordedAt ?? <span className={v.faint}>never</span>],
                ["Last verified at boot", s?.lastVerifiedAt ?? <span className={v.faint}>never</span>],
                [
                  "Rotated from",
                  s?.rotatedFrom ? (
                    <>
                      <code>{s.rotatedFrom}</code> on {s.rotatedAt}
                    </>
                  ) : (
                    <span className={v.faint}>never rotated</span>
                  ),
                ],
                ["Attestations on file", s?.attestationCount ?? 0],
              ]}
            />
            {(s?.warnings ?? []).map((w) => (
              <div key={w} className={v.faint}>
                <Badge tone="warn">action</Badge> {w}
              </div>
            ))}
            <div className={v.faint}>{s?.derivation}</div>
            <div className={v.faint}>{s?.posture}</div>
          </Card>

          <Card title="Attest custody">
            <div className={v.faint}>
              This records a <strong>claim</strong>, not a verification. regulAIt cannot reach into a password
              manager, a KMS or a safe, and it will never tell you the key is safe because you ticked a box. What it
              does guarantee is that the <em>absence</em> of this claim is visible — on the gateway boot line, on this
              page, and in every backup run's own output and metric.
            </div>
            <div className={a.formRow}>
              <Field label="Where is it stored?">
                <Select value={method} onChange={(e) => setMethod(e.target.value)}>
                  {METHODS.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Pointer (never the key itself)">
                <Input
                  value={locationHint}
                  placeholder="1Password vault: Platform Ops"
                  onChange={(e) => setLocationHint(e.target.value)}
                />
              </Field>
              <Field label="Note">
                <Input value={note} placeholder="verified during the Q3 restore rehearsal" onChange={(e) => setNote(e.target.value)} />
              </Field>
            </div>
            <div className={v.faint}>
              Do not paste the key into either field. The API refuses any value containing 64 hex characters —
              writing the key there would put it in the database in plaintext, and therefore in the backup, which is
              exactly what the envelope split exists to prevent.
            </div>
            <Button onClick={attest} disabled={act.busy || !s?.fingerprint}>
              I have recorded this key out of band
            </Button>
            {!s?.fingerprint && (
              <div className={v.faint}>
                The gateway is running without REGULAIT_DATA_KEY, so there is no key to attest custody of.
              </div>
            )}
            {act.error && <div className={v.faint}>{act.error}</div>}
          </Card>

          <Card title="Attestation history">
            {(list.data?.attestations ?? []).length === 0 ? (
              <EmptyState title="No attestations" body="Nobody has stated that this key is held anywhere else." />
            ) : (
              <Table
                rows={list.data?.attestations ?? []}
                rowKey={(r) => r.id}
                columns={[
                  { key: "at", header: "When", render: (r) => r.attestedAt },
                  { key: "who", header: "Who", render: (r) => r.attestedByLabel },
                  { key: "how", header: "Method", render: (r) => <Badge tone="info">{r.method}</Badge> },
                  {
                    key: "where",
                    header: "Pointer",
                    render: (r) => r.locationHint ?? <span className={v.faint}>—</span>,
                  },
                  { key: "fp", header: "Fingerprint", render: (r) => <code>{r.fingerprint}</code> },
                ]}
              />
            )}
          </Card>
        </QueryGate>
      </div>
    </>
  );
}
