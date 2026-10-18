package secrets

import (
	"encoding/json"
	"os"
	"slices"
	"strings"
	"testing"
	"time"
)

func TestVectors(t *testing.T) {
	data, err := os.ReadFile("testdata/vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	vectors, err := ParseVectors(data)
	if err != nil {
		t.Fatal(err)
	}
	if len(vectors) < 10 {
		t.Fatalf("only %d vectors", len(vectors))
	}
	for _, v := range vectors {
		got := MatchAll(v.Input())
		want := v.Expect
		if want == nil {
			want = []string{}
		}
		if got == nil {
			got = []string{}
		}
		if !slices.Equal(got, want) {
			t.Errorf("%s: got %v, want %v", v.Name, got, want)
		}
	}
}

// The compiled set must be exactly the shared `dlp.secret.*` set recorded in testdata/rules.json, which
// scripts/check-secret-rules.mjs regenerates from packages/shared and fails on drift.
func TestRuleSetMatchesShared(t *testing.T) {
	data, err := os.ReadFile("testdata/rules.json")
	if err != nil {
		t.Fatal(err)
	}
	var f struct {
		Rules []struct {
			ID string `json:"id"`
		} `json:"rules"`
	}
	if err := json.Unmarshal(data, &f); err != nil {
		t.Fatal(err)
	}
	var shared []string
	for _, r := range f.Rules {
		shared = append(shared, r.ID)
	}
	if !slices.Equal(RuleIDs(), shared) {
		t.Fatalf("compiled rules %v differ from the shared set %v", RuleIDs(), shared)
	}
}

func TestMatchNeverReturnsTheValue(t *testing.T) {
	v := "api_key = " + strings.Repeat("Z", 20)
	if id := Match(v); id != "dlp.secret.assignment" || strings.Contains(id, "Z") {
		t.Fatalf("got %q", id)
	}
	if Match("") != "" || Match("   ") != "" {
		t.Fatal("blank matched")
	}
}

// RE2 is linear: a pathological run that made the JavaScript `\b` form of the JWT rule quadratic stays fast.
func TestLinearOnPathologicalInput(t *testing.T) {
	in := strings.Repeat("eyJ-", 12_500)
	start := time.Now()
	MatchAll(in)
	if d := time.Since(start); d > 2*time.Second {
		t.Fatalf("took %v", d)
	}
}

// letters mirrors the xorshift32 helper in packages/shared/src/huggingface-token-scrub.test.ts, so the tokens are
// assembled at run time and this file holds no key-shaped literal.
func letters(seed uint32, n int) string {
	const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"
	s := seed
	var b strings.Builder
	for i := 0; i < n; i++ {
		s ^= s << 13
		s ^= s >> 17
		s ^= s << 5
		b.WriteByte(alphabet[s%uint32(len(alphabet))])
	}
	return b.String()
}

// The shared N4 cases: a mixed-case access or organization token is found in prose and in a multi-line log; the
// lookalike identifiers and a one-short body are not.
func TestHuggingFaceToken(t *testing.T) {
	const id = "dlp.secret.huggingface_token"
	access := strings.Join([]string{"hf", letters(0x4e04_0001, 34)}, "_")
	org := strings.Join([]string{"api", "org", letters(0x4e04_0002, 34)}, "_")
	for _, tok := range []string{access, org} {
		for _, in := range []string{
			"rotated after " + tok + " was pasted in the ticket",
			"401 from the hub: token " + tok + " is invalid",
			"Authorization: Bearer " + tok,
			"INFO pulling weights\nDEBUG HF_TOKEN=" + tok + "\nINFO done",
		} {
			if !slices.Contains(MatchAll(in), id) {
				t.Errorf("missed in %q", in)
			}
		}
		for _, in := range []string{"x" + tok, tok + "x", tok + "7", tok + tok, "x_" + tok} {
			if slices.Contains(MatchAll(in), id) {
				t.Errorf("matched %q", in)
			}
		}
	}
	for _, in := range []string{
		"set hf_transfer=1 before the download",
		"the api_org_settings page lists members",
		"hf_" + letters(7, 33) + " is one character short",
		"hf_hub_download(repo_id, filename) returned a path",
		"huggingface.co/models is a public listing",
	} {
		if slices.Contains(MatchAll(in), id) {
			t.Errorf("matched %q", in)
		}
	}
}
