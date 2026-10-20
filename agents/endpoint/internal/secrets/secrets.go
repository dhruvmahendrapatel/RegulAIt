// Package secrets holds the key patterns the agent checks config values against, compiled into the binary.
//
// R15 call 2 and §2.3: the patterns come from the gitleaks-derived `dlp.secret.*` set in
// packages/shared/src/guardrails.ts (CREDENTIAL_MATERIAL_RULES), so there is one list of "what a key looks like".
// They are compiled here, never delivered in the collection manifest (ADR-0195 decision 5: no regex taken from
// data). Go's regexp is RE2 (linear time, no lookaround), so the rules that use lookaround in JavaScript
// are rewritten as an RE2 match plus a check in code; testdata/vectors.json runs the same inputs through both
// engines (this package's test and agents/endpoint/scripts/check-secret-rules.mjs).
//
// A match yields the rule id only. The matched text is never returned, stored or logged.
package secrets

import (
	"regexp"
	"strings"
)

type rule struct {
	id string
	re *regexp.Regexp
	// accept, when set, re-checks a match's submatches for what the JavaScript lookaround expressed
	accept func(m []string) bool
}

// stripeDocExampleBodies are the two published documentation example test keys' bodies that the shared rule
// excludes exactly. Assembled from halves, as in guardrails.ts, so this file is not itself flagged.
var stripeDocExampleBodies = []string{"4eC39HqLyjWD" + "arjtT1zdp7dc", "BQokikJOvBiI" + "2HlWgH4olfQ2"}

func allOneChar(s string) bool {
	for i := 1; i < len(s); i++ {
		if s[i] != s[0] {
			return false
		}
	}
	return true
}

var rules = []rule{
	{id: "dlp.secret.aws_key", re: regexp.MustCompile(`\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b`)},
	{id: "dlp.secret.private_key", re: regexp.MustCompile(`-----BEGIN\s+(?:RSA\s+|EC\s+|DSA\s+|OPENSSH\s+|PGP\s+)?PRIVATE\s+KEY(?:\s+BLOCK)?-----`)},
	// JS: (?<![A-Za-z0-9_-])eyJ… — the lookbehind becomes "start of text or a non-run character before it"
	{id: "dlp.secret.jwt", re: regexp.MustCompile(`(?:^|[^A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b`)},
	{id: "dlp.secret.assignment", re: regexp.MustCompile(`(?i)\b(?:api[_-]?key|secret[_-]?key|client[_-]?secret|access[_-]?token|auth[_-]?token|password|passwd|bearer)\b\s*[:=]\s*["']?[A-Za-z0-9_\-./+]{12,}["']?`)},
	{id: "dlp.secret.provider_token", re: regexp.MustCompile(`\b(?:sk-[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b`)},
	{id: "dlp.secret.anthropic_key", re: regexp.MustCompile(`\bsk-ant-[a-z]{3,8}\d{2}-[A-Za-z0-9_-]{32,200}`)},
	{id: "dlp.secret.openai_key", re: regexp.MustCompile(`\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{40,250}`)},
	{id: "dlp.secret.github_fine_grained_pat", re: regexp.MustCompile(`\bgithub_pat_\w{82}`)},
	// JS: two negative lookaheads (a documentation example body; a body of one repeated character). RE2 takes the
	// whole alphanumeric run and the check below applies both exclusions to it.
	{id: "dlp.secret.stripe_key", re: regexp.MustCompile(`\b(?:sk|rk)_(test|live|prod)_([A-Za-z0-9]{10,})`), accept: func(m []string) bool {
		body := m[2]
		if allOneChar(body) {
			return false
		}
		if m[1] == "test" {
			for _, doc := range stripeDocExampleBodies {
				if body == doc {
					return false
				}
			}
		}
		return true
	}},
	// JS: (?![\w-]) after the 39-character key — RE2 consumes the following character or the end instead
	{id: "dlp.secret.google_api_key", re: regexp.MustCompile(`\bAIza[\w-]{35}(?:[^\w-]|$)`)},
	{id: "dlp.secret.gitlab_pat", re: regexp.MustCompile(`\bglpat-[\w-]{20,300}(?:\.[0-9a-z]{9})?`)},
	// JS: (?![A-Za-z0-9_]) after the 34-letter body — as for google_api_key, RE2 consumes the following character or
	// the end instead. The leading \b is ASCII in both engines, so the same two misses hold: a token glued after
	// `_` or a letter, and the first of two tokens written back to back (the second is then glued after a letter).
	{id: "dlp.secret.huggingface_token", re: regexp.MustCompile(`\b(?:hf|api_org)_[A-Za-z]{34}(?:[^A-Za-z0-9_]|$)`)},
	{id: "dlp.secret.regulait_token", re: regexp.MustCompile(`\brgl(?:v|s|scim)?_[A-Fa-f0-9]{24,}\b`)},
}

// RuleIDs is the compiled rule set, in the shared order.
func RuleIDs() []string {
	ids := make([]string, len(rules))
	for i, r := range rules {
		ids[i] = r.id
	}
	return ids
}

// MaxValueBytes caps what one Match call inspects; a longer value is checked on its first MaxValueBytes only.
const MaxValueBytes = 64 << 10

// Match returns the id of the first rule that matches value, or "" when none does.
func Match(value string) string {
	if ids := MatchAll(value); len(ids) > 0 {
		return ids[0]
	}
	return ""
}

// MatchAll returns every rule id that matches value, in rule order (the vector test compares sets).
func MatchAll(value string) []string {
	if len(value) > MaxValueBytes {
		value = value[:MaxValueBytes]
	}
	if strings.TrimSpace(value) == "" {
		return nil
	}
	var out []string
	for _, r := range rules {
		if r.accept == nil {
			if r.re.MatchString(value) {
				out = append(out, r.id)
			}
			continue
		}
		for _, m := range r.re.FindAllStringSubmatch(value, -1) {
			if r.accept(m) {
				out = append(out, r.id)
				break
			}
		}
	}
	return out
}
