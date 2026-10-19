// Dev-server only (kit-contain.mock.spec.ts): mounts one contained Card, or with
// view=info a sortable table with (i) buttons, so their behaviour can be driven
// in a real browser. Never part of the build.
import { StrictMode, useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "../../src/theme/tokens.css";
import "../../src/theme/global.css";
import { Card, InfoButton, Table } from "../../src/ui/kit";

const params = new URLSearchParams(location.search);
const variant = params.get("variant");

function Toggle() {
  const [on, setOn] = useState(false);
  return (
    <button type="button" id="contain-toggle" data-testid="contain-toggle" aria-pressed={on} onClick={() => setOn(!on)}>
      Pin
    </button>
  );
}

// records whether the body was in the document when its layout effects first ran
function Probe() {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const w = window as unknown as { probeConnected?: boolean[] };
    (w.probeConnected ??= []).push(ref.current?.isConnected ?? false);
  }, []);
  return <span ref={ref} />;
}

function InfoHarness() {
  const rows = [{ id: "b", name: "Beta" }, { id: "a", name: "Alpha" }];
  return (
    <main style={{ padding: 16 }}>
      <Table
        rows={rows}
        rowKey={(r) => r.id}
        columns={[{ key: "name", header: "Name", sort: (r) => r.name, info: "The record's display name.", render: (r) => r.name }]}
      />
      <p>Outside</p>
      <div style={{ position: "fixed", bottom: 8, left: 16 }}>
        <InfoButton label="residual risk" term="Residual risk">
          The risk left after controls apply.
        </InfoButton>
      </div>
    </main>
  );
}

function Harness() {
  const [rows, setRows] = useState(Number(params.get("rows") ?? 3));
  const [late, setLate] = useState(false);
  const [contain, setContain] = useState(params.get("contain") !== "late");
  return (
    <main style={{ padding: 16 }}>
      <button type="button" onClick={() => setContain(true)}>
        Contain
      </button>
      <button type="button" onClick={() => setRows((n) => n + 40)}>
        Add rows
      </button>
      <button type="button" onClick={() => setLate(true)}>
        Fail refresh
      </button>
      <Card title="Findings" contain={contain} count={rows}>
        <Probe />
        <Toggle />
        <table>
          <tbody>
            {Array.from({ length: rows }, (_, i) => (
              <tr key={i}>
                <td>Finding {i + 1}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {late && <div role="alert">The last refresh failed.</div>}
        {variant === "alert" && <div role="alert">This list could not be refreshed.</div>}
        {variant === "form" && (
          <form>
            <input aria-label="Reason" />
          </form>
        )}
      </Card>
    </main>
  );
}

const app = params.get("view") === "info" ? <InfoHarness /> : <Harness />;
// strict=0 renders without StrictMode, whose double effects hide first-commit bugs
createRoot(document.getElementById("root")!).render(params.get("strict") === "0" ? app : <StrictMode>{app}</StrictMode>);
