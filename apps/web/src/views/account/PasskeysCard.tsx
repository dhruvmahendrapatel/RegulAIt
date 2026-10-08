/**
 * ADR-0186 A — Account → Passkeys: add, list and revoke your own passkeys.
 *
 * A passkey is how you confirm it's you for a sensitive action (step-up) and,
 * where your organization requires it, how you sign a tool-call approval.
 * Adding the first one needs a fresh sign-in (or, if you already have another
 * way to confirm it's you, that confirmation); adding another, or revoking
 * one, needs a confirmation with what you already have. Revoked passkeys are
 * kept on record (what they signed stays attributable) and never work again.
 */
import { useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { startRegistration, type PublicKeyCredentialCreationOptionsJSON } from "@simplewebauthn/browser";
import { ApiError, codeSentence } from "../../api/client";
import { ago } from "../../api/format";
import { Badge, Button, Card, EmptyState, Field, Input, Table } from "../../ui/kit";
import { RemoveButton } from "../admin/adminKit";
import { api, withStepUp } from "../../stepup/stepUp";
import v from "../views.module.css";

export interface OwnPasskey {
  id: string;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
  backedUp: boolean;
}

const PASSKEY_SENTENCES: Readonly<Record<string, string>> = {
  fresh_sign_in_required:
    "Adding your first passkey needs a fresh sign-in. Sign out, sign in again, and add it within 10 minutes.",
  passkey_attestation_refused:
    "That passkey sent manufacturer details RegulAIt doesn't accept. Try again, or use a different passkey.",
  passkey_already_registered: "That passkey is already registered to an account.",
  browser_session_required: "Passkeys are managed from a signed-in browser.",
};

function reasonOf(err: unknown): string {
  if (err instanceof ApiError) {
    const code = typeof err.payload.error === "string" ? err.payload.error : "";
    return PASSKEY_SENTENCES[code] ?? (code ? codeSentence(code) : err.message);
  }
  if (err instanceof Error && err.name === "NotAllowedError") return "The passkey prompt was closed or timed out. Nothing was added.";
  if (err instanceof Error && err.name === "InvalidStateError") return "That passkey is already registered on this account.";
  return err instanceof Error ? err.message : String(err);
}

export default function PasskeysCard() {
  const qc = useQueryClient();
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ["account", "passkeys"],
    queryFn: () => api.get<{ passkeys: OwnPasskey[]; rpConfigured: boolean }>("/v1/auth/passkeys"),
  });
  const passkeys = q.data?.passkeys ?? [];
  const rpConfigured = q.data?.rpConfigured !== false;
  const refresh = () => void qc.invalidateQueries({ queryKey: ["account", "passkeys"] });

  const add = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setAdded(null);
    setBusy(true);
    try {
      const opt = await withStepUp((h) =>
        api.post<{ challengeId: string; options: PublicKeyCredentialCreationOptionsJSON }>(
          "/v1/auth/passkeys/registration-options",
          {},
          h,
        ),
      );
      const response = await startRegistration({ optionsJSON: opt.options });
      const name = label.trim() || "Passkey";
      await api.post("/v1/auth/passkeys", { challengeId: opt.challengeId, response, label: name });
      setAdded(name);
      setLabel("");
      refresh();
    } catch (err) {
      setError(reasonOf(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title={
        <span className={v.rowTight}>
          Passkeys
          {passkeys.length > 0 ? <Badge tone="ok">{passkeys.length} active</Badge> : <Badge>none</Badge>}
        </span>
      }
    >
      <div className={v.stack}>
        <div className={v.dim}>
          A passkey lets you confirm it's you with your device's fingerprint, face, PIN or security key. RegulAIt asks
          for it before sensitive actions, such as loosening a security setting or changing who owns something, and
          when you sign a tool-call approval.
        </div>
        {!rpConfigured && (
          <div className={v.errLine} role="alert">
            Passkeys aren't available yet: an administrator has to set this deployment's public address first.
          </div>
        )}
        {error && (
          <div className={v.errLine} role="alert">
            {error}
          </div>
        )}
        {added && (
          <div className={v.faint} role="status">
            Added the passkey "{added}".
          </div>
        )}
        <Table<OwnPasskey>
          columns={[
            {
              key: "label",
              header: "Passkey",
              render: (p) => (
                <span className={v.rowTight}>
                  {p.label}
                  {p.backedUp && <Badge title="synced by your passkey provider">synced</Badge>}
                </span>
              ),
            },
            { key: "created", header: "Added", render: (p) => ago(p.createdAt) },
            { key: "used", header: "Last used", render: (p) => (p.lastUsedAt ? ago(p.lastUsedAt) : "never") },
            {
              key: "actions",
              header: "",
              render: (p) => (
                <RemoveButton
                  label="Revoke"
                  what={`the passkey "${p.label}"`}
                  consequence="It stops working immediately, everywhere. You'll confirm it's you first. It stays on record as revoked, so what it signed is still attributable."
                  onRemove={() => withStepUp((h) => api.del(`/v1/auth/passkeys/${p.id}`, undefined, h))}
                  onDone={refresh}
                />
              ),
            },
          ]}
          rows={passkeys}
          rowKey={(p) => p.id}
          loading={q.isLoading}
          error={q.error}
          onRetry={() => void q.refetch()}
          empty={<EmptyState title="No passkeys yet" body="Add one below to confirm sensitive actions without a code." />}
        />
        <form onSubmit={add} className={v.row} style={{ alignItems: "flex-end" }}>
          <Field label="Name for the new passkey">
            <Input
              value={label}
              maxLength={100}
              placeholder="e.g. Work laptop"
              onChange={(e) => setLabel(e.target.value)}
            />
          </Field>
          <Button variant="primary" type="submit" disabled={busy || !rpConfigured}>
            {busy ? "Waiting for your passkey…" : "Add a passkey"}
          </Button>
        </form>
      </div>
    </Card>
  );
}
