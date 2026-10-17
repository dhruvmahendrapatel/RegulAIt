/**
 * ADR-0195 SD3 — import endpoint evidence (osquery results, MDM/EDR inventory)
 * into an enabled endpoint source, and install the endpoint signature seed.
 * A dry run is the default; applying writes findings through the source's run.
 */
import { useState } from "react";
import { api, ApiError } from "../../../api/client";
import { Badge, Button, Card, Field, Select, Table, Textarea } from "../../../ui/kit";
import { useAction } from "../adminKit";
import v from "../../views.module.css";
import type { DiscoverySourceView } from "./discoverySourcesModel";

interface ImportView {
  mode: "dry_run" | "apply";
  runId?: string;
  findingsCreated?: number;
  findingsUpdated?: number;
  summary: {
    rowsParsed: number;
    observations: number;
    refused: number;
    removedRows: number;
    devices: number;
    sightingsMatched: number;
    observationsUnmatched: number;
  };
  matchedArtifacts: Array<{ provider: string; kind: string; value: string; devices: number; rows: number }>;
  catalogueGaps: Array<{ kind: string; value: string }>;
  refusalsTotal: number;
  refusals: Array<{ line: number; item?: number; reason: string }>;
}

const IMPORT_KINDS = new Set(["endpoint_osquery", "endpoint_inventory"]);
const MAX_CHARS = 5_000_000;

