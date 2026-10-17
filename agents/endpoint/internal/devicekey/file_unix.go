//go:build !windows

package devicekey

import (
	"crypto/ecdsa"
	"crypto/x509"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"syscall"

	"github.com/dhruvmahendrapatel/regulait/agents/endpoint/internal/contract"
)

// FileStore is the Linux software fallback: one PKCS#8 file per key, created exclusively with mode 0600 and never
// opened through a symlink, in a 0700 directory (the S7 runner-key pattern). Malware running as the user can read
// it; that is why it is only the fallback and posture flags it (R15 §3.1 threat model).
type FileStore struct {
	Dir string
}

func (s FileStore) Provider() string                   { return "file" }
func (s FileStore) Protection() contract.KeyProtection { return contract.KeySoftware }

func (s FileStore) Probe() error {
	if s.Dir == "" || !filepath.IsAbs(s.Dir) {
		return errors.New("the key directory is not an absolute path")
	}
	return s.ensureDir()
}

func (s FileStore) ensureDir() error {
	if err := os.MkdirAll(s.Dir, 0o700); err != nil {
		return err
	}
	st, err := os.Lstat(s.Dir)
	if err != nil {
		return err
	}
	if !st.IsDir() {
		return errors.New("the key directory is not a directory")
	}
	if st.Mode().Perm()&0o077 != 0 {
		return fmt.Errorf("the key directory is accessible to other users (mode %o)", st.Mode().Perm())
	}
	if sys, ok := st.Sys().(*syscall.Stat_t); ok && int(sys.Uid) != os.Getuid() {
		return errors.New("the key directory is owned by another user")
	}
	return nil
}

func (s FileStore) path(id string) string { return filepath.Join(s.Dir, id+".p8") }

func (s FileStore) Create() (Key, error) {
	if err := s.ensureDir(); err != nil {
		return nil, err
	}
	priv, err := generateP256()
	if err != nil {
		return nil, err
	}
	der, err := x509.MarshalPKCS8PrivateKey(priv)
	if err != nil {
		return nil, err
	}
	id := newID()
	f, err := os.OpenFile(s.path(id), os.O_WRONLY|os.O_CREATE|os.O_EXCL|syscall.O_NOFOLLOW, 0o600)
	if err != nil {
		return nil, err
	}
	if _, err := f.Write(der); err != nil {
		f.Close()
		os.Remove(s.path(id))
		return nil, err
	}
	if err := f.Close(); err != nil {
		return nil, err
	}
	return &softwareKey{PrivateKey: priv, id: id, store: s}, nil
}

func (s FileStore) Load(id string) (Key, error) {
	if !validID(id) {
		return nil, ErrNotFound
	}
	f, err := os.OpenFile(s.path(id), os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if errors.Is(err, os.ErrNotExist) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if !st.Mode().IsRegular() || st.Mode().Perm()&0o077 != 0 {
		return nil, fmt.Errorf("the key file is not a private regular file (mode %o)", st.Mode().Perm())
	}
	if sys, ok := st.Sys().(*syscall.Stat_t); ok && int(sys.Uid) != os.Getuid() {
		return nil, errors.New("the key file is owned by another user")
	}
	der, err := io.ReadAll(io.LimitReader(f, 4096))
	if err != nil {
		return nil, err
	}
	k, err := x509.ParsePKCS8PrivateKey(der)
	if err != nil {
		return nil, err
	}
	priv, ok := k.(*ecdsa.PrivateKey)
	if !ok || priv.Curve.Params().Name != "P-256" {
		return nil, errors.New("the key file does not hold a P-256 key")
	}
	return &softwareKey{PrivateKey: priv, id: id, store: s}, nil
}

func (s FileStore) Delete(id string) error {
	if !validID(id) {
		return ErrNotFound
	}
	err := os.Remove(s.path(id))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}
