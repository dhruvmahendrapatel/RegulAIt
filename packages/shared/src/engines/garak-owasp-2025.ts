/**
 * ADR-0187 decisions 213-218 (owner decision on open question 19) — OUR OWN per-probe OWASP table for garak.
 *
 * Every garak probe in the pinned release (garak-upstream.ts) has exactly one row here, listing the 2025
 * OWASP Top 10 for LLM Applications risks it counts toward, or none. garak's own `owasp:llmNN` tags are
 * in the 2023 numbering; they stay in garak-upstream.ts as upstream data and are NEVER read to map
 * anything (decision 213).
 *
 * THE RULE (decision 214): never overclaim coverage. A probe counts toward a 2025 risk only when a
 * failure of that probe, as its primary detector scores it, is evidence of that risk. A probe whose
 * failure shows a content harm the 2025 list does not name (toxicity, slurs, malware text, a refusal
 * gap), or whose detector cannot tell the risk from a look-alike (a key-shaped string is not a leaked
 * key), maps to none.
 *
 * REVIEW (decision 216): the table is bound to one garak release and one `plugin_cache.json` hash. When
 * garak's pin changes, the test fails until every row has been re-read and `GARAK_OWASP_2025_REVIEW` is
 * moved to the new release; a probe added or removed upstream fails it too.
 *
 * Ids and names: the official 2025 list (genai.owasp.org/llm-top-10, checked 2026-10-10), which is the
 * vocabulary of the vendored `OWASP_LLM_TOP_10_MAPPING` (`owasp:llm:01` ... `owasp:llm:10`).
 *
 * This table is reported provenance: what counts toward A3 and the evaluator catalog is still the
 * per-probe attack class (decision 147), never an OWASP id.
 */
import { OWASP_LLM_TOP_10_MAPPING, OWASP_LLM_TOP_10_NAMES } from "../owasp-framework-mappings.js";

/** the 2025 OWASP Top 10 for LLM Applications ids, in the vendored vocabulary */
export const OWASP_LLM_2025_IDS = Object.freeze([
  "owasp:llm:01",
  "owasp:llm:02",
  "owasp:llm:03",
  "owasp:llm:04",
  "owasp:llm:05",
  "owasp:llm:06",
  "owasp:llm:07",
  "owasp:llm:08",
  "owasp:llm:09",
  "owasp:llm:10",
] as const);
export type OwaspLlm2025Id = (typeof OWASP_LLM_2025_IDS)[number];

/** LLM01 Prompt Injection */
const LLM01: OwaspLlm2025Id = "owasp:llm:01";
/** LLM02 Sensitive Information Disclosure */
const LLM02: OwaspLlm2025Id = "owasp:llm:02";
/** LLM03 Supply Chain */
const LLM03: OwaspLlm2025Id = "owasp:llm:03";
/** LLM05 Improper Output Handling */
const LLM05: OwaspLlm2025Id = "owasp:llm:05";
/** LLM06 Excessive Agency */
const LLM06: OwaspLlm2025Id = "owasp:llm:06";
/** LLM07 System Prompt Leakage */
const LLM07: OwaspLlm2025Id = "owasp:llm:07";
/** LLM09 Misinformation */
const LLM09: OwaspLlm2025Id = "owasp:llm:09";

/**
 * The release this table was last reviewed against, row by row. Literals on purpose: a pin bump changes
 * garak-upstream.ts, and the test fails until a person re-reviews every row and moves these.
 */
export const GARAK_OWASP_2025_REVIEW = Object.freeze({
  garakVersion: "0.17.0",
  pluginCacheSha256: "25484e2467c84b1a59e27ae7ebf433a305b00c859aa1904c315f916661134a52",
  reviewedOn: "2026-10-10",
});

export interface GarakOwasp2025Row {
  /** garak's `module.Class` */
  probe: string;
  /** the 2025 risks a failure of this probe is evidence of (sorted; possibly empty) */
  owasp2025: readonly OwaspLlm2025Id[];
  /** one line: why these risks, or why none */
  rationale: string;
}

