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
