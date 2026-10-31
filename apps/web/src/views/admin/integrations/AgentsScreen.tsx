/**
 * The Agents screen (Integrations > Agents): the agent catalogue and, on its second tab, remote agents reached over the
 * agent-to-agent (A2A) protocol (ADR-0219). Both are the same job (register, credential, grant per person) for two
 * kinds of agent, so they share one navigation entry. The tab is in the URL (`?tab=remote`), so it can be linked to.
 * This wrapper lives in the lazy admin-integrations chunk: it adds nothing to the entry bundle.
 */
import type { ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { Tabs, tabIds } from "../../../ui/kit";
import A2aAgentsPage from "./A2aAgentsPage";
import AgentsPage from "./AgentsPage";

const AGENT_TABS = [
  { id: "catalogue", label: "Catalogue" },
  { id: "remote", label: "Remote agents (A2A)" },
];
const TAB_PARAM = "tab";

/** what a page needs to sit under the tabs: the tab list to show under its header, and its panel's ARIA attributes */
export interface AgentsTabSlot {
  tabs: ReactNode;
  panel: { role: "tabpanel"; id: string; "aria-labelledby": string };
}

export default function AgentsScreen() {
  const [params, setParams] = useSearchParams();
  const tab = params.get(TAB_PARAM) === "remote" ? "remote" : "catalogue";
  const ids = tabIds("agents", tab);
  const slot: AgentsTabSlot = {
    tabs: (
      <Tabs
        tabs={AGENT_TABS}
        active={tab}
        idPrefix="agents"
        label="Kinds of agent"
        onChange={(id) =>
          setParams((prev) => {
            const next = new URLSearchParams(prev);
            if (id === "remote") next.set(TAB_PARAM, id);
            else next.delete(TAB_PARAM);
            return next;
          })
        }
      />
    ),
    panel: { role: "tabpanel", id: ids.panel, "aria-labelledby": ids.tab },
  };
  return tab === "remote" ? <A2aAgentsPage slot={slot} /> : <AgentsPage slot={slot} />;
}
