/** Mirrors ADR-0186 batch4 helpers for the SPA, which has no shared runtime dependency. */
export const BATCH4_STRICT_DEFAULTS={monitorMcpBaselineDays:14,monitorJailbreakThreshold:3,monitorJailbreakWindowHours:24} as const;
export type MonitorThresholdKey=keyof typeof BATCH4_STRICT_DEFAULTS;
export const BATCH4_SETTING_COPY={
  monitorMcpBaselineDays: {
    label: "MCP server baseline (days)",
    strict: "14 days: an agent calling a server it did not call in the last 14 days raises an alert.",
    relaxed: "A longer baseline (up to 90 days) treats more servers as already known, so fewer new ones alert.",
  },
  monitorJailbreakThreshold: {
    label: "Jailbreak findings before an alert",
    strict: "3 findings for one person in the window, followed by an allowed tool call, raise an alert.",
    relaxed: "A higher threshold (up to 100) lets more attempts pass before anyone is told.",
  },
  monitorJailbreakWindowHours: {
    label: "Jailbreak correlation window (hours)",
    strict: "24 hours: findings for one person within a day are counted together.",
    relaxed: "A shorter window (down to 1 hour) counts fewer findings together, so spread-out attempts alert less.",
  },
} as const;
export function batch4SettingRelaxed(key:MonitorThresholdKey,value:number){
 return key==="monitorJailbreakWindowHours"?value<BATCH4_STRICT_DEFAULTS[key]:value>BATCH4_STRICT_DEFAULTS[key];
}
