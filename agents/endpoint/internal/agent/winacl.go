package agent

import "fmt"

// The Windows file check (ADR-0195 As built: SD4a). It is plain data and logic, so it is unit-tested on every OS;
// files_windows.go reads the owner and DACL of the open handle and passes them here.

// Well-known SIDs the check refers to.
const (
	sidSystem           = "S-1-5-18"     // NT AUTHORITY\SYSTEM
	sidAdministrators   = "S-1-5-32-544" // BUILTIN\Administrators
	sidTrustedInstaller = "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464"
	sidOwnerRights      = "S-1-3-4" // OWNER RIGHTS: whoever owns the object, already checked to be trusted
	sidInteractive      = "S-1-5-4" // NT AUTHORITY\INTERACTIVE: the planned ticket reader (R15 §3.2)
)

// Access-mask bits (winnt.h). Any of these lets the holder change the file or what it says.
const (
	fileReadData        = 0x00000001
	fileWriteData       = 0x00000002
	fileAppendData      = 0x00000004
	fileWriteEA         = 0x00000010
	fileExecute         = 0x00000020 // an execute mapping of a file can be read on x64, so it counts as a read
	fileWriteAttributes = 0x00000100
	accessDelete        = 0x00010000
	accessWriteDAC      = 0x00040000
	accessWriteOwner    = 0x00080000
	accessMaximum       = 0x02000000
	genericExecute      = 0x20000000
	genericAll          = 0x10000000
	genericWrite        = 0x40000000
	genericRead         = 0x80000000

	maskWrites = fileWriteData | fileAppendData | fileWriteEA | fileWriteAttributes | accessDelete | accessWriteDAC |
		accessWriteOwner | accessMaximum | genericAll | genericWrite
	maskReads = fileReadData | fileExecute | genericRead | genericExecute | genericAll | accessMaximum
)

// ACE types and flags (winnt.h).
const (
	aceAccessAllowed = 0
	aceAccessDenied  = 1
	aceInheritOnly   = 0x08
)

// winACE is one entry of a file's DACL.
type winACE struct {
	Type  uint8
	Flags uint8
	Mask  uint32
	SID   string
}

// winFileSecurity is what the check needs from a file's security descriptor.
type winFileSecurity struct {
	Owner       string
	DACLPresent bool // false for a NULL DACL, which grants everyone full access
	ACEs        []winACE
}

// judgeWindowsFile fails closed. A system file (userSID == "") must be owned by SYSTEM or Administrators; a user's
// own file by that user, SYSTEM or Administrators. Only SYSTEM, Administrators, TrustedInstaller, OWNER RIGHTS and
// (for a user's file) the user may hold any right that writes, deletes or re-permissions the file. Reads by anyone
// else: never for OwnerOnly, only INTERACTIVE for GroupRead (the ticket), anyone for WorldRead. An ACE type the check
// does not know is refused rather than skipped.
func judgeWindowsFile(sec winFileSecurity, userSID string, a Access) error {
	trusted := map[string]bool{sidSystem: true, sidAdministrators: true, sidTrustedInstaller: true, sidOwnerRights: true}
	owners := map[string]bool{sidSystem: true, sidAdministrators: true}
	if userSID != "" {
		trusted[userSID] = true
		owners[userSID] = true
	}
	if !owners[sec.Owner] {
		return fmt.Errorf("owned by %s, not SYSTEM, Administrators or the agent's user", sec.Owner)
	}
	if !sec.DACLPresent {
		return fmt.Errorf("it has no DACL, so everyone has full access")
	}
	for _, ace := range sec.ACEs {
		if ace.Flags&aceInheritOnly != 0 {
			continue // applies to children only, not to this file
		}
		switch ace.Type {
		case aceAccessDenied:
			continue // a deny entry only narrows access
		case aceAccessAllowed:
		default:
			return fmt.Errorf("its DACL holds an entry of type %d, which this check does not evaluate", ace.Type)
		}
		if trusted[ace.SID] {
			continue
		}
		if ace.Mask&maskWrites != 0 {
			return fmt.Errorf("%s may write, delete or re-permission it (mask 0x%08x)", ace.SID, ace.Mask)
		}
		if ace.Mask&maskReads == 0 {
			continue
		}
		switch {
		case a == WorldRead:
		case a == GroupRead && ace.SID == sidInteractive:
		default:
			return fmt.Errorf("%s may read it (mask 0x%08x)", ace.SID, ace.Mask)
		}
	}
	return nil
}

// windowsFileSDDL is the protected DACL the agent gives each file it writes on Windows: SYSTEM, Administrators and
// the writing user in full, plus INTERACTIVE read for a group-readable file (the ticket) and BUILTIN\Users read for
// a world-readable one (the status file). Nothing is inherited from the directory.
func windowsFileSDDL(userSID string, mode uint32) string {
	sddl := "D:P(A;;FA;;;SY)(A;;FA;;;BA)"
	if userSID != "" && userSID != sidSystem {
		sddl += "(A;;FA;;;" + userSID + ")"
	}
	switch {
	case mode&0o004 != 0:
		sddl += "(A;;FR;;;BU)"
	case mode&0o040 != 0:
		sddl += "(A;;FR;;;IU)"
	}
	return sddl
}
