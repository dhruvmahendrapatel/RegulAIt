package enforce

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

// The golden file is written from the control plane's declared table (packages/policy-kernel agent-response.ts) and
// read by its test too: the Go mirror must equal it exactly (ADR-0354, one vocabulary in two languages).
func TestResponseTableMatchesControlPlaneGolden(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("testdata", "responses", "v1.json"))
	if err != nil {
		t.Fatal(err)
	}
	var golden struct {
		Schema      string         `json:"schema"`
		Order       []Response     `json:"order"`
		PolicyModes []string       `json:"policyModes"`
		Responses   []ResponseSpec `json:"responses"`
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&golden); err != nil {
		t.Fatal(err)
	}
	if golden.Schema != "regulait.agent-responses/1" {
		t.Fatalf("schema %q", golden.Schema)
	}
	if !reflect.DeepEqual(golden.Order, ResponseOrder) {
		t.Fatalf("order: golden %v, mirror %v", golden.Order, ResponseOrder)
	}
	if !reflect.DeepEqual(golden.PolicyModes, PolicyModes) {
		t.Fatalf("policy modes: golden %v, mirror %v", golden.PolicyModes, PolicyModes)
	}
	if len(golden.Responses) != len(ResponseTable) {
		t.Fatalf("golden has %d rows, mirror %d", len(golden.Responses), len(ResponseTable))
	}
	for i, row := range golden.Responses {
		if row.Kind != ResponseOrder[i] {
			t.Fatalf("row %d is %q, want %q", i, row.Kind, ResponseOrder[i])
		}
		if got := ResponseTable[row.Kind]; got != row {
			t.Fatalf("%s: golden %+v, mirror %+v", row.Kind, row, got)
		}
	}
}

func TestRelaxation(t *testing.T) {
	if !IsRelaxation(ResponseDeny, ResponseAdvise) || IsRelaxation(ResponseAdvise, ResponseDeny) {
		t.Fatal("deny → advise relaxes; advise → deny does not")
	}
	if IsRelaxation(ResponseDeny, ResponseCorrect) || IsRelaxation(ResponseCorrect, ResponseDeny) {
		t.Fatal("deny ↔ correct changes no enforcement")
	}
}
