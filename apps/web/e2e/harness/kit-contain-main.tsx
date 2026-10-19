// Dev-server only (kit-contain.mock.spec.ts): mounts one contained Card so its
// behaviour can be driven in a real browser. Never part of the build.
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import "../../src/theme/tokens.css";
import "../../src/theme/global.css";
import { Card } from "../../src/ui/kit";

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

function Harness() {
  const [rows, setRows] = useState(Number(params.get("rows") ?? 3));
  const [late, setLate] = useState(false);
  return (
    <main style={{ padding: 16 }}>
      <button type="button" onClick={() => setRows((n) => n + 40)}>
        Add rows
      </button>
      <button type="button" onClick={() => setLate(true)}>
        Fail refresh
      </button>
      <Card title="Findings" contain count={rows}>
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

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Harness />
  </StrictMode>,
);
