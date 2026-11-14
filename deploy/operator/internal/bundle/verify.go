// Package bundle verifies a signed update-bundle manifest (ADR-0041) in process, with the same refusal rules as
// scripts/verify-update-bundle.sh: schema regulait.update-bundle/1, product regulait, a constrained key id that the
// pinned keyring holds, a signature over the exact manifest bytes, and no downgrade. Payload files are the
// installer's concern; the operator only needs to know that this version was signed by a key the customer pinned.
//
// No crypto is written here: Ed25519, ECDSA and RSA verification come from the Go standard library.
package bundle

import (
	"bytes"
	"crypto"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"regexp"
	"strings"

	"golang.org/x/mod/semver"
)

// Schema and product the verifier accepts.
const (
	Schema  = "regulait.update-bundle/1"
	Product = "regulait"
	// MaxManifestBytes bounds what is parsed. A ConfigMap is at most 1 MiB anyway.
	MaxManifestBytes = 1 << 20
)

var (
	keyIDPattern   = regexp.MustCompile(`^[A-Za-z0-9._-]+$`)
	versionPattern = regexp.MustCompile(`^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$`)
)

// Manifest is the subset of manifest.json the operator reads.
type Manifest struct {
	Schema              string `json:"schema"`
	Product             string `json:"product"`
	Version             string `json:"version"`
	MinInstalledVersion string `json:"minInstalledVersion"`
	SigningKeyID        string `json:"signingKeyId"`
}

// Result is a verified manifest.
type Result struct {
	Manifest Manifest
	// SHA256 of the manifest bytes, hex.
	SHA256 string
}

// Refusal is a verification failure. Reason is a stable, machine-readable token for conditions and events.
type Refusal struct {
	Reason  string
	Message string
}

func (r *Refusal) Error() string { return r.Reason + ": " + r.Message }

func refuse(reason, format string, args ...any) error {
	return &Refusal{Reason: reason, Message: fmt.Sprintf(format, args...)}
}

// Input is everything verification needs; it reads nothing on its own.
type Input struct {
	Manifest  []byte
	Signature []byte // base64, as written by build-update-bundle.sh
	// Keyring maps "<keyId>.pub" to a PEM public key.
	Keyring map[string]string
	// WantVersion is spec.version; the manifest must name exactly this version.
	WantVersion string
	// InstalledVersion is status.installedVersion; empty on a first install.
	InstalledVersion string
}

// Verify checks in.Manifest and returns its parsed fields, or a *Refusal.
func Verify(in Input) (*Result, error) {
	if len(in.Manifest) == 0 {
		return nil, refuse("ManifestMissing", "manifest.json is missing or empty")
	}
	if len(in.Manifest) > MaxManifestBytes {
		return nil, refuse("ManifestTooLarge", "manifest.json is larger than %d bytes", MaxManifestBytes)
	}
	if len(bytes.TrimSpace(in.Signature)) == 0 {
		return nil, refuse("SignatureMissing", "manifest.json.sig is missing; a bundle without its signature is not an update")
	}

	m, err := parseManifest(in.Manifest)
	if err != nil {
		return nil, err
	}
	if m.Schema != Schema {
		return nil, refuse("UnknownSchema", "manifest schema %q is not %s", m.Schema, Schema)
	}
	if m.Product != Product {
		return nil, refuse("WrongProduct", "manifest product %q is not %s", m.Product, Product)
	}
	if m.Version == "" {
		return nil, refuse("NoVersion", "manifest declares no version")
	}
	if m.SigningKeyID == "" {
		return nil, refuse("NoKeyID", "manifest declares no signingKeyId")
	}
	// The key id selects a keyring entry, so it is constrained before it is used.
	if !keyIDPattern.MatchString(m.SigningKeyID) {
		return nil, refuse("BadKeyID", "signingKeyId %q has characters outside [A-Za-z0-9._-]", m.SigningKeyID)
	}

	pemText, ok := in.Keyring[m.SigningKeyID+".pub"]
	if !ok {
		return nil, refuse("UnknownSigningKey", "key id %q is not in the pinned keyring", m.SigningKeyID)
	}
	pub, err := parsePublicKey(pemText)
	if err != nil {
		return nil, refuse("BadPinnedKey", "pinned key %q cannot be parsed: %v", m.SigningKeyID, err)
	}

	sig, err := base64.StdEncoding.DecodeString(strings.Join(strings.Fields(string(in.Signature)), ""))
	if err != nil {
		return nil, refuse("SignatureNotBase64", "manifest.json.sig is not valid base64")
	}
	if !verifySignature(pub, in.Manifest, sig) {
		return nil, refuse("SignatureInvalid", "the signature does not verify under pinned key %q", m.SigningKeyID)
	}

	// Versions are compared only after the signature holds, so an attacker cannot probe the policy with an
	// unsigned manifest.
	bv, err := canonical(m.Version)
	if err != nil {
		return nil, refuse("BadVersion", "manifest version %q is not semver", m.Version)
	}
	want, err := canonical(in.WantVersion)
	if err != nil {
		return nil, refuse("BadVersion", "spec.version %q is not semver", in.WantVersion)
	}
	if semver.Compare(bv, want) != 0 {
		return nil, refuse("VersionMismatch", "the verified manifest is for %s, spec.version is %s", m.Version, in.WantVersion)
	}
	if in.InstalledVersion != "" {
		iv, err := canonical(in.InstalledVersion)
		if err != nil {
			return nil, refuse("BadVersion", "installed version %q is not semver", in.InstalledVersion)
		}
		if semver.Compare(bv, iv) < 0 {
			return nil, refuse("Downgrade", "%s is older than the installed %s; going back is a restore, not an update", m.Version, in.InstalledVersion)
		}
		if m.MinInstalledVersion != "" {
			mv, err := canonical(m.MinInstalledVersion)
			if err != nil {
				return nil, refuse("BadVersion", "minInstalledVersion %q is not semver", m.MinInstalledVersion)
			}
			if semver.Compare(iv, mv) < 0 {
				return nil, refuse("MinInstalledVersion", "this release requires %s or later installed (installed: %s); apply the intermediate release first", m.MinInstalledVersion, in.InstalledVersion)
			}
		}
	}

	sum := sha256.Sum256(in.Manifest)
	return &Result{Manifest: m, SHA256: hex.EncodeToString(sum[:])}, nil
}

