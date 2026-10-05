/**
 * ADR-0173 batch 2c — THE SLOT for the Traces page's "Automations" tab.
 *
 * Agent K (monitoring and automation) REPLACES THIS FILE with the automation
 * rules UI (filter + sampling + action). Until then the tab states plainly who
 * sets rules up. Keep the default export and its no-props signature:
 * TracesPage mounts `<TracesAutomationsTab />`.
 */
import { Card } from "../../../ui/kit";
import v from "../../views.module.css";

export default function TracesAutomationsTab() {
  return (
    <Card title="Automations">
      <p className={v.dim}>Automation rules are set up by an admin.</p>
    </Card>
  );
}
