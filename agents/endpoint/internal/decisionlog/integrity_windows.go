//go:build windows

package decisionlog

import (
	"io/fs"
	"os"
)

func openManaged(path string) (*os.File, error) { return os.Open(path) }

func isSymlinkRefusal(error) bool { return false }

// systemOwned is not checked on Windows: the admin locations' ACLs decide who may write there.
func systemOwned(fs.FileInfo, int) bool { return true }
