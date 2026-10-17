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

// readChecked reads a small file after checking it is a regular file (never a symlink) owned by owner with no more
// access than a allows. owner < 0 skips the owner check (Windows, where ACLs apply instead).
func readChecked(path string, owner int, a Access) ([]byte, error) {
	f, err := openNoFollow(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if err := checkMode(st, owner, a); err != nil {
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
	f, err := createExclusive(tmp)
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
