// Package agent ties the endpoint agent together: the local config, enrolment, the collection cycle, the signed
// upload and key rotation (ADR-0195 SD4, R15 §3).
package agent

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/dhruvmahendrapatel/regulait/agents/endpoint/internal/contract"
	"github.com/dhruvmahendrapatel/regulait/agents/endpoint/internal/enforce"
	"github.com/dhruvmahendrapatel/regulait/agents/endpoint/internal/fsutil"
	"github.com/dhruvmahendrapatel/regulait/agents/endpoint/internal/secrets"
	"github.com/dhruvmahendrapatel/regulait/agents/endpoint/internal/transport"
)

// LocalConfig is the machine's config file, placed by MDM: root-owned, no secrets, not writable by anyone else.
//
// Secure by default (ADR-0180): it holds nothing that can relax the agent. Every limit is compiled in; the file can
// only name the gateway, pin a CA bundle and turn collectors off. Relaxations (a longer buffer, self-update) are
// server-side, audited step-ups that later slices deliver through the gateway, never through this file.
//
// Self-update in particular (ADR-0360 §2, §4): this file has no member that turns it on. The admin relaxes it per
// ADR-0350 device group on the gateway (a settings_relax step-up, audited), and the device acts only on a directive the device-policy
// signer signed for it, for a release the release keys signed. Pinning those keys here says whose signatures count; it
// turns nothing on.
type LocalConfig struct {
	Schema        string          `json:"schema"`
	Issuer        string          `json:"issuer"`
	CABundleFile  string          `json:"caBundleFile,omitempty"`
	DisabledKinds []contract.Kind `json:"disabledKinds,omitempty"`
	// DevicePolicyKeys pins the control plane's device-policy signer (owner decision B4, ADR-0330 §8): the public
	// keys the on-device enforcement hook verifies signed policies with, the current key and at most one next key.
	// Pinning authorises policies signed by these keys, and so whatever they allow; a pin never overrides a compiled
	// key, and nothing here relaxes the agent without such a signed policy.
	DevicePolicyKeys []enforce.PinnedKey `json:"devicePolicyKeys,omitempty"`
	// CredentialReuseKey is the tenant's credential-reuse fingerprint key (ADR-0350 §11), 32 bytes base64url, the
	// same on every device of the tenant (`regulait-agent credential-reuse-key` makes one). Absent: no fingerprints.
	// This file is world-readable, so the key is not a secret from local users; the control plane keys every
	// fingerprint again under its own data key before storing it.
	CredentialReuseKey string `json:"credentialReuseKey,omitempty"`
	// ReleaseKeys pins the release pipeline's signer (ADR-0360 §4): the keys a release manifest must be signed by, the
	// current key and at most one next key. A key of its own, never a device-policy key. With none pinned, the updater
	// never installs anything.
	ReleaseKeys []enforce.PinnedKey `json:"releaseKeys,omitempty"`
}

// Config is the validated local config.
type Config struct {
	Issuer   string
	CABundle []byte
	Disabled map[contract.Kind]bool
	// DevicePolicyKeys is the validated pinned device-policy keyring (empty when none is pinned).
	DevicePolicyKeys enforce.Keyring
	// CredentialReuse fingerprints reported keys; nil when no key is configured.
	CredentialReuse *secrets.Fingerprinter
	// ReleaseKeys is the validated pinned release keyring (empty when none is pinned).
	ReleaseKeys enforce.Keyring
}