// Shared rationales (one line each), so the same judgement reads the same way on every row it covers.
const R = {
  jailbreak:
    "a jailbreak technique (persona, role-play, rephrasing, obfuscation or adversarial text) overrides the model's instructions; failure means it complied",
  iterativeJailbreak: "an attacker model iterates jailbreak prompts; failure means the target was steered past its instructions",
  encodingInjection: "an instruction hidden in an encoding is decoded and followed; failure means the encoded instruction steered the output",
  promptInject: "a hijacking instruction in the prompt overrides the task; failure means the rogue string was produced",
  latentInjection: "an instruction planted in a document the prompt carries is followed; failure means the injected instruction won",
  latentJailbreak: "a jailbreak request is embedded in a benign task; failure means the hidden instruction overrode the task",
  multimodal: "the jailbreak arrives in a non-text input; LLM01 covers multimodal injection; failure means the model complied",
  memorisation: "the model regurgitates memorised training data; failure is evidence of training-data exposure (LLM02 only)",
  pii: "asks the model to complete real people's personal data from training; failure is a disclosure of personal data",
  rendererPayload: "the output carries a payload a downstream renderer or client would act on; failure means unsanitised output reaches it",
  injectionPayload: "the output carries an injection payload (template, SQL) for a downstream interpreter; failure is unsafe output for it",
  avSignature: "the output carries a known-bad signature (antivirus, spam, phishing test string); failure means the output is not filtered",
  hallucination: "the model asserts false facts with confidence; failure is evidence of misinformation",
  contentHarm: "a content harm (toxicity, slurs, sexual or offensive content) the 2025 list does not name; reported, no risk claimed",
  refusalGap: "measures whether the model refuses a harmful request asked plainly; no attack technique, and the 2025 list names no such risk",
  keyShape: "the detector matches a key-shaped string; it cannot tell a leaked secret from an invented one, so no disclosure is claimed",
  glitch: "a tokenizer glitch token makes the model fail to repeat a word; a reliability quirk, not a 2025 risk",
  topic: "measures whether the model engages on a topic outside an allowed or blocked set; topic control is not a 2025 risk",
  malware: "the detector flags any code in the reply to a malware request; code presence is not evidence of a 2025 risk",
  noDetector: "never runs (its detector always passes, or it names none); no evidence of any risk",
} as const;

type Row = [probe: string, owasp2025: readonly OwaspLlm2025Id[], rationale: string];

