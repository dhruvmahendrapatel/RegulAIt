// Package fsutil holds the endpoint agent's safe file helpers: a no-follow open, an owner and mode (or owner SID and
// DACL) check, an atomic exclusive write and a strict JSON decode. It is a leaf package, so internal/agent and
// internal/decisionlog share one copy (agent imports decisionlog).
package fsutil

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
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
	// WorldReadExec: anyone may read or execute, only the owner may write (a vendor's managed hook file, 0644 or
	// 0755). On Windows it is the same check as WorldRead.
	WorldReadExec
)

// ErrUnsafeFile is a file whose owner, type or mode is not what the agent requires; it is not read.
var ErrUnsafeFile = errors.New("unsafe file")

// ErrCannotCheck wraps a CheckMode error where the check itself could not be completed (the security descriptor
// could not be read), as opposed to a file that was checked and refused.
var ErrCannotCheck = errors.New("the file's ownership could not be checked")

// OwnerCurrentUser, as ReadChecked's owner, means "the user this agent runs as". Windows uses it for the user's own
// state (checked by SID); on Unix callers pass the real uid instead.
const OwnerCurrentUser = -2

// ReadChecked reads a file of at most max bytes after checking it is a regular file (never a symlink or reparse
// point) owned by owner with no more access than a allows. On Unix owner is a uid (< 0 skips the uid check, tests
// only); on Windows owner is OwnerCurrentUser for the user's own file and anything else for a system file, and the
// owner SID and DACL are checked instead (files_windows.go, winacl.go). Every refusal wraps ErrUnsafeFile.
func ReadChecked(path string, owner int, a Access, max int64) ([]byte, error) {
	f, err := OpenNoFollow(path)
	if err != nil {
		if IsUnsafeOpen(err) {
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
	if err := CheckMode(f, st, owner, a); err != nil {
		return nil, fmt.Errorf("%w: %s: %v", ErrUnsafeFile, filepath.Base(path), err)
	}
	b, err := io.ReadAll(io.LimitReader(f, max+1))
	if err != nil {
		return nil, err
	}
	if int64(len(b)) > max {
		return nil, fmt.Errorf("%w: %s is larger than %d bytes", ErrUnsafeFile, filepath.Base(path), max)
	}
	return b, nil
}

// StrictJSON decodes exactly one JSON value into v, refusing unknown fields and trailing data.
func StrictJSON(b []byte, v any) error {
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

// WriteAtomic writes data to path through an exclusive temporary file in the same directory (WriteTemp) and renames
// it into place, so the file never exists with wider access than it ends with, nor half-written.
func WriteAtomic(path string, data []byte, mode os.FileMode, gid int, sync bool) error {
	tmp, err := WriteTemp(path, data, mode, gid, sync)
	if err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}

// StreamAtomic is WriteAtomic for content too large to hold in memory: write fills a new exclusive temporary file
// beside path (created without following a link), which is synced, given mode and renamed into place only when
// write succeeds. A rename replaces a link at path rather than following it. On any error the temporary file is
// removed and path is unchanged.
func StreamAtomic(path string, mode os.FileMode, write func(io.Writer) error) error {
	tmp, err := tempName(path)
	if err != nil {
		return err
	}
	f, err := createExclusive(tmp, mode)
	if err != nil {
		return err
	}
	err = write(f)
	if err == nil {
		err = f.Sync()
	}
	if err == nil {
		err = setOwnership(f, -1, mode)
	}
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		err = os.Rename(tmp, path)
	}
	if err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}

func tempName(path string) (string, error) {
	var r [8]byte
	if _, err := rand.Read(r[:]); err != nil {
		return "", err
	}
	return filepath.Join(filepath.Dir(path), "."+filepath.Base(path)+"."+hex.EncodeToString(r[:])+".tmp"), nil
}

// WriteTemp writes data to a new exclusive temporary file beside path, with its mode (and group, where gid >= 0)
// set before it is closed, and returns its name; the caller renames or links it into place. sync flushes it to disk
// first. On any error the temporary file is removed.
func WriteTemp(path string, data []byte, mode os.FileMode, gid int, sync bool) (string, error) {
	tmp, err := tempName(path)
	if err != nil {
		return "", err
	}
	f, err := createExclusive(tmp, mode)
	if err != nil {
		return "", err
	}
	_, err = f.Write(data)
	if err == nil && sync {
		err = f.Sync()
	}
	if err == nil {
		err = setOwnership(f, gid, mode)
	}
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		_ = os.Remove(tmp)
		return "", err
	}
	return tmp, nil
}
