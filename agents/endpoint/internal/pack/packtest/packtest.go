// Package packtest builds signed collection packs for tests, under a key generated at run time.
package packtest

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"sort"

	"github.com/dhruvmahendrapatel/regulait/agents/endpoint/internal/contract"
)

// KeyID is the test key id. It is not a real key id.
const KeyID = "test-pack-key"

// Signer holds a run-time Ed25519 key.
type Signer struct {
	Pub  ed25519.PublicKey
	priv ed25519.PrivateKey
}

// NewSigner generates a key.
func NewSigner() *Signer {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		panic(err)
	}
	return &Signer{Pub: pub, priv: priv}
}

// Keyring pins this signer's key under KeyID.
func (s *Signer) Keyring() map[string]ed25519.PublicKey {
	return map[string]ed25519.PublicKey{KeyID: s.Pub}
}

// Manifest builds the ADR-0041 manifest bytes for files.
func Manifest(version string, files map[string][]byte) []byte {
	type file struct {
		Path   string `json:"path"`
		SHA256 string `json:"sha256"`
	}
	names := make([]string, 0, len(files))
	for n := range files {
		names = append(names, n)
	}
	sort.Strings(names)
	list := []file{}
	for _, n := range names {
		d := sha256.Sum256(files[n])
		list = append(list, file{Path: n, SHA256: hex.EncodeToString(d[:])})
	}
	m, err := json.MarshalIndent(map[string]any{
		"schema": contract.SchemaPackManifest, "product": contract.PackProduct, "version": version,
		"minInstalledVersion": "", "signingKeyId": KeyID, "createdAt": "2026-10-17T00:00:00Z", "files": list,
	}, "", "  ")
	if err != nil {
		panic(err)
	}
	return m
}

// SignRaw signs manifest bytes as they are and attaches files.
func (s *Signer) SignRaw(manifest []byte, files map[string][]byte) contract.SignedPack {
	enc := map[string]string{}
	for n, b := range files {
		enc[n] = base64.StdEncoding.EncodeToString(b)
	}
	return contract.SignedPack{
		Manifest:  base64.StdEncoding.EncodeToString(manifest),
		Signature: base64.StdEncoding.EncodeToString(ed25519.Sign(s.priv, manifest)),
		Files:     enc,
	}
}

// Pack signs a pack holding one collection manifest.
func (s *Signer) Pack(version string, collection []byte) contract.SignedPack {
	files := map[string][]byte{contract.CollectionManifestFile: collection}
	return s.SignRaw(Manifest(version, files), files)
}