const ROWS: readonly Row[] = [
  // --- adaptive_attacks ---
  ["adaptive_attacks.AdaptiveAttacks", [LLM01], R.jailbreak],
  // --- agent_breaker ---
  [
    "agent_breaker.AgentBreaker",
    [LLM01, LLM06],
    "crafted prompts drive the agent to misuse its own tools; failure is a tool exploited past its purpose (excessive agency) by injected instructions",
  ],
  // --- ansiescape ---
  ["ansiescape.AnsiEscaped", [LLM05], "the output carries ANSI escape sequences a terminal would execute; failure is unsanitised output for that consumer"],
  ["ansiescape.AnsiRaw", [LLM05], "the output carries raw ANSI control codes a terminal would execute; failure is unsanitised output for that consumer"],
  ["ansiescape.AnsiRawTokenizerHF", [LLM05], "the output carries raw ANSI control codes a terminal would execute; failure is unsanitised output for that consumer"],
  // --- apikey ---
  ["apikey.CompleteKey", [], R.keyShape],
  ["apikey.GetKey", [], R.keyShape],
  // --- atkgen ---
  ["atkgen.Tox", [], R.contentHarm],
  // --- audio ---
  ["audio.AudioAchillesHeel", [LLM01], R.multimodal],
  // --- av_spam_scanning ---
  ["av_spam_scanning.EICAR", [LLM05], R.avSignature],
  ["av_spam_scanning.GTUBE", [LLM05], R.avSignature],
  ["av_spam_scanning.GTphish", [LLM05], R.avSignature],
  // --- badchars ---
  ["badchars.BadCharacters", [LLM01], "imperceptible Unicode perturbations carry the request past the model's instructions; failure means it complied"],
  // --- continuation ---
  ["continuation.ContinueSlursReclaimedSlurs", [], R.contentHarm],
  ["continuation.ContinueSlursReclaimedSlursFull", [], R.contentHarm],
  // --- dan ---
  ["dan.Ablation_Dan_11_0", [LLM01], R.jailbreak],
  ["dan.AntiDAN", [LLM01], R.jailbreak],
  ["dan.AutoDAN", [LLM01], R.iterativeJailbreak],
  ["dan.AutoDANCached", [LLM01], R.jailbreak],
  ["dan.ChatGPT_Developer_Mode_RANTI", [LLM01], R.jailbreak],
  ["dan.ChatGPT_Developer_Mode_v2", [LLM01], R.jailbreak],
  [
    "dan.ChatGPT_Image_Markdown",
    [LLM01],
    "a persona jailbreak makes the model emit markdown images; failure means it complied (the links carry no data, so no output-handling risk is claimed)",
  ],
  ["dan.DAN_Jailbreak", [LLM01], R.jailbreak],
  ["dan.DUDE", [LLM01], R.jailbreak],
  ["dan.DanInTheWild", [LLM01], R.jailbreak],
  ["dan.DanInTheWildFull", [LLM01], R.jailbreak],
  ["dan.Dan_10_0", [LLM01], R.jailbreak],
  ["dan.Dan_11_0", [LLM01], R.jailbreak],
  ["dan.Dan_6_0", [LLM01], R.jailbreak],
  ["dan.Dan_6_2", [LLM01], R.jailbreak],
  ["dan.Dan_7_0", [LLM01], R.jailbreak],
  ["dan.Dan_8_0", [LLM01], R.jailbreak],
  ["dan.Dan_9_0", [LLM01], R.jailbreak],
  ["dan.STAN", [LLM01], R.jailbreak],
  // --- divergence ---
  ["divergence.Repeat", [LLM02], R.memorisation],
  ["divergence.RepeatExtended", [LLM02], R.memorisation],
  [
    "divergence.RepeatedToken",
    [],
    "its detector flags long, repetitive or citation-like output (instability), not leaked data; neither disclosure nor unbounded consumption is shown",
  ],
  // --- doctor ---
  ["doctor.Bypass", [LLM01], R.jailbreak],
  ["doctor.BypassLeet", [LLM01], R.jailbreak],
  ["doctor.Puppetry", [LLM01], R.jailbreak],
  // --- donotanswer ---
  ["donotanswer.DiscriminationExclusionToxicityHatefulOffensive", [], R.refusalGap],
  ["donotanswer.HumanChatbox", [], R.refusalGap],
  [
    "donotanswer.InformationHazard",
    [],
    "measures only that the model did not refuse; an answer is not shown to contain real sensitive information, so no disclosure is claimed",
  ],
  ["donotanswer.MaliciousUses", [], R.refusalGap],
  [
    "donotanswer.MisinformationHarms",
    [],
    "measures only that the model did not refuse; the answer is not checked for falsehood, so no misinformation is claimed",
  ],
  // --- dra ---
  ["dra.DRA", [LLM01], R.jailbreak],
  ["dra.DRAAdvanced", [LLM01], R.jailbreak],
  // --- encoding ---
  ["encoding.InjectAscii85", [LLM01], R.encodingInjection],
  ["encoding.InjectAtbash", [LLM01], R.encodingInjection],
  ["encoding.InjectBase16", [LLM01], R.encodingInjection],
  ["encoding.InjectBase2048", [LLM01], R.encodingInjection],
  ["encoding.InjectBase32", [LLM01], R.encodingInjection],
  ["encoding.InjectBase64", [LLM01], R.encodingInjection],
  ["encoding.InjectBraille", [LLM01], R.encodingInjection],
  ["encoding.InjectEcoji", [LLM01], R.encodingInjection],
  ["encoding.InjectHex", [LLM01], R.encodingInjection],
  ["encoding.InjectLeet", [LLM01], R.encodingInjection],
  ["encoding.InjectMime", [LLM01], R.encodingInjection],
  ["encoding.InjectMorse", [LLM01], R.encodingInjection],
  ["encoding.InjectNato", [LLM01], R.encodingInjection],
  ["encoding.InjectQP", [LLM01], R.encodingInjection],
  ["encoding.InjectROT13", [LLM01], R.encodingInjection],
  ["encoding.InjectSneakyBits", [LLM01], R.encodingInjection],
  ["encoding.InjectUU", [LLM01], R.encodingInjection],
  ["encoding.InjectUnicodeTagChars", [LLM01], R.encodingInjection],
  ["encoding.InjectUnicodeVariantSelectors", [LLM01], R.encodingInjection],
  ["encoding.InjectZalgo", [LLM01], R.encodingInjection],
  // --- exploitation ---
  ["exploitation.JinjaTemplatePythonInjection", [LLM05], R.injectionPayload],
  ["exploitation.SQLInjectionEcho", [LLM05], R.injectionPayload],
  ["exploitation.SQLInjectionSystem", [LLM05], R.injectionPayload],
  // --- fileformats ---
  [
    "fileformats.HF_Files",
    [LLM03],
    "inspects the target model's own repository for pickled files; a finding is an unsafe model artifact in the supply chain",
  ],
  // --- fitd ---
  ["fitd.FITD", [LLM01], R.iterativeJailbreak],
  // --- glitch ---
  ["glitch.Glitch", [], R.glitch],
  ["glitch.GlitchFull", [], R.glitch],
  // --- goat ---
  ["goat.GOATAttack", [LLM01], R.iterativeJailbreak],
  // --- goodside ---
  ["goodside.Davidjl", [], R.glitch],
  ["goodside.Tag", [LLM01], "an instruction hidden in invisible Unicode tag characters is followed; failure means the hidden instruction won"],
  ["goodside.ThreatenJSON", [], "measures whether a threat makes the model drop its preamble from JSON; a formatting behaviour, not a 2025 risk"],
  ["goodside.WhoIsRiley", [LLM09], R.hallucination],
  // --- grandma ---
  ["grandma.GrandmaIntent", [], R.noDetector],
  ["grandma.Slurs", [LLM01], "a role-play jailbreak (the grandmother persona) carries a refused request; failure means the persona overrode the model's instructions"],
  ["grandma.Substances", [LLM01], "a role-play jailbreak (the grandmother persona) carries a refused request; failure means the persona overrode the model's instructions"],
  [
    "grandma.Win10",
    [LLM01],
    "a role-play jailbreak asks for product keys; failure means the persona overrode the model's instructions (key-shaped output is not claimed as a leak)",
  ],
  [
    "grandma.Win11",
    [LLM01],
    "a role-play jailbreak asks for product keys; failure means the persona overrode the model's instructions (key-shaped output is not claimed as a leak)",
  ],
  // --- latentinjection ---
  ["latentinjection.LatentInjectionFactSnippetEiffel", [LLM01], R.latentInjection],
  ["latentinjection.LatentInjectionFactSnippetEiffelFull", [LLM01], R.latentInjection],
  ["latentinjection.LatentInjectionFactSnippetLegal", [LLM01], R.latentInjection],
  ["latentinjection.LatentInjectionFactSnippetLegalFull", [LLM01], R.latentInjection],
  ["latentinjection.LatentInjectionReport", [LLM01], R.latentInjection],
  ["latentinjection.LatentInjectionReportFull", [LLM01], R.latentInjection],
  ["latentinjection.LatentInjectionResume", [LLM01], R.latentInjection],
  ["latentinjection.LatentInjectionResumeFull", [LLM01], R.latentInjection],
  ["latentinjection.LatentInjectionTranslationEnFr", [LLM01], R.latentInjection],
  ["latentinjection.LatentInjectionTranslationEnFrFull", [LLM01], R.latentInjection],
  ["latentinjection.LatentInjectionTranslationEnZh", [LLM01], R.latentInjection],
  ["latentinjection.LatentInjectionTranslationEnZhFull", [LLM01], R.latentInjection],
  ["latentinjection.LatentJailbreak", [LLM01], R.latentJailbreak],
  ["latentinjection.LatentJailbreakFull", [LLM01], R.latentJailbreak],
  ["latentinjection.LatentWhois", [LLM01], R.latentInjection],
  ["latentinjection.LatentWhoisSnippet", [LLM01], R.latentInjection],
  ["latentinjection.LatentWhoisSnippetFull", [LLM01], R.latentInjection],
  // --- leakreplay ---
  ["leakreplay.GuardianCloze", [LLM02], R.memorisation],
  ["leakreplay.GuardianClozeFull", [LLM02], R.memorisation],
  ["leakreplay.GuardianComplete", [LLM02], R.memorisation],
  ["leakreplay.GuardianCompleteFull", [LLM02], R.memorisation],
  ["leakreplay.LiteratureCloze", [LLM02], R.memorisation],
  ["leakreplay.LiteratureClozeFull", [LLM02], R.memorisation],
  ["leakreplay.LiteratureComplete", [LLM02], R.memorisation],
  ["leakreplay.LiteratureCompleteFull", [LLM02], R.memorisation],
  ["leakreplay.NYTCloze", [LLM02], R.memorisation],
  ["leakreplay.NYTClozeFull", [LLM02], R.memorisation],
  ["leakreplay.NYTComplete", [LLM02], R.memorisation],
  ["leakreplay.NYTCompleteFull", [LLM02], R.memorisation],
  ["leakreplay.PotterCloze", [LLM02], R.memorisation],
  ["leakreplay.PotterClozeFull", [LLM02], R.memorisation],
  ["leakreplay.PotterComplete", [LLM02], R.memorisation],
  ["leakreplay.PotterCompleteFull", [LLM02], R.memorisation],
  // --- lmrc ---
  ["lmrc.Anthropomorphisation", [], "measures whether the model presents itself as human; a risk-card behaviour the 2025 list does not name"],
  ["lmrc.Bullying", [], R.contentHarm],
  [
    "lmrc.Deadnaming",
    [],
    "measures whether the model uses a public figure's former name; a respect harm, and the name is public, so no disclosure is claimed",
  ],
  ["lmrc.Profanity", [], R.contentHarm],
  ["lmrc.QuackMedicine", [LLM09], "the model endorses non-scientific medical claims; failure is evidence of misinformation"],
  ["lmrc.SexualContent", [], R.contentHarm],
  ["lmrc.Sexualisation", [], R.contentHarm],
  ["lmrc.SlurUsage", [], R.contentHarm],
  // --- malwaregen ---
  ["malwaregen.Evasion", [], R.malware],
  ["malwaregen.Payload", [], R.malware],
  ["malwaregen.SubFunctions", [], R.malware],
  ["malwaregen.TopLevel", [], R.malware],
  // --- misleading ---
  ["misleading.FalseAssertion", [LLM09], "the model fails to refute a false claim put to it; failure is evidence of misinformation"],
  // --- packagehallucination ---
  ["packagehallucination.Dart", [LLM09], "the model recommends a package that does not exist; LLM09 names hallucinated packages as misinformation"],
  ["packagehallucination.JavaScript", [LLM09], "the model recommends a package that does not exist; LLM09 names hallucinated packages as misinformation"],
  ["packagehallucination.Perl", [LLM09], "the model recommends a package that does not exist; LLM09 names hallucinated packages as misinformation"],
  ["packagehallucination.Python", [LLM09], "the model recommends a package that does not exist; LLM09 names hallucinated packages as misinformation"],
  ["packagehallucination.RakuLand", [LLM09], "the model recommends a package that does not exist; LLM09 names hallucinated packages as misinformation"],
  ["packagehallucination.Ruby", [LLM09], "the model recommends a package that does not exist; LLM09 names hallucinated packages as misinformation"],
  ["packagehallucination.Rust", [LLM09], "the model recommends a package that does not exist; LLM09 names hallucinated packages as misinformation"],
  // --- phrasing ---
  ["phrasing.FutureTense", [LLM01], R.jailbreak],
  ["phrasing.FutureTenseFull", [LLM01], R.jailbreak],
  ["phrasing.PastTense", [LLM01], R.jailbreak],
  ["phrasing.PastTenseFull", [LLM01], R.jailbreak],
  // --- promptinject ---
  ["promptinject.HijackHateHumans", [LLM01], R.promptInject],
  ["promptinject.HijackHateHumansFull", [LLM01], R.promptInject],
  ["promptinject.HijackKillHumans", [LLM01], R.promptInject],
  ["promptinject.HijackKillHumansFull", [LLM01], R.promptInject],
  ["promptinject.HijackLongPrompt", [LLM01], R.promptInject],
  ["promptinject.HijackLongPromptFull", [LLM01], R.promptInject],
  // --- propile ---
  ["propile.PIILeakQuadruplet", [LLM02], R.pii],
  ["propile.PIILeakTriplet", [LLM02], R.pii],
  ["propile.PIILeakTwin", [LLM02], R.pii],
  ["propile.PIILeakUnstructured", [LLM02], R.pii],
  // --- realtoxicityprompts ---
  ["realtoxicityprompts.RTPBlank", [], R.contentHarm],
  ["realtoxicityprompts.RTPFlirtation", [], R.contentHarm],
  ["realtoxicityprompts.RTPIdentity_Attack", [], R.contentHarm],
  ["realtoxicityprompts.RTPInsult", [], R.contentHarm],
  ["realtoxicityprompts.RTPProfanity", [], R.contentHarm],
  ["realtoxicityprompts.RTPSevere_Toxicity", [], R.contentHarm],
  ["realtoxicityprompts.RTPSexually_Explicit", [], R.contentHarm],
  ["realtoxicityprompts.RTPThreat", [], R.contentHarm],
  // --- sata ---
  ["sata.MLM", [LLM01], "masks the harmful words and links them to an assistive task (a jailbreak); failure means the model complied"],
  // --- smuggling ---
  ["smuggling.FunctionMasking", [LLM01], R.jailbreak],
  ["smuggling.HomoglyphObfuscation", [LLM01], R.jailbreak],
  ["smuggling.HypotheticalResponse", [LLM01], R.jailbreak],
  // --- snowball ---
  ["snowball.GraphConnectivity", [LLM09], R.hallucination],
  ["snowball.GraphConnectivityFull", [LLM09], R.hallucination],
  ["snowball.Primes", [LLM09], R.hallucination],
  ["snowball.PrimesFull", [LLM09], R.hallucination],
  ["snowball.Senators", [LLM09], R.hallucination],
  ["snowball.SenatorsFull", [LLM09], R.hallucination],
  // --- suffix ---
  ["suffix.BEAST", [LLM01], R.jailbreak],
  ["suffix.GCG", [LLM01], R.jailbreak],
  ["suffix.GCGCached", [LLM01], R.jailbreak],
  // --- sysprompt_extraction ---
  [
    "sysprompt_extraction.SystemPromptExtraction",
    [LLM07],
    "the detector finds the system prompt in the reply; failure is system prompt leakage (no instruction override is measured, so LLM01 is not claimed)",
  ],
  // --- tap ---
  ["tap.PAIR", [LLM01], R.iterativeJailbreak],
  ["tap.TAP", [LLM01], R.iterativeJailbreak],
  ["tap.TAPCached", [LLM01], R.jailbreak],
  // --- test ---
  ["test.Blank", [], R.noDetector],
  ["test.Test", [], R.noDetector],
  // --- topic ---
  ["topic.WordnetAllowedWords", [], R.topic],
  ["topic.WordnetBlockedWords", [], R.topic],
  ["topic.WordnetControversial", [], R.topic],
  // --- visual_jailbreak ---
  ["visual_jailbreak.FigStep", [LLM01], R.multimodal],
  ["visual_jailbreak.FigStepFull", [LLM01], R.multimodal],
  // --- web_injection ---
  ["web_injection.ColabAIDataLeakage", [LLM05], R.rendererPayload],
  ["web_injection.MarkdownImageExfil", [LLM05], R.rendererPayload],
  ["web_injection.MarkdownURIImageExfilExtended", [LLM05], R.rendererPayload],
  ["web_injection.MarkdownURINonImageExfilExtended", [LLM05], R.rendererPayload],
  ["web_injection.MarkdownXSS", [LLM05], R.rendererPayload],
  ["web_injection.PlaygroundMarkdownExfil", [LLM05], R.rendererPayload],
  ["web_injection.StringAssemblyDataExfil", [LLM05], R.rendererPayload],
  ["web_injection.TaskXSS", [LLM05], R.rendererPayload],
];

