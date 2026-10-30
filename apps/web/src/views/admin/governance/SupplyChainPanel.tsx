/**
 * ADR-0216 — the supply-chain section of a model artifact, and the trusted signing keys card.
 *
 *  - The requirements are listed at the point of decision: a file passes only with a valid signature from a trusted
 *    key, a completed scan and a format that holds no code. A failing file blocks every model whose card cites it.
 *  - A signature is attached by pasting or choosing the bundle the signing tool wrote; the gateway verifies it.
 *  - An admin may relax named conditions for this file, with a reason and an end date (at most 30 days). The gateway
 *    asks for a step-up; refusals are shown inline.
 */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../../api/client";
import { fmtDay } from "../../../api/format";
import { withStepUp } from "../../../stepup/stepUp";
import { useSession } from "../../../session/SessionContext";
import { Badge, Button, Card, EmptyState, Field, Input, Table, Textarea } from "../../../ui/kit";
import { useToast } from "../../../ui/toast";
import v from "../../views.module.css";
import { refusalText } from "./modelArtifacts";
import {
  CONDITION_LABEL,
  RELAXATION_MAX_DAYS,
  SUPPLY_CHAIN_CONDITIONS,
  conditionLabel,
  dateInputValue,
  parseBundle,
  relaxationExpiry,
  signatureText,
  supplyChainBadge,
  type SigningKey,
  type SupplyChainCondition,
  type SupplyChainState,
} from "./supplyChain";

const KEY = ["admin", "model-artifacts"] as const;
const KEYS = ["admin", "model-signing-keys"] as const;

export function SupplyChainBadge(props: { state: SupplyChainState | undefined | null }) {
  const b = supplyChainBadge(props.state);
  return <Badge tone={b.tone}>{b.label}</Badge>;
}

