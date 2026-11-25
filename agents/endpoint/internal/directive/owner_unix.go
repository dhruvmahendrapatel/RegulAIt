//go:build !windows

package directive

import (
	"io/fs"
	"syscall"
)

// fileOwner is the numeric owner and group of an existing file, so a rewritten config keeps them (ADR-0331 §7).
func fileOwner(st fs.FileInfo) (uid, gid int, ok bool) {
	s, ok := st.Sys().(*syscall.Stat_t)
	if !ok {
		return 0, 0, false
	}
	return int(s.Uid), int(s.Gid), true
}
