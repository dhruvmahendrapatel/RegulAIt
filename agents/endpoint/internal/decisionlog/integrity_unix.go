//go:build !windows

package decisionlog

import (
	"errors"
	"io/fs"
	"os"
	"syscall"
)

// openManaged opens without following a final symlink: a managed file that is a link could point anywhere.
func openManaged(path string) (*os.File, error) {
	return os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
}

// isSymlinkRefusal: O_NOFOLLOW on a symlink fails with ELOOP.
func isSymlinkRefusal(err error) bool { return errors.Is(err, syscall.ELOOP) }

// systemOwned: owned by systemOwner (when it is not negative), and writable by nobody else.
func systemOwned(st fs.FileInfo, systemOwner int) bool {
	if sys, ok := st.Sys().(*syscall.Stat_t); ok && systemOwner >= 0 && int(sys.Uid) != systemOwner {
		return false
	}
	return st.Mode().Perm()&0o022 == 0
}
