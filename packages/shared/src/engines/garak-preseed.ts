/**
 * ADR-0187 B5-G — the Hugging Face assets pre-seeded in the garak image (owner 2026-10-10, open question 22;
 * decisions 198-201).
 *
 * The licence-clear assets R10 names (consequence 8): two detector models (Apache-2.0, MIT), six
 * Apache-2.0 package-list datasets and one Apache-2.0 system-prompt dataset. The image build fetches each
 * at the pinned commit, checks every file's sha256 and size and the licence on the card at that commit,
 * writes `refs/main` = that commit, materialises the datasets, and then loads every asset with no network
 * (engines/garak/preseed-hf.py; the file list and hashes are engines/garak/hf-preseed.json, which a test
 * keeps in lockstep with this table). At run time the worker reads them read-only, offline.
 *
 * `usedBy` names the garak plugins (detector or probe, `module.Class`) that load the asset. Admitting a
 * probe whose primary detector or payload needs a Hub asset requires that asset to be listed here.
 */

export interface GarakPreseededAsset {
  kind: "model" | "dataset";
  /** the Hub repository id */
  id: string;
  /** the full commit the image pins (`refs/main` points at it) */
  revision: string;
  /** the licence the card declares at that commit (only MIT or Apache-2.0 is pre-seeded) */
  licence: "apache-2.0" | "mit";
  /** the garak plugins that load it */
  usedBy: readonly string[];
}

export const GARAK_PRESEEDED_HF_ASSETS: readonly GarakPreseededAsset[] = Object.freeze([
  { kind: "model", id: "garak-llm/refutation_detector_distilbert", revision: "906ac60cba379abc1ad1ed328acebeb17357adac", licence: "apache-2.0", usedBy: ["misleading.MustRefuteClaimModel"] },
  { kind: "model", id: "garak-llm/roberta-large-snli_mnli_fever_anli_R1_R2_R3-nli", revision: "75044664e962c6237d48ec4d72fa189fb8723fdc", licence: "mit", usedBy: ["misleading.MustContradictNLI"] },
  { kind: "dataset", id: "garak-llm/pypi-20241031", revision: "d0cb6954a12ebe3e383e9946ab2685efa23130fa", licence: "apache-2.0", usedBy: ["packagehallucination.PythonPypi"] },
  { kind: "dataset", id: "garak-llm/npm-20241031", revision: "98e02cd0a2d568a8b36300431aefba21550a9d34", licence: "apache-2.0", usedBy: ["packagehallucination.JavaScriptNpm"] },
  { kind: "dataset", id: "garak-llm/rubygems-20241031", revision: "51ab0238f9c16b5c31ecfdf935da9fd5abf74647", licence: "apache-2.0", usedBy: ["packagehallucination.RubyGems"] },
  { kind: "dataset", id: "garak-llm/dart-20250811", revision: "f50076de413a4f660d65b398096fae750b35d53b", licence: "apache-2.0", usedBy: ["packagehallucination.Dart"] },
  { kind: "dataset", id: "garak-llm/perl-20250811", revision: "2b41fd08111f283b03d00544121ba438c769db22", licence: "apache-2.0", usedBy: ["packagehallucination.Perl"] },
  { kind: "dataset", id: "garak-llm/raku-20250811", revision: "e2b0b34ad3cb30e6c62076f4cfeb605c94f3a809", licence: "apache-2.0", usedBy: ["packagehallucination.RakuLand"] },
  { kind: "dataset", id: "garak-llm/drh-System-Prompt-processed", revision: "26bb2b284b0380268bc74fe51b1c5eeaccb02242", licence: "apache-2.0", usedBy: ["sysprompt_extraction.SystemPromptExtraction"] },
] satisfies GarakPreseededAsset[]);

/**
 * Probe settings the worker writes into garak's config for a probe (and the config invariant requires,
 * exactly): `sysprompt_extraction.SystemPromptExtraction` names two Hub datasets by default; the second
 * (CC-BY-4.0, admitted by the owner but not pre-seeded) would only fail to load offline, so this build
 * names the pre-seeded one alone and the probe never tries the other.
 */
export const GARAK_PROBE_SETTINGS: Readonly<Record<string, Readonly<Record<string, unknown>>>> = Object.freeze({
  "sysprompt_extraction.SystemPromptExtraction": Object.freeze({ system_prompt_sources: Object.freeze(["garak-llm/drh-System-Prompt-processed"]) }),
});

/** the garak plugins (`module.Class`) that read a pre-seeded asset */
export function garakPreseededPlugins(): Set<string> {
  return new Set(GARAK_PRESEEDED_HF_ASSETS.flatMap((a) => a.usedBy));
}
