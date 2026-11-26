//go:build windows

package directive

import "io/fs"

// fileOwner reports no POSIX owner on Windows: a file created in the same directory inherits that directory's ACL,
// and Root.Chown is not supported there.
func fileOwner(fs.FileInfo) (uid, gid int, ok bool) { return 0, 0, false }
