//go:build windows

package agent

import (
	"errors"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/sys/windows"
)

// setDACL replaces path's DACL with a protected one from SDDL (the owner is left alone).
func setDACL(t *testing.T, path, sddl string) {
	t.Helper()
	sd, err := windows.SecurityDescriptorFromString(sddl)
	if err != nil {
		t.Fatal(err)
	}
	dacl, _, err := sd.DACL()
	if err != nil {
		t.Fatal(err)
	}
	if err := windows.SetNamedSecurityInfo(path, windows.SE_FILE_OBJECT,
		windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, dacl, nil); err != nil {
		t.Fatal(err)
	}
}

// Runs on the CI Windows runner: a file the agent writes passes its own check, and one that Users may write, or
// (for a secret) read, is an unsafe file.
func TestWindowsFileACLs(t *testing.T) {
	user, err := currentUserSID()
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "state.json")
	if err := writeAtomic(path, []byte("{}"), 0o600, -1); err != nil {
		t.Fatal(err)
	}
	if _, err := readChecked(path, ownerCurrentUser, OwnerOnly); err != nil {
		t.Fatalf("the agent's own file: %v", err)
	}
	own := "D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;" + user + ")"
	for _, c := range []struct {
		sddl   string
		access Access
		unsafe bool
	}{
		{own + "(A;;FW;;;BU)", WorldRead, true},
		{own + "(A;;FA;;;WD)", WorldRead, true},
		{own + "(A;;FR;;;BU)", OwnerOnly, true},
		{own + "(A;;FR;;;AU)", GroupRead, true},
		{own + "(A;;FR;;;IU)", GroupRead, false},
		{own + "(A;;FR;;;BU)", WorldRead, false},
		{own + "(D;;FA;;;BG)", OwnerOnly, false},
	} {
		setDACL(t, path, c.sddl)
		_, err := readChecked(path, ownerCurrentUser, c.access)
		if got := errors.Is(err, ErrUnsafeFile); got != c.unsafe {
			t.Errorf("%s access %d: unsafe=%v, want %v (%v)", c.sddl, c.access, got, c.unsafe, err)
		}
	}
	// a system file must not be owned by an ordinary user: make the runner's user the owner explicitly (an elevated
	// runner would otherwise leave Administrators as the owner and the case would never run)
	setDACL(t, path, own)
	sid, err := windows.StringToSid(user)
	if err != nil {
		t.Fatal(err)
	}
	if err := windows.SetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION, sid, nil, nil, nil); err != nil {
		t.Fatalf("set the owner to %s: %v", user, err)
	}
	if _, err := readChecked(path, -1, WorldRead); !errors.Is(err, ErrUnsafeFile) || !strings.Contains(err.Error(), "owned by") {
		t.Fatalf("a user-owned system file was accepted: %v", err)
	}
}