export function SupplyChainSection(props: { artifactId: string; filename: string; state: SupplyChainState | undefined | null }) {
  const { auth } = useSession();
  const isAdmin = auth?.isAdmin === true;
  const qc = useQueryClient();
  const { toast } = useToast();
  const s = props.state;
  const refresh = () => void qc.invalidateQueries({ queryKey: KEY });
  const [bundleText, setBundleText] = useState("");
  const [sigError, setSigError] = useState<string | null>(null);
  const [sigBusy, setSigBusy] = useState(false);
  const failing = s?.assessment.failing ?? [];
  const [chosen, setChosen] = useState<SupplyChainCondition[]>([]);
  const [reason, setReason] = useState("");
  const [day, setDay] = useState(dateInputValue(new Date(Date.now() + 7 * 86_400_000)));
  const [relaxError, setRelaxError] = useState<string | null>(null);
  const [relaxBusy, setRelaxBusy] = useState(false);
  const url = `/v1/model-artifacts/${encodeURIComponent(props.artifactId)}`;

  const attach = async () => {
    const bundle = parseBundle(bundleText);
    if (!bundle) {
      setSigError("Paste the signature bundle the signing tool wrote (a JSON file).");
      return;
    }
    setSigBusy(true);
    setSigError(null);
    try {
      await api.post(`${url}/signature`, { bundle });
      toast(`Signature verified for ${props.filename}`, "success");
      setBundleText("");
      refresh();
    } catch (e) {
      setSigError(refusalText(e));
      refresh();
    } finally {
      setSigBusy(false);
    }
  };
  const relax = async () => {
    const expiresAt = relaxationExpiry(day);
    if (chosen.length === 0 || !reason.trim() || !expiresAt) {
      setRelaxError(`Choose the conditions to relax, give a reason, and an end date within ${RELAXATION_MAX_DAYS} days.`);
      return;
    }
    setRelaxBusy(true);
    setRelaxError(null);
    try {
      await withStepUp((h) => api.putWithHeaders(`${url}/supply-chain-relaxation`, { conditions: chosen, reason: reason.trim(), expiresAt }, h));
      toast(`Check relaxed for ${props.filename}`, "success");
      setReason("");
      setChosen([]);
      refresh();
    } catch (e) {
      setRelaxError(refusalText(e));
    } finally {
      setRelaxBusy(false);
    }
  };
  const clear = async () => {
    setRelaxBusy(true);
    setRelaxError(null);
    try {
      await api.del(`${url}/supply-chain-relaxation`);
      toast(`Relaxation cleared for ${props.filename}`, "success");
      refresh();
    } catch (e) {
      setRelaxError(refusalText(e));
    } finally {
      setRelaxBusy(false);
    }
  };

  return (
    <div data-testid="supply-chain">
      <div className={v.sectionTitle}>Supply-chain check</div>
      <p className={v.dim}>
        A model built from this file is used only when the file has a valid signature from a trusted key, a completed scan,
        and a format that holds no code. Until then, every model whose card cites it is blocked.
      </p>
      <SupplyChainBadge state={s} />
      {s && (
        <ul>
          {SUPPLY_CHAIN_CONDITIONS.map((c) => (
            <li key={c}>
              {failing.includes(c) ? (s.assessment.uncovered.includes(c) ? <Badge tone="danger">Fails</Badge> : <Badge tone="warn">Relaxed</Badge>) : <Badge tone="ok">Met</Badge>}{" "}
              {c === "unsigned" ? "Signature" : c === "unscanned" ? "Scan" : "Format"}: {failing.includes(c) ? CONDITION_LABEL[c] : c === "unsigned" ? signatureText(s.signature) : "Met"}
            </li>
          ))}
        </ul>
      )}
      {s?.signature.status === "failed" && <div className={v.errLine}>{signatureText(s.signature)}</div>}
      {s?.relaxation && (
        <p className={v.dim}>
          {s.relaxation.expired ? "A relaxation ended on " : "Relaxed until "}
          {fmtDay(s.relaxation.expiresAt, "—")} for: {s.relaxation.conditions.map(conditionLabel).join("; ")}. Reason: {s.relaxation.reason}
        </p>
      )}

      <Field label="Signature bundle" help="The JSON bundle the model-signing tool wrote for this file (key-based signing).">
        <Textarea rows={3} value={bundleText} onChange={(e) => setBundleText(e.target.value)} aria-label="Signature bundle" />
      </Field>
      <Button disabled={sigBusy || !bundleText.trim()} onClick={() => void attach()}>
        Attach signature
      </Button>
      {sigError && (
        <div className={v.errLine} role="alert" data-testid="signature-error">
          {sigError}
        </div>
      )}

      {isAdmin && (failing.length > 0 || s?.relaxation) && (
        <div>
          <div className={v.sectionTitle}>Relax the check for this file</div>
          <p className={v.dim}>
            Lets models that cite this file through despite the conditions you choose, until the end date (at most{" "}
            {RELAXATION_MAX_DAYS} days). You will be asked to confirm it's you, and the reason is recorded in the audit log.
          </p>
          {failing.map((c) => (
            <div key={c}><label>
              <input type="checkbox" checked={chosen.includes(c)} onChange={(e) => setChosen((x) => (e.target.checked ? [...x, c] : x.filter((y) => y !== c)))} />{" "}
              {CONDITION_LABEL[c]}
            </label></div>
          ))}
          <Field label="Reason">
            <Input value={reason} maxLength={1000} onChange={(e) => setReason(e.target.value)} />
          </Field>
          <Field label="Ends on">
            <Input type="date" value={day} min={dateInputValue(new Date())} max={dateInputValue(new Date(Date.now() + RELAXATION_MAX_DAYS * 86_400_000))} onChange={(e) => setDay(e.target.value)} />
          </Field>
          <Button variant="primary" disabled={relaxBusy || failing.length === 0} onClick={() => void relax()}>
            Relax
          </Button>{" "}
          {s?.relaxation && !s.relaxation.expired && (
            <Button disabled={relaxBusy} onClick={() => void clear()}>
              Clear relaxation
            </Button>
          )}
          {relaxError && (
            <div className={v.errLine} role="alert" data-testid="relax-error">
              {relaxError}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** admins only: the keys a signature may verify against (no online lookup; air-gapped installs configure them here) */
export function SigningKeysCard() {
  const { auth } = useSession();
  const isAdmin = auth?.isAdmin === true;
  const qc = useQueryClient();
  const { toast } = useToast();
  const keys = useQuery({ queryKey: KEYS, queryFn: () => api.get<{ keys: SigningKey[] }>("/v1/model-signing-keys"), enabled: isAdmin, retry: false });
  const [name, setName] = useState("");
  const [pem, setPem] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!isAdmin) return null;
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: KEYS });
    void qc.invalidateQueries({ queryKey: KEY });
  };
  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      await withStepUp((h) => api.postWithHeaders("/v1/model-signing-keys", { name: name.trim(), publicKeyPem: pem.trim() }, h));
      toast(`Signing key ${name.trim()} added`, "success");
      setName("");
      setPem("");
      refresh();
    } catch (e) {
      setError(refusalText(e));
    } finally {
      setBusy(false);
    }
  };
  const revoke = async (k: SigningKey) => {
    setError(null);
    try {
      await api.post(`/v1/model-signing-keys/${encodeURIComponent(k.id)}/revoke`, {});
      toast(`Signing key ${k.name} revoked`, "success");
      refresh();
    } catch (e) {
      setError(refusalText(e));
    }
  };
  return (
    <Card title="Trusted signing keys">
      <p className={v.dim}>
        Model signatures are checked against these public keys only; nothing is looked up online. Adding a key widens what is
        trusted, so you will be asked to confirm it's you. Revoking a key takes effect at once, and a revoked key is never
        trusted again. ECDSA P-256 keys only.
      </p>
      <Table<SigningKey>
        rows={keys.data?.keys ?? []}
        loading={keys.isLoading}
        error={keys.error}
        onRetry={() => void keys.refetch()}
        rowKey={(k) => k.id}
        empty={<EmptyState title="No trusted signing keys" body="Until a key is added, no model signature can verify, so every model file fails the signature condition." />}
        columns={[
          { key: "name", header: "Name", render: (k) => k.name },
          { key: "hint", header: "Fingerprint", render: (k) => <code>{k.keyHint.slice(0, 16)}…</code> },
          { key: "added", header: "Added", render: (k) => fmtDay(k.createdAt, "—") },
          { key: "state", header: "State", render: (k) => (k.revokedAt ? <Badge tone="neutral">Revoked {fmtDay(k.revokedAt, "")}</Badge> : <Badge tone="ok">Trusted</Badge>) },
          {
            key: "actions",
            header: "",
            srHeader: "Actions",
            render: (k) => (k.revokedAt ? null : (
              <Button size="sm" aria-label={`Revoke ${k.name}`} onClick={() => void revoke(k)}>
                Revoke
              </Button>
            )),
          },
        ]}
      />
      <Field label="Key name">
        <Input value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Public key (PEM)">
        <Textarea rows={4} value={pem} onChange={(e) => setPem(e.target.value)} />
      </Field>
      <Button variant="primary" disabled={busy || !name.trim() || !pem.trim()} onClick={() => void add()}>
        Add key
      </Button>
      {error && (
        <div className={v.errLine} role="alert">
          {error}
        </div>
      )}
    </Card>
  );
}