// LoadConfig reads and validates the config file and its CA bundle.
func LoadConfig(path string, owner int) (*Config, error) {
	raw, err := readChecked(path, owner, fsutil.WorldRead)
	if err != nil {
		return nil, fmt.Errorf("config: %w", err)
	}
	var lc LocalConfig
	if err := fsutil.StrictJSON(raw, &lc); err != nil {
		return nil, fmt.Errorf("config: %w", err)
	}
	if lc.Schema != contract.SchemaConfigFile {
		return nil, fmt.Errorf("config: unknown schema %q", lc.Schema)
	}
	issuer, err := transport.ParseIssuer(lc.Issuer)
	if err != nil {
		return nil, fmt.Errorf("config: %w", err)
	}
	keys, err := enforce.KeyringFrom(lc.DevicePolicyKeys)
	if err != nil {
		return nil, fmt.Errorf("config: %w", err)
	}
	releaseKeys, err := enforce.KeyringFrom(lc.ReleaseKeys)
	if err != nil {
		return nil, fmt.Errorf("config: release keys: %w", err)
	}
	for id := range releaseKeys {
		if _, shared := keys[id]; shared {
			return nil, errors.New("config: a key is pinned as both a device-policy key and a release key (one key per purpose)")
		}
	}
	cfg := &Config{Issuer: issuer, Disabled: map[contract.Kind]bool{}, DevicePolicyKeys: keys, ReleaseKeys: releaseKeys}
	if lc.CredentialReuseKey != "" {
		if cfg.CredentialReuse, err = secrets.NewFingerprinter(lc.CredentialReuseKey); err != nil {
			return nil, fmt.Errorf("config: %w", err)
		}
	}
	for _, k := range lc.DisabledKinds {
		known := false
		for _, kk := range contract.Kinds {
			known = known || k == kk
		}
		if !known {
			return nil, fmt.Errorf("config: unknown kind %q in disabledKinds", k)
		}
		cfg.Disabled[k] = true
	}
	if lc.CABundleFile != "" {
		if !filepath.IsAbs(lc.CABundleFile) {
			return nil, errors.New("config: caBundleFile must be an absolute path")
		}
		ca, err := readChecked(lc.CABundleFile, owner, fsutil.WorldRead)
		if err != nil {
			return nil, fmt.Errorf("config: CA bundle: %w", err)
		}
		cfg.CABundle = ca
	}
	return cfg, nil
}

// EnrolFile is the bulk enrolment token file MDM places (R15 §3.2): root-only, 0600.
type EnrolFile struct {
	Schema    string `json:"schema"`
	Issuer    string `json:"issuer"`
	Token     string `json:"token"`
	ExpiresAt string `json:"expiresAt,omitempty"`
}

// TicketFile is the device ticket the install step writes: root-owned, 0640, group regulait-agent.
type TicketFile struct {
	Schema      string `json:"schema"`
	Issuer      string `json:"issuer"`
	Ticket      string `json:"ticket"`
	TicketID    string `json:"ticketId"`
	ExpiresAt   string `json:"expiresAt"`
	IdentityCap int    `json:"identityCap"`
}

// State is the per-user agent state, 0600 in the user's state directory.
type State struct {
	Schema           string                 `json:"schema"`
	Issuer           string                 `json:"issuer"`
	KeyID            string                 `json:"keyId"`
	KeyProvider      string                 `json:"keyProvider"`
	KeyProtection    contract.KeyProtection `json:"keyProtection"`
	FallbackReason   string                 `json:"fallbackReason,omitempty"`
	IdentityID       string                 `json:"identityId,omitempty"`
	ClientID         string                 `json:"clientId,omitempty"`
	PendingKeyID     string                 `json:"pendingKeyId,omitempty"`
	PackVersion      string                 `json:"packVersion,omitempty"`
	DroppedSnapshots int                    `json:"droppedSnapshots"`
	LastFactsDigest  string                 `json:"lastFactsDigest,omitempty"`
	RegisteredAt     string                 `json:"registeredAt,omitempty"`
}

const schemaState = "regulait.endpoint-agent-state/1"

// validSecret admits an opaque bearer value: printable ASCII with no space, 16 to 512 characters.
func validSecret(s string) bool {
	if len(s) < 16 || len(s) > 512 {
		return false
	}
	for _, c := range s {
		if c <= ' ' || c > '~' {
			return false
		}
	}
	return true
}

func parseTime(s string) (time.Time, error) {
	return time.Parse(time.RFC3339, s)
}

// uuidV4 formats 16 random bytes as an RFC 9562 version-4 UUID.
func uuidV4() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	h := hex.EncodeToString(b)
	return strings.Join([]string{h[0:8], h[8:12], h[12:16], h[16:20], h[20:32]}, "-")
}

func ensurePrivateDir(dir string) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	return os.Chmod(dir, 0o700)
}
