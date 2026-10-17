//go:build windows

package collect

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Runs on the CI Windows runner: the Toolhelp snapshot sees this test process, and the TCP table reads.
func TestWindowsProcessTable(t *testing.T) {
	procs, err := processTable{}.Processes()
	if err != nil {
		t.Fatal(err)
	}
	self := strings.ToLower(filepath.Base(os.Args[0]))
	found := false
	for _, p := range procs {
		if strings.ToLower(p.Name) == self {
			found = true
		}
	}
	if !found {
		t.Fatalf("own process %q not in %d processes", self, len(procs))
	}
	ls, err := processTable{}.Listeners()
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("%d listeners", len(ls))
}

func TestWindowsRegistryReads(t *testing.T) {
	if _, err := (winRegistry{}).Uninstall(); err != nil {
		t.Fatal(err)
	}
	vals, err := (winRegistry{}).Environment()
	if err != nil || len(vals) == 0 {
		t.Fatalf("environment: %d %v", len(vals), err)
	}
}
