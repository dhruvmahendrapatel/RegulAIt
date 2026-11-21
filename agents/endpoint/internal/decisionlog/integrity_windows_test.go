//go:build windows

package decisionlog

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/dhruvmahendrapatel/regulait/agents/endpoint/internal/contract"
)

// Runs on the CI Windows runner. A file under a user's temporary directory is owned by, or writable by, that user,
// so it is not system-owned: the check no longer reports it present (review #1044). A link in place of the file is
// refused as a reparse point.
func TestWindowsManagedFileOwnership(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "hooks.json")
	if err := os.WriteFile(p, []byte(`{"version": 1}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if e := CheckIntegrity([]ManagedFile{{File: contract.ManagedFileCursor, Path: p}}, -1)[0]; e.State != contract.FileStateNotSystemOwned || e.SHA256 != nil {
		t.Fatalf("a user-writable file: %+v", e)
	}
	link := filepath.Join(dir, "link.json")
	if err := os.Symlink(p, link); err != nil {
		t.Skipf("no symlink privilege: %v", err)
	}
	if e := CheckIntegrity([]ManagedFile{{File: contract.ManagedFileCursor, Path: link}}, -1)[0]; e.State != contract.FileStateNotSystemOwned {
		t.Fatalf("a reparse point: %+v", e)
	}
}

// The known folders resolve to absolute paths.
func TestWindowsProgramDirsResolve(t *testing.T) {
	data, files := windowsProgramDirs()
	if !filepath.IsAbs(data) || !filepath.IsAbs(files) {
		t.Fatalf("%q %q", data, files)
	}
}
