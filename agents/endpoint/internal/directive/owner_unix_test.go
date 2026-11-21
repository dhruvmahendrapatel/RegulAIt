//go:build !windows

package directive

import (
	"os"
	"path/filepath"
	"syscall"
	"testing"

	"github.com/dhruvmahendrapatel/regulait/agents/endpoint/internal/contract"
)

// A rewritten config keeps its owner and group: an agent running as root must not leave the developer's file owned
// by root (ADR-0331 §7).
func TestApplyKeepsTheFileOwner(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("changing a file's owner needs root")
	}
	f := newFixture(t, ".cursor/mcp.json", cursorConfig)
	p := filepath.Join(f.home, ".cursor", "mcp.json")
	if err := os.Chown(p, 4242, 4243); err != nil {
		t.Fatal(err)
	}
	d := base()
	if r := Apply(&d, f.col, f.env); r.Outcome != contract.OutcomeRemoved {
		t.Fatalf("got %+v", r)
	}
	st, err := os.Stat(p)
	if err != nil {
		t.Fatal(err)
	}
	if s := st.Sys().(*syscall.Stat_t); s.Uid != 4242 || s.Gid != 4243 {
		t.Errorf("owner %d:%d after the rewrite, want 4242:4243", s.Uid, s.Gid)
	}
}
