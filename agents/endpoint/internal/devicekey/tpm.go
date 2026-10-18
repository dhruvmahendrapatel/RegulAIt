//go:build linux

package devicekey

import (
	"crypto"
	"crypto/ecdsa"
	"encoding/asn1"
	"errors"
	"fmt"
	"io"
	"math/big"
	"os"
	"path/filepath"
	"syscall"

	"github.com/google/go-tpm/tpm2"
	"github.com/google/go-tpm/tpm2/transport"
	"github.com/google/go-tpm/tpm2/transport/linuxtpm"

	"github.com/dhruvmahendrapatel/regulait/agents/endpoint/internal/contract"
)

// TPMStore keeps P-256 signing keys in a TPM 2.0 through go-tpm (Apache-2.0). A key is created under the TCG
// reference ECC storage root key, which the TPM re-derives from its seed on every use, so nothing is persisted in
// the TPM. Only the key's public area and its TPM-wrapped private area are stored on disk (0600); the wrapped
// blob can be loaded only by the TPM that made it, so a copied file is useless off the device.
//
// Linux only uses it where /dev/tpmrm0 is already reachable by the user (R15 §3.1). Adding console users to the
// `tss` group is an audited admin opt-in that this slice does not build.
type TPMStore struct {
	Dir string
	// Device is the resource-manager device, /dev/tpmrm0 by default.
	Device string
	// Open replaces the device open in tests (a TPM simulator).
	Open func() (transport.TPMCloser, error)
}

func (s TPMStore) Provider() string                   { return "tpm" }
func (s TPMStore) Protection() contract.KeyProtection { return contract.KeyHardware }

func (s TPMStore) device() string {
	if s.Device == "" {
		return "/dev/tpmrm0"
	}
	return s.Device
}

func (s TPMStore) open() (transport.TPMCloser, error) {
	if s.Open != nil {
		return s.Open()
	}
	return linuxtpm.Open(s.device())
}

func (s TPMStore) Probe() error {
	if s.Open == nil {
		f, err := os.OpenFile(s.device(), os.O_RDWR, 0)
		switch {
		case errors.Is(err, os.ErrNotExist):
			return fmt.Errorf("%w: %s does not exist", ErrNoHardware, s.device())
		case errors.Is(err, os.ErrPermission):
			return fmt.Errorf("%w: %s exists but this user may not open it (the tss group opt-in is off)", ErrNoHardware, s.device())
		case err != nil:
			return err
		}
		f.Close()
	}
	// the device opens: from here on, failure is the TPM's, not its absence
	tpm, err := s.open()
	if err != nil {
		return err
	}
	defer tpm.Close()
	srk, err := createSRK(tpm)
	if err != nil {
		return fmt.Errorf("the TPM refused the storage root key: %w", err)
	}
	flush(tpm, srk.ObjectHandle)
	return (FileStore{Dir: s.Dir}).ensureDir()
}

func createSRK(tpm transport.TPM) (*tpm2.CreatePrimaryResponse, error) {
	return tpm2.CreatePrimary{PrimaryHandle: tpm2.TPMRHOwner, InPublic: tpm2.New2B(tpm2.ECCSRKTemplate)}.Execute(tpm)
}

func flush(tpm transport.TPM, h tpm2.TPMHandle) {
	_, _ = tpm2.FlushContext{FlushHandle: h}.Execute(tpm)
}

var signingTemplate = tpm2.TPMTPublic{
	Type:    tpm2.TPMAlgECC,
	NameAlg: tpm2.TPMAlgSHA256,
	ObjectAttributes: tpm2.TPMAObject{
		FixedTPM:            true,
		FixedParent:         true,
		SensitiveDataOrigin: true,
		UserWithAuth:        true,
		SignEncrypt:         true,
	},
	Parameters: tpm2.NewTPMUPublicParms(tpm2.TPMAlgECC, &tpm2.TPMSECCParms{
		CurveID: tpm2.TPMECCNistP256,
		Scheme: tpm2.TPMTECCScheme{
			Scheme:  tpm2.TPMAlgECDSA,
			Details: tpm2.NewTPMUAsymScheme(tpm2.TPMAlgECDSA, &tpm2.TPMSSigSchemeECDSA{HashAlg: tpm2.TPMAlgSHA256}),
		},
	}),
}

func (s TPMStore) path(id string) string { return filepath.Join(s.Dir, id+".tpm") }

func (s TPMStore) Create() (Key, error) {
	if err := (FileStore{Dir: s.Dir}).ensureDir(); err != nil {
		return nil, err
	}
	tpm, err := s.open()
	if err != nil {
		return nil, err
	}
	defer tpm.Close()
	srk, err := createSRK(tpm)
	if err != nil {
		return nil, err
	}
	defer flush(tpm, srk.ObjectHandle)
	created, err := tpm2.Create{
		ParentHandle: tpm2.AuthHandle{Handle: srk.ObjectHandle, Name: srk.Name, Auth: tpm2.PasswordAuth(nil)},
		InPublic:     tpm2.New2B(signingTemplate),
	}.Execute(tpm)
	if err != nil {
		return nil, err
	}
	blob := append(lengthPrefixed(tpm2.Marshal(created.OutPublic)), lengthPrefixed(tpm2.Marshal(created.OutPrivate))...)
	id := newID()
	f, err := os.OpenFile(s.path(id), os.O_WRONLY|os.O_CREATE|os.O_EXCL|syscall.O_NOFOLLOW, 0o600)
	if err != nil {
		return nil, err
	}
	if _, err := f.Write(blob); err != nil {
		f.Close()
		os.Remove(s.path(id))
		return nil, err
	}
	if err := f.Close(); err != nil {
		return nil, err
	}
	return s.Load(id)
}

