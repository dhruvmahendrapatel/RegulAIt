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
	"github.com/dhruvmahendrapatel/regulait/agents/endpoint/internal/transport"
)

// LocalConfig is the machine's config file, placed by MDM: root-owned, no secrets, not writable by anyone else.
//
// Secure by default (ADR-0180): it holds nothing that can relax the agent. Every limit is compiled in; the file can
// only name the gateway, pin a CA bundle and turn collectors off. Relaxations (a longer buffer, self-update) are
// server-side, audited step-ups that later slices deliver through the gateway, never through this file.
type LocalConfig struct {
	Schema        string          `json:"schema"`
	Issuer        string          `json:"issuer"`
	CABundleFile  string          `json:"caBundleFile,omitempty"`
	DisabledKinds []contract.Kind `json:"disabledKinds,omitempty"`
}

// Config is the validated local config.
type Config struct {
	Issuer   string
	CABundle []byte
	Disabled map[contract.Kind]bool
}

// LoadConfig reads and validates the config file and its CA bundle.
func LoadConfig(path string, owner int) (*Config, error) {
	raw, err := readChecked(path, owner, WorldRead)
	if err != nil {
		return nil, fmt.Errorf("config: %w", err)
	}
	var lc LocalConfig
	if err := strictJSON(raw, &lc); err != nil {
		return nil, fmt.Errorf("config: %w", err)
	}
	if lc.Schema != contract.SchemaConfigFile {
		return nil, fmt.Errorf("config: unknown schema %q", lc.Schema)
	}
	issuer, err := transport.ParseIssuer(lc.Issuer)
	if err != nil {
		return nil, fmt.Errorf("config: %w", err)
	}
	cfg := &Config{Issuer: issuer, Disabled: map[contract.Kind]bool{}}
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
		ca, err := readChecked(lc.CABundleFile, owner, WorldRead)
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

func randomHex(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
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
