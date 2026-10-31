/**
 * Each infrastructure ledger on its own page (P3, #453 c6527514889): the full list with the shared list control and,
 * where the ledger has governed verbs, the remediation approver and the proposal flow. The Infrastructure overview
 * keeps a five-row preview of each, worst first, with what needs attention counted in its heading.
 */
import { useState, type ReactNode } from "react";
import { Route, Routes } from "react-router-dom";
import InfrastructurePage from "./InfrastructurePage";
import type { InfraBackup, InfraCert, InfraFinding, InfraPatch, InfraResource } from "../../../api/adminTypes";
import { PageHeader } from "../../../shell/AppShell";
import { Card, EmptyState } from "../../../ui/kit";
import { DataList, type DataColumn } from "../../../ui/DataList";
import { SubpageTrail } from "../../../ui/ListPreview";
import { CertRotationsCard } from "./CertRotations";
import { INFRA_PATH, LEDGERS, PROPOSAL_NOTE, backupColumns, tlsLedgerColumns, findingColumns, ledgerQueryKey, patchColumns, resourceColumns, useInfraProposals, type Ledger } from "./infraLedgers";
import v from "../../views.module.css";

function LedgerPage<T>(props: { ledger: Ledger; sub: string; columns: Array<DataColumn<T>>; rowKey: (r: T) => string; empty: ReactNode; before?: ReactNode; after?: ReactNode; trailing?: ReactNode }) {
  const l = props.ledger;
  return (
    <>
      <SubpageTrail parent="Infrastructure" parentTo={INFRA_PATH} current={l.title.split(" — ")[0]!} />
      <PageHeader title={l.title.split(" — ")[0]!} sub={props.sub} />
      <div className={v.stack}>
        <Card title={l.title}>
          <div className={v.stack}>
            {props.before}
            <DataList<T>
              listId={l.listId}
              noun={l.noun}
              endpoint={l.endpoint}
              exportPath={l.exportPath}
              queryKey={ledgerQueryKey(l)}
              legacyKey={l.legacyKey}
              defaultSort={l.defaultSort}
              columns={props.columns}
              rowKey={props.rowKey}
              empty={props.empty}
            />
          </div>
        </Card>
        {props.after}
      </div>
      {props.trailing}
    </>
  );
}

/** the approver, the proposal note and any refusal, above a ledger that proposes governed verbs */
function ProposalHeader(props: { p: ReturnType<typeof useInfraProposals> }) {
  return (
    <>
      {props.p.approverField}
      {props.p.errorLine}
      <p className={v.faint}>{PROPOSAL_NOTE}</p>
    </>
  );
}

export function InfraResourcesPage() {
  return (
    <LedgerPage<InfraResource>
      ledger={LEDGERS.resources}
      sub="Every monitored resource with the backup, patch and auto-remediation floors its classifications cascade onto it."
      columns={resourceColumns(true)}
      rowKey={(r) => r.id}
      empty={<EmptyState title="No monitored resources" body="Register one on the Infrastructure page — mock scans deterministically." />}
    />
  );
}

export function InfraFindingsPage() {
  const p = useInfraProposals();
  return (
    <LedgerPage<InfraFinding>
      ledger={LEDGERS.findings}
      sub="Every finding, worst first. Findings are inert until governed; every critical one is always approval-gated."
      columns={findingColumns(p.propose)}
      rowKey={(f) => f.id}
      empty={<EmptyState title="No findings" body="Run a scan to detect drift, cert expiry, missed backups and CVEs." />}
      before={<ProposalHeader p={p} />}
      trailing={p.modal}
    />
  );
}

export function InfraCertificatesPage() {
  const p = useInfraProposals();
  const [historyCert, setHistoryCert] = useState<InfraCert | null>(null);
  return (
    <LedgerPage<InfraCert>
      ledger={LEDGERS.certificates}
      sub="Every tracked certificate and its rotation history. A rotation happens only after the named approver approves."
      columns={tlsLedgerColumns(p.propose, { open: historyCert?.id ?? null, toggle: (c) => setHistoryCert(historyCert?.id === c.id ? null : c) })}
      rowKey={(c) => c.id}
      empty={<EmptyState title="No certificates tracked" />}
      before={<ProposalHeader p={p} />}
      after={historyCert ? <CertRotationsCard key={historyCert.id} certId={historyCert.id} commonName={historyCert.commonName} onClose={() => setHistoryCert(null)} /> : null}
      trailing={p.modal}
    />
  );
}

export function InfraPatchesPage() {
  const p = useInfraProposals();
  return (
    <LedgerPage<InfraPatch>
      ledger={LEDGERS.patches}
      sub="Every tracked CVE and its patch. Applying one marks it patched only after approval; denying records accepted risk."
      columns={patchColumns(p.propose)}
      rowKey={(x) => x.id}
      empty={<EmptyState title="No CVE patches tracked" />}
      before={<ProposalHeader p={p} />}
      trailing={p.modal}
    />
  );
}

export function InfraBackupsPage() {
  const p = useInfraProposals();
  return (
    <LedgerPage<InfraBackup>
      ledger={LEDGERS.backups}
      sub="Every backup run and restore. A governed restore appends a restore run, only after approval."
      columns={backupColumns(p.propose)}
      rowKey={(b) => b.id}
      empty={<EmptyState title="No backup runs tracked" />}
      before={<ProposalHeader p={p} />}
      trailing={p.modal}
    />
  );
}

/**
 * The Infrastructure area: the overview (with its five-row previews) at the index, each ledger's full list on its own
 * nested route. One lazy chunk mounted at `infrastructure/*`, so the overview and the ledger pages add nothing to the
 * entry bundle (ADR-0196 U4; the SPA route census follows this module — scripts/ui-spa-routes.mjs).
 */
export function InfrastructureArea() {
  return (
    <Routes>
      <Route index element={<InfrastructurePage />} />
      <Route path="resources" element={<InfraResourcesPage />} />
      <Route path="findings" element={<InfraFindingsPage />} />
      <Route path="certificates" element={<InfraCertificatesPage />} />
      <Route path="patches" element={<InfraPatchesPage />} />
      <Route path="backups" element={<InfraBackupsPage />} />
    </Routes>
  );
}
