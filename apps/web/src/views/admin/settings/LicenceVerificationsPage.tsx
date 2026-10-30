/**
 * The licence verification trail on its own page (P3, #453 c6527514889): every install, operator-driven check and
 * refusal, with the shared list control. The licensing overview keeps a five-row preview with the refused count in
 * its heading.
 */
import { useMemo, useState } from "react";
import { PageHeader } from "../../../shell/AppShell";
import { Card, Field, Select } from "../../../ui/kit";
import { DataList } from "../../../ui/DataList";
import { VERIFICATION_COLUMNS, VERIFICATIONS_EMPTY, type VerificationRow } from "./licenceVerifications";
import { SubpageTrail } from "../../../ui/ListPreview";
import v from "../../views.module.css";

export default function LicenceVerificationsPage() {
  const [ok, setOk] = useState("");
  const filters = useMemo(() => ({ ok: ok || undefined }), [ok]);
  return (
    <>
      <SubpageTrail parent="Licensing & seats" parentTo="/admin/licensing" current="Verification trail" />
      <PageHeader title="Verification trail" sub="Every install, operator-driven check and refusal on this deployment." />
      <Card flush>
        <div className={v.row} style={{ padding: "var(--s1) var(--s2) 0" }}>
          <Field label="Outcome">
            <Select value={ok} onChange={(e) => setOk(e.target.value)}>
              <option value="">Any</option>
              <option value="true">ok</option>
              <option value="false">refused</option>
            </Select>
          </Field>
        </div>
        <DataList<VerificationRow>
          listId="licence-verifications"
          noun="verifications"
          endpoint="/v1/licenses/verifications"
          exportPath="/v1/licenses/verifications/export.xlsx"
          queryKey={["admin", "license-verifications", "list"]}
          legacyKey="verifications"
          filters={filters}
          defaultSort={{ key: "at", dir: "desc" }}
          rowKey={(c) => c.id}
          empty={VERIFICATIONS_EMPTY}
          columns={VERIFICATION_COLUMNS}
        />
      </Card>
    </>
  );
}
