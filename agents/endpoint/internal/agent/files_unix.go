//go:build !windows

package agent

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"syscall"
)

func openNoFollow(path string) (*os.File, error) {
	return os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
}

func createExclusive(path string) (*os.File, error) {
	return os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL|syscall.O_NOFOLLOW, 0o600)
}

func checkMode(st fs.FileInfo, owner int, a Access) error {
	if !st.Mode().IsRegular() {
		return errors.New("not a regular file")
	}
	if sys, ok := st.Sys().(*syscall.Stat_t); ok && owner >= 0 && int(sys.Uid) != owner {
		return fmt.Errorf("owned by uid %d, not %d", sys.Uid, owner)
	}
	perm := st.Mode().Perm()
	var allowed fs.FileMode
	switch a {
	case OwnerOnly:
		allowed = 0o600
	case GroupRead:
		allowed = 0o640
	case WorldRead:
		allowed = 0o644
	}
	if perm&^allowed != 0 {
		return fmt.Errorf("mode %o allows more than %o", perm, allowed)
	}
	return nil
}

func setOwnership(f *os.File, gid int, mode os.FileMode) error {
	if gid >= 0 {
		if err := f.Chown(-1, gid); err != nil {
			return err
		}
	}
	return f.Chmod(mode)
}
