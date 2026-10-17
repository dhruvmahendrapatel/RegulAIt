//go:build windows

package agent

import (
	"errors"
	"io/fs"
	"os"
)

// NOT RUN on Windows (pending execution). Owner and mode checks do not apply: the MSI (SD4h) sets the ACLs, and
// checking them here is follow-up work. Reparse points are refused instead of followed.

func openNoFollow(path string) (*os.File, error) {
	st, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if st.Mode()&fs.ModeSymlink != 0 || st.Mode()&fs.ModeIrregular != 0 {
		return nil, errors.New("refusing a reparse point")
	}
	return os.Open(path)
}

func createExclusive(path string) (*os.File, error) {
	return os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
}

func checkMode(st fs.FileInfo, _ int, _ Access) error {
	if !st.Mode().IsRegular() {
		return errors.New("not a regular file")
	}
	return nil
}

func setOwnership(*os.File, int, os.FileMode) error { return nil }
