//go:build windows

package devicekey

import (
	"crypto"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/x509"
	"encoding/asn1"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"math/big"
	"os"
	"path/filepath"
	"unsafe"

	"golang.org/x/sys/windows"

	"github.com/dhruvmahendrapatel/regulait/agents/endpoint/internal/contract"
)

// NOT RUN on Windows (pending execution): this file is cross-compiled and vetted in CI only. The calls follow the
// documented NCrypt and DPAPI signatures; SD4j runs them on a Windows host with and without a TPM.

var (
	ncrypt                        = windows.NewLazySystemDLL("ncrypt.dll")
	procNCryptOpenStorageProvider = ncrypt.NewProc("NCryptOpenStorageProvider")
	procNCryptCreatePersistedKey  = ncrypt.NewProc("NCryptCreatePersistedKey")
	procNCryptFinalizeKey         = ncrypt.NewProc("NCryptFinalizeKey")
	procNCryptOpenKey             = ncrypt.NewProc("NCryptOpenKey")
	procNCryptSignHash            = ncrypt.NewProc("NCryptSignHash")
	procNCryptExportKey           = ncrypt.NewProc("NCryptExportKey")
	procNCryptDeleteKey           = ncrypt.NewProc("NCryptDeleteKey")
	procNCryptFreeObject          = ncrypt.NewProc("NCryptFreeObject")
)

const (
	platformProvider   = "Microsoft Platform Crypto Provider"
	eccPublicBlob      = "ECCPUBLICBLOB"
	ecdsaP256          = "ECDSA_P256"
	eccPublicP256Magic = 0x31534345 // BCRYPT_ECDSA_PUBLIC_P256_MAGIC, "ECS1"
	keyNamePrefix      = "RegulAIt-Endpoint-Agent-"
	nteBadKeyset       = 0x80090016
)

func status(r uintptr) error {
	if r == 0 {
		return nil
	}
	return fmt.Errorf("NCrypt status 0x%08x", uint32(r))
}

func utf16(s string) *uint16 {
	p, err := windows.UTF16PtrFromString(s)
	if err != nil {
		panic(err)
	}
	return p
}

// NCryptStore keeps P-256 keys in the TPM through the Platform Crypto Provider. The keys are per-user and not
// exportable; only the key's name (from its id) is stored by the agent.
type NCryptStore struct{}

func (NCryptStore) Provider() string                   { return "tpm_ncrypt" }
func (NCryptStore) Protection() contract.KeyProtection { return contract.KeyHardware }

func openProvider() (uintptr, error) {
	if err := procNCryptOpenStorageProvider.Find(); err != nil {
		// ncrypt.dll (or its export) is missing: this Windows has no CNG key storage at all
		return 0, fmt.Errorf("%w: ncrypt.dll is not available", ErrNoHardware)
	}
	var h uintptr
	r, _, _ := procNCryptOpenStorageProvider.Call(uintptr(unsafe.Pointer(&h)), uintptr(unsafe.Pointer(utf16(platformProvider))), 0)
	if err := classifyProviderOpen(uint32(r)); err != nil {
		// only "no TPM" statuses wrap ErrNoHardware (ncrypt_status.go); anything else is refused, never a fallback
		return 0, err
	}
	return h, nil
}

func freeObject(h uintptr) { procNCryptFreeObject.Call(h) }

func (NCryptStore) Probe() error {
	h, err := openProvider()
	if err != nil {
		return err
	}
	freeObject(h)
	return nil
}

func (s NCryptStore) Create() (Key, error) {
	prov, err := openProvider()
	if err != nil {
		return nil, err
	}
	defer freeObject(prov)
	id := newID()
	var key uintptr
	r, _, _ := procNCryptCreatePersistedKey.Call(prov, uintptr(unsafe.Pointer(&key)), uintptr(unsafe.Pointer(utf16(ecdsaP256))), uintptr(unsafe.Pointer(utf16(keyNamePrefix+id))), 0, 0)
	if err := status(r); err != nil {
		return nil, err
	}
	defer freeObject(key)
	if r, _, _ := procNCryptFinalizeKey.Call(key, 0); status(r) != nil {
		return nil, status(r)
	}
	return s.Load(id)
}

func (s NCryptStore) withKey(id string, f func(key uintptr) error) error {
	if !validID(id) {
		return ErrNotFound
	}
	prov, err := openProvider()
	if err != nil {
		return err
	}
	defer freeObject(prov)
	var key uintptr
	r, _, _ := procNCryptOpenKey.Call(prov, uintptr(unsafe.Pointer(&key)), uintptr(unsafe.Pointer(utf16(keyNamePrefix+id))), 0, 0)
	if uint32(r) == nteBadKeyset {
		return ErrNotFound
	}
	if err := status(r); err != nil {
		return err
	}
	defer freeObject(key)
	return f(key)
}

