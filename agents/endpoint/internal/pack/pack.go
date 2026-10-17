// Package pack verifies the signed collection pack and validates the collection manifest inside it.
//
// R15 §2.4 and §4.3: what the agent may collect is data, a collection manifest the gateway serves, signed in the
// ADR-0041 update-bundle manifest format (scripts/verify-update-bundle.sh semantics) under the pack key id, which
// is separate from the agent release key and from the control-plane release key. The agent refuses an unsigned
// pack, an unknown key id, a bad signature, a missing, modified or unlisted file, a downgrade, a manifest with an
// unknown kind, and any field that looks like a pattern rather than a path, glob or name.
package pack

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"

	"github.com/dhruvmahendrapatel/regulait/agents/endpoint/internal/contract"
)

// Keyring maps a signing key id to its pinned Ed25519 public key.
type Keyring map[string]ed25519.PublicKey

// CompiledKeyring is the pack keyring built into the agent. It is EMPTY: the pack key (`regulait-pack-<id>`) is
// made in the offline ceremony that SD4g runs, which has not happened (pending execution). Until its public key
// is added here, every pack is refused as signed by an unknown key, which is the strict default.
var CompiledKeyring = Keyring{}

// MinimumVersion is the oldest pack this build accepts, compiled in. The per-user floor (the last version accepted,
// in the user's state) is checked as well, but it is empty for a new user and lost with deleted state; this floor
// still refuses a replayed older signed pack then. A release that retires a pack version raises it.
const MinimumVersion = "1.0.0"

// Manifest is the ADR-0041 manifest. Unknown members are refused.
type Manifest struct {
	Schema              string `json:"schema"`
	Product             string `json:"product"`
	Version             string `json:"version"`
	MinInstalledVersion string `json:"minInstalledVersion"`
	SigningKeyID        string `json:"signingKeyId"`
	CreatedAt           string `json:"createdAt"`
	Files               []File `json:"files"`
}

// File is one listed file.
type File struct {
	Path   string `json:"path"`
	SHA256 string `json:"sha256"`
}

// Verified is a pack whose signature, files and version all checked out.
type Verified struct {
	Version    string
	Collection *Collection
	// CollectionDigest is the hex SHA-256 of the collection manifest's bytes (reported as manifestDigest).
	CollectionDigest string
}

// ErrRefused wraps every refusal, so callers can tell a refused pack from a transport error.
var ErrRefused = errors.New("collection pack refused")

func refuse(format string, a ...any) error {
	return fmt.Errorf("%w: %s", ErrRefused, fmt.Sprintf(format, a...))
}

func strictJSON(data []byte, v any) error {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		return err
	}
	if dec.More() {
		return errors.New("trailing data after the JSON value")
	}
	return nil
}

func validKeyID(id string) bool {
	if id == "" || len(id) > 128 {
		return false
	}
	for _, c := range id {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '.' || c == '_' || c == '-') {
			return false
		}
	}
	return true
}

