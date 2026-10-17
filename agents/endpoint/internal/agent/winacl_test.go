package agent

import (
	"strings"
	"testing"
)

const testUserSID = "S-1-5-21-1000-2000-3000-1001"

func allow(sid string, mask uint32) winACE {
	return winACE{Type: aceAccessAllowed, Mask: mask, SID: sid}
}

func TestJudgeWindowsFile(t *testing.T) {
	const fullAccess, fileGenericRead, fileGenericWrite = 0x001f01ff, 0x00120089, 0x00120116
	base := []winACE{allow(sidSystem, fullAccess), allow(sidAdministrators, fullAccess)}
	with := func(extra ...winACE) []winACE { return append(append([]winACE{}, base...), extra...) }
	cases := []struct {
		name   string
		sec    winFileSecurity
		user   string
		access Access
		refuse string // "" means accepted
	}{
		{"system file, SYSTEM and Administrators only", winFileSecurity{Owner: sidSystem, DACLPresent: true, ACEs: base}, "", OwnerOnly, ""},
		{"owned by Administrators", winFileSecurity{Owner: sidAdministrators, DACLPresent: true, ACEs: base}, "", OwnerOnly, ""},
		{"system file owned by a user", winFileSecurity{Owner: testUserSID, DACLPresent: true, ACEs: base}, "", WorldRead, "owned by"},
		{"user file owned by its user", winFileSecurity{Owner: testUserSID, DACLPresent: true, ACEs: with(allow(testUserSID, fullAccess))}, testUserSID, OwnerOnly, ""},
		{"user file owned by another user", winFileSecurity{Owner: "S-1-5-21-1-2-3-4", DACLPresent: true, ACEs: base}, testUserSID, OwnerOnly, "owned by"},
		{"NULL DACL", winFileSecurity{Owner: sidSystem}, "", WorldRead, "no DACL"},
		{"Users may write", winFileSecurity{Owner: sidSystem, DACLPresent: true, ACEs: with(allow("S-1-5-32-545", fileGenericWrite))}, "", WorldRead, "may write"},
		{"Everyone full", winFileSecurity{Owner: sidSystem, DACLPresent: true, ACEs: with(allow("S-1-1-0", fullAccess))}, "", WorldRead, "may write"},
		{"Authenticated Users append only", winFileSecurity{Owner: sidSystem, DACLPresent: true, ACEs: with(allow("S-1-5-11", fileAppendData))}, "", WorldRead, "may write"},
		{"another user may re-permission", winFileSecurity{Owner: sidSystem, DACLPresent: true, ACEs: with(allow(testUserSID, accessWriteDAC))}, "", WorldRead, "may write"},
		{"GENERIC_ALL", winFileSecurity{Owner: sidSystem, DACLPresent: true, ACEs: with(allow("S-1-5-32-545", genericAll))}, "", WorldRead, "may write"},
		{"Users read a secret", winFileSecurity{Owner: sidSystem, DACLPresent: true, ACEs: with(allow("S-1-5-32-545", fileGenericRead))}, "", OwnerOnly, "may read"},
		{"Users read the ticket", winFileSecurity{Owner: sidSystem, DACLPresent: true, ACEs: with(allow("S-1-5-32-545", fileGenericRead))}, "", GroupRead, "may read"},
		{"INTERACTIVE reads the ticket", winFileSecurity{Owner: sidSystem, DACLPresent: true, ACEs: with(allow(sidInteractive, fileGenericRead))}, "", GroupRead, ""},
		{"Users read the config", winFileSecurity{Owner: sidSystem, DACLPresent: true, ACEs: with(allow("S-1-5-32-545", fileGenericRead))}, "", WorldRead, ""},
		{"a deny entry only narrows", winFileSecurity{Owner: sidSystem, DACLPresent: true, ACEs: with(winACE{Type: aceAccessDenied, Mask: fullAccess, SID: "S-1-1-0"})}, "", OwnerOnly, ""},
		{"inherit-only entry", winFileSecurity{Owner: sidSystem, DACLPresent: true, ACEs: with(winACE{Type: aceAccessAllowed, Flags: aceInheritOnly, Mask: fullAccess, SID: "S-1-1-0"})}, "", OwnerOnly, ""},
		{"unknown entry type", winFileSecurity{Owner: sidSystem, DACLPresent: true, ACEs: with(winACE{Type: 5, Mask: fullAccess})}, "", WorldRead, "type 5"},
	}
	for _, c := range cases {
		err := judgeWindowsFile(c.sec, c.user, c.access)
		switch {
		case c.refuse == "" && err != nil:
			t.Errorf("%s: refused: %v", c.name, err)
		case c.refuse != "" && (err == nil || !strings.Contains(err.Error(), c.refuse)):
			t.Errorf("%s: want a refusal containing %q, got %v", c.name, c.refuse, err)
		}
	}
}

// The DACL the agent writes passes its own check for the access each file is read with.
func TestWindowsFileSDDL(t *testing.T) {
	if got := windowsFileSDDL(testUserSID, 0o600); got != "D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;"+testUserSID+")" {
		t.Errorf("0600: %s", got)
	}
	if got := windowsFileSDDL(sidSystem, 0o640); got != "D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FR;;;IU)" {
		t.Errorf("0640: %s", got)
	}
	if got := windowsFileSDDL(sidSystem, 0o644); got != "D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FR;;;BU)" {
		t.Errorf("0644: %s", got)
	}
}