// parseManifest decodes the top-level object and refuses a duplicated key: the shell verifier reads the first
// occurrence and encoding/json the last, so a manifest with two "version" keys could mean two things.
func parseManifest(b []byte) (Manifest, error) {
	var m Manifest
	dec := json.NewDecoder(bytes.NewReader(b))
	tok, err := dec.Token()
	if err != nil || tok != json.Delim('{') {
		return m, refuse("ManifestNotJSON", "manifest.json is not a JSON object")
	}
	seen := map[string]bool{}
	for dec.More() {
		kt, err := dec.Token()
		if err != nil {
			return m, refuse("ManifestNotJSON", "manifest.json is not valid JSON")
		}
		key, _ := kt.(string)
		if seen[key] {
			return m, refuse("DuplicateKey", "manifest.json repeats the key %q", key)
		}
		seen[key] = true
		var raw json.RawMessage
		if err := dec.Decode(&raw); err != nil {
			return m, refuse("ManifestNotJSON", "manifest.json is not valid JSON")
		}
		var dst *string
		switch key {
		case "schema":
			dst = &m.Schema
		case "product":
			dst = &m.Product
		case "version":
			dst = &m.Version
		case "minInstalledVersion":
			dst = &m.MinInstalledVersion
		case "signingKeyId":
			dst = &m.SigningKeyID
		}
		if dst != nil {
			if err := json.Unmarshal(raw, dst); err != nil {
				return m, refuse("ManifestNotJSON", "manifest field %q is not a string", key)
			}
		}
	}
	if _, err := dec.Token(); err != nil {
		return m, refuse("ManifestNotJSON", "manifest.json is not valid JSON")
	}
	if dec.More() {
		return m, refuse("ManifestNotJSON", "manifest.json has trailing data")
	}
	return m, nil
}

func parsePublicKey(text string) (crypto.PublicKey, error) {
	block, rest := pem.Decode([]byte(text))
	if block == nil || block.Type != "PUBLIC KEY" {
		return nil, errors.New("not a PEM PUBLIC KEY block")
	}
	if len(bytes.TrimSpace(rest)) != 0 {
		return nil, errors.New("more than one PEM block")
	}
	return x509.ParsePKIXPublicKey(block.Bytes)
}

// verifySignature mirrors the script: Ed25519 over the message itself, or RSA / ECDSA over its SHA-256.
func verifySignature(pub crypto.PublicKey, msg, sig []byte) bool {
	switch k := pub.(type) {
	case ed25519.PublicKey:
		return ed25519.Verify(k, msg, sig)
	case *ecdsa.PublicKey:
		d := sha256.Sum256(msg)
		return ecdsa.VerifyASN1(k, d[:], sig)
	case *rsa.PublicKey:
		d := sha256.Sum256(msg)
		return rsa.VerifyPKCS1v15(k, crypto.SHA256, d[:], sig) == nil
	default:
		return false
	}
}

func canonical(v string) (string, error) {
	s := "v" + v
	if !versionPattern.MatchString(v) || !semver.IsValid(s) {
		return "", errors.New("invalid")
	}
	return s, nil
}
