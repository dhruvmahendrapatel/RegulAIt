//go:build !windows

package agent

import (
	"encoding/base64"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Owner decision B4 (ADR-0330 §8): the device-policy signer's keys are pinned in the root-owned config.
func TestConfigPinsDevicePolicyKeys(t *testing.T) {
	dir := t.TempDir()
	write := func(extra string) string {
		p := filepath.Join(dir, "config.json")
		os.WriteFile(p, []byte(`{"schema":"regulait.endpoint-agent-config/1","issuer":"https://gw.example.test"`+extra+`}`), 0o644)
		return p
	}
	x := base64.RawURLEncoding.EncodeToString([]byte(strings.Repeat("k", 32)))
	cfg, err := LoadConfig(write(`,"devicePolicyKeys":[{"keyId":"device-policy-1","x":"`+x+`"},{"keyId":"device-policy-2","x":"`+x+`"}]`), os.Getuid())
	if err != nil || len(cfg.DevicePolicyKeys) != 2 {
		t.Fatalf("pins not loaded: %v", err)
	}
	if cfg, err := LoadConfig(write(""), os.Getuid()); err != nil || len(cfg.DevicePolicyKeys) != 0 {
		t.Fatalf("no pins: %v", err)
	}
	for name, extra := range map[string]string{
		"three keys":     `,"devicePolicyKeys":[{"keyId":"a-11","x":"` + x + `"},{"keyId":"a-22","x":"` + x + `"},{"keyId":"a-33","x":"` + x + `"}]`,
		"not a key":      `,"devicePolicyKeys":[{"keyId":"device-policy-1","x":"AAAA"}]`,
		"unknown member": `,"devicePolicyKeys":[{"keyId":"device-policy-1","x":"` + x + `","alg":"none"}]`,
	} {
		if _, err := LoadConfig(write(extra), os.Getuid()); err == nil {
			t.Errorf("%s: config accepted", name)
		}
	}
}
