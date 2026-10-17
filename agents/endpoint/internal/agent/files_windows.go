//go:build windows

package agent

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"unsafe"

	"golang.org/x/sys/windows"
)

// NOT RUN on a Windows host (pending execution, SD4j): the CI Windows runner runs files_windows_test.go. The file
// check reads the owner and DACL of the handle it then reads from (no second open), and winacl.go judges them.

var errReparsePoint = errors.New("refusing a reparse point")

// isUnsafeOpen: the path is a reparse point (a symlink or a junction).
func isUnsafeOpen(err error) bool { return errors.Is(err, errReparsePoint) }

// openNoFollow opens the reparse point itself, never its target, and refuses it.
func openNoFollow(path string) (*os.File, error) {
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return nil, err
	}
	h, err := windows.CreateFile(p, windows.GENERIC_READ, windows.FILE_SHARE_READ, nil, windows.OPEN_EXISTING,
		windows.FILE_ATTRIBUTE_NORMAL|windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		return nil, &os.PathError{Op: "open", Path: path, Err: err}
	}
	var info windows.ByHandleFileInformation
	if err := windows.GetFileInformationByHandle(h, &info); err != nil {
		windows.CloseHandle(h)
		return nil, &os.PathError{Op: "stat", Path: path, Err: err}
	}
	if info.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
		windows.CloseHandle(h)
		return nil, errReparsePoint
	}
	return os.NewFile(uintptr(h), path), nil
}

// currentUserSID is the SID of the user this process runs as.
func currentUserSID() (string, error) {
	u, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return "", err
	}
	return u.User.Sid.String(), nil
}

// createExclusive creates the file with its final protected DACL already in place (windowsFileSDDL), so it never
// exists with the directory's inherited access.
func createExclusive(path string, mode os.FileMode) (*os.File, error) {
	user, err := currentUserSID()
	if err != nil {
		return nil, err
	}
	sd, err := windows.SecurityDescriptorFromString(windowsFileSDDL(user, uint32(mode.Perm())))
	if err != nil {
		return nil, err
	}
	sa := &windows.SecurityAttributes{Length: uint32(unsafe.Sizeof(windows.SecurityAttributes{})), SecurityDescriptor: sd}
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return nil, err
	}
	h, err := windows.CreateFile(p, windows.GENERIC_WRITE, 0, sa, windows.CREATE_NEW, windows.FILE_ATTRIBUTE_NORMAL|windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		return nil, &os.PathError{Op: "create", Path: path, Err: err}
	}
	return os.NewFile(uintptr(h), path), nil
}

// checkMode: a regular file whose owner and DACL pass judgeWindowsFile. owner == ownerCurrentUser is the user's own
// file; anything else is a system file.
func checkMode(f *os.File, st fs.FileInfo, owner int, a Access) error {
	if !st.Mode().IsRegular() {
		return errors.New("not a regular file")
	}
	user := ""
	if owner == ownerCurrentUser {
		var err error
		if user, err = currentUserSID(); err != nil {
			return fmt.Errorf("the agent's user SID: %v", err)
		}
	}
	sec, err := fileSecurity(f)
	if err != nil {
		return err
	}
	return judgeWindowsFile(sec, user, a)
}

func fileSecurity(f *os.File) (winFileSecurity, error) {
	var sec winFileSecurity
	sd, err := windows.GetSecurityInfo(windows.Handle(f.Fd()), windows.SE_FILE_OBJECT,
		windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		return sec, fmt.Errorf("reading its security descriptor: %v", err)
	}
	ownerSID, _, err := sd.Owner()
	if err != nil || ownerSID == nil {
		return sec, fmt.Errorf("reading its owner: %v", err)
	}
	sec.Owner = ownerSID.String()
	dacl, _, err := sd.DACL()
	if errors.Is(err, windows.ERROR_OBJECT_NOT_FOUND) || err == nil && dacl == nil {
		return sec, nil // no DACL or a NULL DACL: judgeWindowsFile refuses it
	}
	if err != nil {
		return sec, fmt.Errorf("reading its DACL: %v", err)
	}
	sec.DACLPresent = true
	for i := uint32(0); i < uint32(dacl.AceCount); i++ {
		var ace *windows.ACCESS_ALLOWED_ACE
		if err := windows.GetAce(dacl, i, &ace); err != nil {
			return sec, fmt.Errorf("reading DACL entry %d: %v", i, err)
		}
		e := winACE{Type: ace.Header.AceType, Flags: ace.Header.AceFlags, Mask: uint32(ace.Mask)}
		if e.Type == aceAccessAllowed || e.Type == aceAccessDenied {
			// both share the ACCESS_ALLOWED_ACE layout; other types are refused by type alone
			e.SID = (*windows.SID)(unsafe.Pointer(&ace.SidStart)).String()
		}
		sec.ACEs = append(sec.ACEs, e)
	}
	return sec, nil
}

// setOwnership: the DACL was set when the file was created; there is no gid on Windows.
func setOwnership(*os.File, int, os.FileMode) error { return nil }
