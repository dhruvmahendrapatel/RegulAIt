//go:build darwin

package collect

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

// Runs on the CI macOS runner: a binary plist made by plutil is converted back by the agent's converter.
func TestDarwinPlutilConversion(t *testing.T) {
	xml := []byte(`<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.example.assistant</string></dict></plist>`)
	p := filepath.Join(t.TempDir(), "Info.plist")
	os.WriteFile(p, xml, 0o644)
	if out, err := exec.Command("/usr/bin/plutil", "-convert", "binary1", p).CombinedOutput(); err != nil {
		t.Fatalf("%v %s", err, out)
	}
	bin, _ := os.ReadFile(p)
	got, err := platformPlistToXML()(bin)
	if err != nil {
		t.Fatal(err)
	}
	vals, err := plistTopStrings(got, "CFBundleIdentifier")
	if err != nil || vals["CFBundleIdentifier"] != "com.example.assistant" {
		t.Fatalf("%v %v", vals, err)
	}
}

func TestDarwinProcessTable(t *testing.T) {
	procs, err := processTable{}.Processes()
	if err != nil || len(procs) == 0 {
		t.Fatalf("%d %v", len(procs), err)
	}
	if _, err := (processTable{}).Listeners(); err != nil {
		t.Fatal(err)
	}
}
