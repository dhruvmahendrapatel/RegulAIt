package contract

import (
	"encoding/json"
	"flag"
	"os"
	"path/filepath"
	"testing"
)

var update = flag.Bool("update", false, "rewrite the golden files")

// The golden files are the exact bodies the agent sends, for SD4b's gateway tests to parse. Regenerate with
// `go test ./internal/contract -update` only on a deliberate contract change, and say so in the ADR.
func golden(t *testing.T, name string, v any) {
	t.Helper()
	got, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join("testdata", name)
	if *update {
		if err := os.WriteFile(path, append(got, '\n'), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(append(got, '\n')) != string(want) {
		t.Fatalf("%s changed:\n got %s\nwant %s", name, got, want)
	}
}

func TestGoldenBodies(t *testing.T) {
	golden(t, "ticket-request.json", TicketRequest{Hostname: "ws-0042", OS: "linux", Arch: "amd64", AgentVersion: "0.1.0"})
	golden(t, "register-request.json", RegisterRequest{
		PublicJWK:     map[string]any{"kty": "EC", "crv": "P-256", "x": "AAAA", "y": "BBBB"},
		KeyProtection: KeySoftware, KeyProvider: "file", KeyFallbackReason: "no key hardware reachable: /dev/tpmrm0 does not exist",
		AgentVersion: "0.1.0", OS: "linux", Arch: "amd64", DeviceUser: "device-user",
	})
	golden(t, "report.json", Report{
		Schema: SchemaReport, SnapshotID: "00000000-0000-4000-8000-000000000000", CollectedAt: "2026-10-17T00:00:00Z", AgentVersion: "0.1.0",
		OS: "linux", Arch: "amd64", ManifestVersion: "1.0.0", ManifestDigest: "0000000000000000000000000000000000000000000000000000000000000000",
		KeyProtection: KeyHardware, DroppedSnapshots: 0,
		Facts: []Fact{
			{Kind: KindAssistantConfig, SignatureID: "sig.example.config", Provider: "example", MatchedOn: "file", Identifier: ".config/example/*.json",
				Location: Location{Root: RootHome, Path: ".config/example/settings.json"}, Keys: []KeyFound{{KeyName: "EXAMPLE_API_KEY", RuleID: "dlp.secret.assignment", Present: true}}},
			{Kind: KindLocalRuntime, SignatureID: "sig.example.runtime", Provider: "example", MatchedOn: "port", Identifier: "11434",
				Location: Location{Root: RootProcessTable}, Port: 11434, PortOnly: true},
		},
		Gaps:        []Gap{{Kind: KindLocalRuntime, Reason: "other_users_listeners_port_only"}},
		FactsDigest: "1111111111111111111111111111111111111111111111111111111111111111",
	})
}