func lengthPrefixed(b []byte) []byte {
	return append([]byte{byte(len(b) >> 8), byte(len(b))}, b...)
}

func splitPrefixed(b []byte) ([]byte, []byte, error) {
	if len(b) < 2 {
		return nil, nil, errors.New("truncated")
	}
	n := int(b[0])<<8 | int(b[1])
	if len(b) < 2+n {
		return nil, nil, errors.New("truncated")
	}
	return b[2 : 2+n], b[2+n:], nil
}

func (s TPMStore) Load(id string) (Key, error) {
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
	raw, err := io.ReadAll(io.LimitReader(f, 8192))
	f.Close()
	if err != nil {
		return nil, err
	}
	pubBytes, rest, err := splitPrefixed(raw)
	if err != nil {
		return nil, fmt.Errorf("the TPM key file is corrupt: %w", err)
	}
	privBytes, _, err := splitPrefixed(rest)
	if err != nil {
		return nil, fmt.Errorf("the TPM key file is corrupt: %w", err)
	}
	pub2b, err := tpm2.Unmarshal[tpm2.TPM2BPublic](pubBytes)
	if err != nil {
		return nil, err
	}
	priv2b, err := tpm2.Unmarshal[tpm2.TPM2BPrivate](privBytes)
	if err != nil {
		return nil, err
	}
	pub, err := pub2b.Contents()
	if err != nil {
		return nil, err
	}
	parms, err := pub.Parameters.ECCDetail()
	if err != nil {
		return nil, err
	}
	point, err := pub.Unique.ECC()
	if err != nil {
		return nil, err
	}
	ecPub, err := tpm2.ECDSAPub(parms, point)
	if err != nil {
		return nil, err
	}
	return &tpmKey{id: id, store: s, pub: ecPub, public: *pub2b, private: *priv2b}, nil
}

func (s TPMStore) Delete(id string) error {
	if !validID(id) {
		return ErrNotFound
	}
	err := os.Remove(s.path(id))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}

type tpmKey struct {
	id      string
	store   TPMStore
	pub     *ecdsa.PublicKey
	public  tpm2.TPM2BPublic
	private tpm2.TPM2BPrivate
}

func (k *tpmKey) ID() string               { return k.id }
func (k *tpmKey) Store() Store             { return k.store }
func (k *tpmKey) Public() crypto.PublicKey { return k.pub }

// Sign loads the wrapped key under a fresh storage root key, signs the digest in the TPM and flushes both.
func (k *tpmKey) Sign(_ io.Reader, digest []byte, opts crypto.SignerOpts) ([]byte, error) {
	if opts.HashFunc() != crypto.SHA256 || len(digest) != 32 {
		return nil, errors.New("the TPM key signs SHA-256 digests only")
	}
	tpm, err := k.store.open()
	if err != nil {
		return nil, err
	}
	defer tpm.Close()
	srk, err := createSRK(tpm)
	if err != nil {
		return nil, err
	}
	defer flush(tpm, srk.ObjectHandle)
	loaded, err := tpm2.Load{
		ParentHandle: tpm2.AuthHandle{Handle: srk.ObjectHandle, Name: srk.Name, Auth: tpm2.PasswordAuth(nil)},
		InPrivate:    k.private,
		InPublic:     k.public,
	}.Execute(tpm)
	if err != nil {
		return nil, err
	}
	defer flush(tpm, loaded.ObjectHandle)
	sig, err := tpm2.Sign{
		KeyHandle: tpm2.AuthHandle{Handle: loaded.ObjectHandle, Name: loaded.Name, Auth: tpm2.PasswordAuth(nil)},
		Digest:    tpm2.TPM2BDigest{Buffer: digest},
		InScheme: tpm2.TPMTSigScheme{
			Scheme:  tpm2.TPMAlgECDSA,
			Details: tpm2.NewTPMUSigScheme(tpm2.TPMAlgECDSA, &tpm2.TPMSSchemeHash{HashAlg: tpm2.TPMAlgSHA256}),
		},
		Validation: tpm2.TPMTTKHashCheck{Tag: tpm2.TPMSTHashCheck, Hierarchy: tpm2.TPMRHNull},
	}.Execute(tpm)
	if err != nil {
		return nil, err
	}
	e, err := sig.Signature.Signature.ECDSA()
	if err != nil {
		return nil, err
	}
	return asn1.Marshal(struct{ R, S *big.Int }{new(big.Int).SetBytes(e.SignatureR.Buffer), new(big.Int).SetBytes(e.SignatureS.Buffer)})
}
