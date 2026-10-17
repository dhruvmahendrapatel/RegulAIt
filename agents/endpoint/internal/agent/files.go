package agent

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

// Access says who besides the owner may read a file the agent reads.
type Access int

const (
	// OwnerOnly: no group or other bits (the bulk token, the user's state).
	OwnerOnly Access = iota
	// GroupRead: the group may read, nobody else (the device ticket, R15 §3.2: 0640 to group regulait-agent).
	GroupRead
	// WorldRead: anyone may read, only the owner may write (the config file: no secrets).
	WorldRead
)

// ErrUnsafeFile is a file whose owner, type or mode is not what the agent requires; it is not read.
var ErrUnsafeFile = errors.New("unsafe file")

const maxFileBytes = 64 << 10

// ownerCurrentUser, as readChecked's owner, means "the user this agent runs as". Windows uses it for the user's own
// state (checked by SID); on Unix ownUID passes the real uid instead.
const ownerCurrentUser = -2

// readChecked reads a small file after checking it is a regular file (never a symlink or reparse point) owned by
// owner with no more access than a allows. On Unix owner is a uid (< 0 skips the uid check, tests only); on Windows
// owner is ownerCurrentUser for the user's own file and anything else for a system file, and the owner SID and DACL
// are checked instead (files_windows.go, winacl.go).
func readChecked(path string, owner int, a Access) ([]byte, error) {
	f, err := openNoFollow(path)
	if err != nil {
		if isUnsafeOpen(err) {
			// a symlink (ELOOP under O_NOFOLLOW) or a reparse point is an unsafe file, not an unreadable one
			return nil, fmt.Errorf("%w: %s: %v", ErrUnsafeFile, filepath.Base(path), err)
		}
		return nil, err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if err := checkMode(f, st, owner, a); err != nil {
		return nil, fmt.Errorf("%w: %s: %v", ErrUnsafeFile, filepath.Base(path), err)
	}
	b, err := io.ReadAll(io.LimitReader(f, maxFileBytes+1))
	if err != nil {
		return nil, err
	}
	if len(b) > maxFileBytes {
		return nil, fmt.Errorf("%w: %s is larger than %d bytes", ErrUnsafeFile, filepath.Base(path), maxFileBytes)
	}
	return b, nil
}

func strictJSON(b []byte, v any) error {
	d := json.NewDecoder(bytes.NewReader(b))
	d.DisallowUnknownFields()
	if err := d.Decode(v); err != nil {
		return err
	}
	if d.More() {
		return errors.New("trailing data")
	}
	return nil
}

// writeAtomic writes data to path through an exclusive temporary file in the same directory, sets its mode (and
// group, where gid >= 0) before the rename, so the file never exists with wider access than it ends with.
func writeAtomic(path string, data []byte, mode os.FileMode, gid int) error {
	dir := filepath.Dir(path)
	tmp := filepath.Join(dir, "."+filepath.Base(path)+"."+randomHex(8)+".tmp")
	f, err := createExclusive(tmp, mode)
	if err != nil {
		return err
	}
	ok := false
	defer func() {
		if !ok {
			f.Close()
			os.Remove(tmp)
		}
	}()
	if _, err := f.Write(data); err != nil {
		return err
	}
	if err := f.Sync(); err != nil {
		return err
	}
	if err := setOwnership(f, gid, mode); err != nil {
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		return err
	}
	ok = true
	return nil
}