func (s NCryptStore) Load(id string) (Key, error) {
	var pub *ecdsa.PublicKey
	err := s.withKey(id, func(key uintptr) error {
		var n uint32
		if r, _, _ := procNCryptExportKey.Call(key, 0, uintptr(unsafe.Pointer(utf16(eccPublicBlob))), 0, 0, 0, uintptr(unsafe.Pointer(&n)), 0); status(r) != nil {
			return status(r)
		}
		if n < 8 || n > 1024 {
			return errors.New("unexpected public blob size")
		}
		buf := make([]byte, n)
		if r, _, _ := procNCryptExportKey.Call(key, 0, uintptr(unsafe.Pointer(utf16(eccPublicBlob))), 0, uintptr(unsafe.Pointer(&buf[0])), uintptr(n), uintptr(unsafe.Pointer(&n)), 0); status(r) != nil {
			return status(r)
		}
		magic, size := binary.LittleEndian.Uint32(buf[0:4]), binary.LittleEndian.Uint32(buf[4:8])
		if magic != eccPublicP256Magic || size != 32 || len(buf) < 8+64 {
			return errors.New("the TPM key is not a P-256 ECDSA key")
		}
		pub = &ecdsa.PublicKey{Curve: elliptic.P256(), X: new(big.Int).SetBytes(buf[8:40]), Y: new(big.Int).SetBytes(buf[40:72])}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return &ncryptKey{id: id, store: s, pub: pub}, nil
}

func (s NCryptStore) Delete(id string) error {
	err := s.withKey(id, func(key uintptr) error {
		r, _, _ := procNCryptDeleteKey.Call(key, 0)
		return status(r)
	})
	if errors.Is(err, ErrNotFound) {
		return nil
	}
	return err
}

type ncryptKey struct {
	id    string
	store NCryptStore
	pub   *ecdsa.PublicKey
}

func (k *ncryptKey) ID() string               { return k.id }
func (k *ncryptKey) Store() Store             { return k.store }
func (k *ncryptKey) Public() crypto.PublicKey { return k.pub }

// Sign returns ASN.1 DER: NCryptSignHash gives r||s for an ECDSA key.
func (k *ncryptKey) Sign(_ io.Reader, digest []byte, opts crypto.SignerOpts) ([]byte, error) {
	if opts.HashFunc() != crypto.SHA256 || len(digest) != 32 {
		return nil, errors.New("the TPM key signs SHA-256 digests only")
	}
	var out []byte
	err := k.store.withKey(k.id, func(key uintptr) error {
		sig := make([]byte, 64)
		var n uint32
		r, _, _ := procNCryptSignHash.Call(key, 0, uintptr(unsafe.Pointer(&digest[0])), uintptr(len(digest)), uintptr(unsafe.Pointer(&sig[0])), uintptr(len(sig)), uintptr(unsafe.Pointer(&n)), 0)
		if err := status(r); err != nil {
			return err
		}
		if n != 64 {
			return errors.New("unexpected signature size")
		}
		der, err := asn1.Marshal(struct{ R, S *big.Int }{new(big.Int).SetBytes(sig[:32]), new(big.Int).SetBytes(sig[32:])})
		out = der
		return err
	})
	return out, err
}

// DPAPIStore is the Windows software fallback: a PKCS#8 key protected with DPAPI in user scope
// (CryptProtectData), in %LOCALAPPDATA%\RegulAIt\agent\keys. Malware running as the user can unprotect it.
type DPAPIStore struct {
	Dir string
}

var dpapiEntropy = []byte("RegulAIt endpoint agent device key")

func (DPAPIStore) Provider() string                   { return "dpapi" }
func (DPAPIStore) Protection() contract.KeyProtection { return contract.KeySoftware }

func (s DPAPIStore) Probe() error {
	if s.Dir == "" || !filepath.IsAbs(s.Dir) {
		return errors.New("the key directory is not an absolute path")
	}
	return os.MkdirAll(s.Dir, 0o700)
}

func (s DPAPIStore) path(id string) string { return filepath.Join(s.Dir, id+".dpapi") }

func blob(b []byte) *windows.DataBlob {
	if len(b) == 0 {
		return &windows.DataBlob{}
	}
	return &windows.DataBlob{Size: uint32(len(b)), Data: &b[0]}
}

func (s DPAPIStore) Create() (Key, error) {
	if err := s.Probe(); err != nil {
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
	var out windows.DataBlob
	if err := windows.CryptProtectData(blob(der), nil, blob(dpapiEntropy), 0, nil, windows.CRYPTPROTECT_UI_FORBIDDEN, &out); err != nil {
		return nil, err
	}
	defer windows.LocalFree(windows.Handle(unsafe.Pointer(out.Data)))
	protected := unsafe.Slice(out.Data, out.Size)
	id := newID()
	f, err := os.OpenFile(s.path(id), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return nil, err
	}
	if _, err := f.Write(protected); err != nil {
		f.Close()
		os.Remove(s.path(id))
		return nil, err
	}
	if err := f.Close(); err != nil {
		return nil, err
	}
	return &softwareKey{PrivateKey: priv, id: id, store: s}, nil
}

func (s DPAPIStore) Load(id string) (Key, error) {
	if !validID(id) {
		return nil, ErrNotFound
	}
	raw, err := os.ReadFile(s.path(id))
	if errors.Is(err, os.ErrNotExist) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if len(raw) == 0 || len(raw) > 8192 {
		return nil, errors.New("the protected key file has an unexpected size")
	}
	var out windows.DataBlob
	if err := windows.CryptUnprotectData(blob(raw), nil, blob(dpapiEntropy), 0, nil, windows.CRYPTPROTECT_UI_FORBIDDEN, &out); err != nil {
		return nil, err
	}
	der := append([]byte(nil), unsafe.Slice(out.Data, out.Size)...)
	windows.LocalFree(windows.Handle(unsafe.Pointer(out.Data)))
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

func (s DPAPIStore) Delete(id string) error {
	if !validID(id) {
		return ErrNotFound
	}
	err := os.Remove(s.path(id))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}

// PlatformStores returns the TPM store and the DPAPI fallback.
func PlatformStores(stateDir string) (Store, Store) {
	return NCryptStore{}, DPAPIStore{Dir: filepath.Join(stateDir, "keys")}
}