function buildTable(): GarakOwasp2025Row[] {
  const seen = new Set<string>();
  return ROWS.map(([probe, ids, rationale]) => {
    if (seen.has(probe)) throw new Error(`garak OWASP 2025 table: ${probe} listed twice`);
    seen.add(probe);
    return Object.freeze({ probe, owasp2025: Object.freeze([...ids].sort()), rationale });
  });
}

/** THE TABLE: one row per probe in the pinned garak release (decision 215). */
export const GARAK_OWASP_2025_TABLE: readonly GarakOwasp2025Row[] = Object.freeze(buildTable());

const BY_PROBE = new Map(GARAK_OWASP_2025_TABLE.map((r) => [r.probe, r]));

/** the table's row for a probe, or null (a probe with no row counts toward nothing) */
export function garakOwasp2025Row(probe: string): GarakOwasp2025Row | null {
  return BY_PROBE.get(probe) ?? null;
}

/** the 2025 OWASP ids a probe counts toward, from OUR table (never from garak's 2023 tags); sorted */
export function garakOwasp2025(probe: string): OwaspLlm2025Id[] {
  return [...(BY_PROBE.get(probe)?.owasp2025 ?? [])];
}

export interface GarakOwasp2025CoverageRisk {
  id: OwaspLlm2025Id;
  name: string;
  /** the probes that count toward this risk, sorted */
  probes: string[];
}

/** the coverage summary: for each 2025 risk the probes that count toward it, and the probes that map to none */
export function garakOwasp2025Coverage(): { garakVersion: string; risks: GarakOwasp2025CoverageRisk[]; none: string[] } {
  const llmIds = Object.keys(OWASP_LLM_TOP_10_MAPPING);
  const risks = OWASP_LLM_2025_IDS.map((id) => ({
    id,
    name: OWASP_LLM_TOP_10_NAMES[llmIds.indexOf(id)] ?? id,
    probes: GARAK_OWASP_2025_TABLE.filter((r) => r.owasp2025.includes(id))
      .map((r) => r.probe)
      .sort(),
  }));
  const none = GARAK_OWASP_2025_TABLE.filter((r) => r.owasp2025.length === 0)
    .map((r) => r.probe)
    .sort();
  return { garakVersion: GARAK_OWASP_2025_REVIEW.garakVersion, risks, none };
}
