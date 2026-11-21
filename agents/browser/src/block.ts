/**
 * ADR-0334: the block page a governed site is redirected to. It reads only the fixed code and site id in its own
 * query (the blocked page's URL never reaches it), explains the block in plain words, and asks the worker to record it.
 */
import { BROWSER_SITE_CATALOGUE } from "@regulait/shared/browser-governance/constants";
import { blockCopy } from "./copy.js";

const q = new URLSearchParams(location.search);
const code = q.get("code") ?? "no_valid_policy";
const siteId = q.get("site") ?? "";
const copy = blockCopy(code);
const site = BROWSER_SITE_CATALOGUE.find((s) => s.siteId === siteId);

document.getElementById("rg-title")!.textContent = copy.title;
document.getElementById("rg-body")!.textContent = copy.body;
document.getElementById("rg-site")!.textContent = site ? site.host : "";
document.getElementById("rg-code")!.textContent = code;
try {
  chrome.runtime.sendMessage({ type: "blocked", siteId, code }, () => void chrome.runtime.lastError);
} catch {
  /* the worker is restarting: the block itself does not depend on the record */
}