// Verify checks p against keys and returns the validated collection. installedVersion is the last version this
// agent accepted ("" before the first); an older pack is a downgrade and is refused.
func Verify(p contract.SignedPack, keys Keyring, installedVersion string) (*Verified, error) {
	if p.Manifest == "" || p.Signature == "" {
		return nil, refuse("the pack has no manifest or no signature")
	}
	raw, err := base64.StdEncoding.DecodeString(p.Manifest)
	if err != nil {
		return nil, refuse("the manifest is not base64")
	}
	sig, err := base64.StdEncoding.DecodeString(p.Signature)
	if err != nil || len(sig) != ed25519.SignatureSize {
		return nil, refuse("the signature is not a base64 Ed25519 signature")
	}
	var m Manifest
	if err := strictJSON(raw, &m); err != nil {
		return nil, refuse("the manifest does not parse: %v", err)
	}
	if m.Schema != contract.SchemaPackManifest || m.Product != contract.PackProduct {
		return nil, refuse("unknown manifest schema %q or product %q", m.Schema, m.Product)
	}
	if !validKeyID(m.SigningKeyID) {
		return nil, refuse("signingKeyId is not a permitted key id")
	}
	pub, ok := keys[m.SigningKeyID]
	if !ok || len(pub) != ed25519.PublicKeySize {
		return nil, refuse("unknown signing key %q: this agent pins %d pack key(s)", m.SigningKeyID, len(keys))
	}
	// the signature covers the exact manifest bytes, so it is checked before anything the manifest says is trusted
	if !ed25519.Verify(pub, raw, sig) {
		return nil, refuse("the signature does not verify under %q", m.SigningKeyID)
	}
	if _, err := parseVersion(m.Version); err != nil {
		return nil, refuse("version %q: %v", m.Version, err)
	}
	if c, err := compareVersions(m.Version, MinimumVersion); err != nil || c < 0 {
		return nil, refuse("downgrade refused: pack %s is older than this build's minimum %s", m.Version, MinimumVersion)
	}
	if installedVersion != "" {
		if c, err := compareVersions(m.Version, installedVersion); err != nil || c < 0 {
			return nil, refuse("downgrade refused: pack %s is older than the accepted %s", m.Version, installedVersion)
		}
		if m.MinInstalledVersion != "" {
			if c, err := compareVersions(installedVersion, m.MinInstalledVersion); err != nil || c < 0 {
				return nil, refuse("the pack needs at least %s accepted first (have %s)", m.MinInstalledVersion, installedVersion)
			}
		}
	}
	listed := map[string]string{}
	for _, f := range m.Files {
		if f.Path == "" || strings.ContainsAny(f.Path, `/\`) || f.Path == "." || f.Path == ".." {
			return nil, refuse("listed file %q is not a plain file name", f.Path)
		}
		if _, dup := listed[f.Path]; dup {
			return nil, refuse("file %q is listed twice", f.Path)
		}
		listed[f.Path] = f.SHA256
	}
	files := map[string][]byte{}
	for name, b64 := range p.Files {
		want, ok := listed[name]
		if !ok {
			return nil, refuse("the pack carries %q, which the signed manifest does not list", name)
		}
		body, err := base64.StdEncoding.DecodeString(b64)
		if err != nil {
			return nil, refuse("file %q is not base64", name)
		}
		got := sha256.Sum256(body)
		if hex.EncodeToString(got[:]) != want {
			return nil, refuse("file %q does not match its signed digest", name)
		}
		files[name] = body
	}
	for name := range listed {
		if _, ok := files[name]; !ok {
			return nil, refuse("file %q is listed in the signed manifest but missing", name)
		}
	}
	body, ok := files[contract.CollectionManifestFile]
	if !ok {
		return nil, refuse("the pack has no %s", contract.CollectionManifestFile)
	}
	col, err := ParseCollection(body)
	if err != nil {
		return nil, err
	}
	d := sha256.Sum256(body)
	return &Verified{Version: m.Version, Collection: col, CollectionDigest: hex.EncodeToString(d[:])}, nil
}

func parseVersion(v string) ([4]int, error) {
	var out [4]int
	parts := strings.Split(v, ".")
	if v == "" || len(parts) > 4 {
		return out, errors.New("not a dotted numeric version")
	}
	for i, p := range parts {
		if p == "" || len(p) > 9 || strings.TrimLeft(p, "0123456789") != "" {
			return out, errors.New("not a dotted numeric version")
		}
		n, err := strconv.Atoi(p)
		if err != nil {
			return out, err
		}
		out[i] = n
	}
	return out, nil
}

func compareVersions(a, b string) (int, error) {
	va, err := parseVersion(a)
	if err != nil {
		return 0, err
	}
	vb, err := parseVersion(b)
	if err != nil {
		return 0, err
	}
	for i := range va {
		if va[i] != vb[i] {
			if va[i] < vb[i] {
				return -1, nil
			}
			return 1, nil
		}
	}
	return 0, nil
}

// sortedKinds is used in error messages so they are stable.
func sortedKinds() string {
	ks := make([]string, len(contract.Kinds))
	for i, k := range contract.Kinds {
		ks[i] = string(k)
	}
	sort.Strings(ks)
	return strings.Join(ks, ", ")
}