export function EndpointImportCard({ sources, onDone }: { sources: readonly DiscoverySourceView[]; onDone: () => Promise<void> }) {
  const act = useAction();
  const targets = sources.filter((s) => IMPORT_KINDS.has(s.kind));
  const [sourceId, setSourceId] = useState("");
  const [format, setFormat] = useState<"csv" | "json">("csv");
  const [mapping, setMapping] = useState("");
  const [content, setContent] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [lenient, setLenient] = useState(false);
  const [result, setResult] = useState<ImportView | null>(null);
  const [refused, setRefused] = useState<{ total: number; rows: ImportView["refusals"] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const chosen = targets.find((s) => s.id === sourceId) ?? null;

  const readFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > MAX_CHARS) return setError(`The file is larger than ${MAX_CHARS} bytes. Split the export.`);
    setError(null);
    setFileName(file.name);
    setContent(await file.text());
  };

  const submit = (mode: "dry_run" | "apply") => {
    if (!chosen) return setError("Choose an endpoint source.");
    if (!content.trim()) return setError("Choose a file or paste its contents.");
    let config: unknown = undefined;
    if (chosen.kind === "endpoint_inventory" && mapping.trim()) {
      try {
        config = JSON.parse(mapping);
      } catch {
        return setError("The inventory configuration is not valid JSON.");
      }
    }
    setError(null);
    setRefused(null);
    const body = {
      content,
      mode,
      onMalformedRow: lenient ? "report_and_continue" : "refuse_file",
      ...(chosen.kind === "endpoint_inventory" ? { format } : {}),
      ...(config !== undefined ? { config } : {}),
      ...(fileName ? { source: fileName.slice(0, 200) } : {}),
    };
    void act.run(async () => {
      try {
        const out = await api.post<ImportView>(`/v1/discovery/sources/${chosen.id}/endpoint-imports`, body);
        setResult(out);
        if (mode === "apply") await onDone();
        return mode === "apply" ? `Imported: ${out.findingsCreated ?? 0} finding(s) created, ${out.findingsUpdated ?? 0} updated` : "Dry run complete";
      } catch (e) {
        if (e instanceof ApiError && e.payload.error === "rows_refused") {
          setRefused({ total: Number(e.payload.refusalsTotal ?? 0), rows: (e.payload.refusals as ImportView["refusals"]) ?? [] });
        }
        throw e;
      }
    });
  };

  const seed = () => {
    void act.run(async () => {
      const out = await api.post<{ inserted: number; refreshed: number }>("/v1/discovery/endpoint-signatures/seed", {});
      return `Endpoint signatures: ${out.inserted} added, ${out.refreshed} refreshed`;
    });
  };

  return (
    <Card title="Import endpoint evidence">
      <div className={v.stack}>
        <p className={v.faint}>
          Upload results of the RegulAIt osquery query pack, or a software inventory exported from your MDM or EDR, into an enabled endpoint source.
          RegulAIt never contacts a device. Device names and users are kept only as pseudonyms, and endpoint evidence follows the endpoint retention
          setting below. Findings appear only for rows that match an enabled signature in your catalogue.
        </p>
        <div className={v.row}>
          <Button size="sm" disabled={act.busy} onClick={seed}>Install endpoint signatures</Button>
        </div>
        {targets.length === 0 ? (
          <p className={v.faint}>Add and enable an osquery results or MDM/EDR inventory source above to import into it.</p>
        ) : (
          <>
            <div className={v.row}>
              <Field label="Endpoint source" error={error}>
                <Select value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
                  <option value="">Choose a source</option>
                  {targets.map((s) => (
                    <option key={s.id} value={s.id} disabled={!s.enabled}>
                      {`${s.name}${s.enabled ? "" : " (disabled)"}`}
                    </option>
                  ))}
                </Select>
              </Field>
              {chosen?.kind === "endpoint_inventory" && (
                <Field label="Format">
                  <Select value={format} onChange={(e) => setFormat(e.target.value as "csv" | "json")}>
                    <option value="csv">CSV</option>
                    <option value="json">JSON</option>
                  </Select>
                </Field>
              )}
            </div>
            <Field label="File">
              <input type="file" aria-label="Endpoint evidence file" onChange={(e) => void readFile(e.target.files?.[0])} />
            </Field>
            <Field label="Or paste the file">
              <Textarea rows={5} spellCheck={false} value={content} onChange={(e) => { setContent(e.target.value); setFileName(null); }} />
            </Field>
            {chosen?.kind === "endpoint_inventory" && (
              <Field label='Inventory configuration (JSON, optional; for example {"mapping": {"device": "Computer", "itemName": "Software"}})'>
                <Textarea rows={3} spellCheck={false} value={mapping} onChange={(e) => setMapping(e.target.value)} />
              </Field>
            )}
            <label className={v.row}>
              <input type="checkbox" checked={lenient} onChange={(e) => setLenient(e.target.checked)} />
              Import the readable rows when some rows are refused (every refusal is still listed)
            </label>
            <div className={v.row}>
              <Button disabled={act.busy || !chosen} onClick={() => submit("dry_run")}>Dry run</Button>
              <Button variant="primary" disabled={act.busy || !chosen?.enabled} onClick={() => submit("apply")}>Import</Button>
            </div>
          </>
        )}
        {refused && (
          <div data-testid="endpoint-import-refusals">
            <p>{`${refused.total} row(s) were refused, so nothing was imported.`}</p>
            <ul>
              {refused.rows.slice(0, 20).map((r, i) => (
                <li key={i}>{`Line ${r.line}${r.item !== undefined ? ` item ${r.item}` : ""}: ${r.reason}`}</li>
              ))}
            </ul>
          </div>
        )}
        {result && (
          <div className={v.stack} data-testid="endpoint-import-result">
            <p>
              <Badge tone={result.mode === "apply" ? "ok" : "neutral"}>{result.mode === "apply" ? "imported" : "dry run"}</Badge>{" "}
              {`${result.summary.rowsParsed} row(s) read, ${result.summary.observations} observation(s) on ${result.summary.devices} device(s), ` +
                `${result.summary.sightingsMatched} matched sighting(s), ${result.summary.observationsUnmatched} unmatched, ${result.summary.refused} refused, ${result.summary.removedRows} removal(s) counted.`}
            </p>
            <Table<ImportView["matchedArtifacts"][number]>
              rows={result.matchedArtifacts}
              rowKey={(a) => `${a.provider}:${a.kind}:${a.value}`}
              columns={[
                { key: "provider", header: "Provider", render: (a) => a.provider },
                { key: "kind", header: "Kind", render: (a) => a.kind },
                { key: "value", header: "Signature", render: (a) => <span className={v.mono}>{a.value}</span> },
                { key: "devices", header: "Devices", render: (a) => String(a.devices) },
              ]}
            />
            {result.catalogueGaps.length > 0 && (
              <p className={v.faint}>{`Not in your catalogue: ${result.catalogueGaps.slice(0, 10).map((g) => g.value).join(", ")}`}</p>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}
