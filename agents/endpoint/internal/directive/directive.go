// Package directive applies governed add-on removal directives (ADR-0331).
//
// This is the endpoint agent's only write outside its own state directory, a narrow and recorded relaxation of
// ADR-0195 decision 19: remove ONE named MCP server entry from ONE MCP client config file that the agent's verified
// collection manifest already locates. There is no shell, no arbitrary path, no file or directory deletion and no
// install. A directive is acted on only when all of these hold:
//
//   - it is signed under a key pinned in the enforcement keyring (the ADR-0298 path; empty until SD4, so nothing
//     verifies in this build);
//   - its schema and action are known and every member is known (closed JSON);
//   - it names this agent's own workload identity;
//   - it is inside its validity window (at most 7 days long, not issued in the future);
//   - its id is not in the replay ledger;
//   - the current verified collection manifest has an mcp_config entry with its signature id and a locator for this
//     OS that matches its root and path, by the same glob the collector uses.
//
// The edit itself reuses the collector's parser and describer, removes the entry only if its identity matches, keeps
// every other byte of the file (tidwall/sjson), checks the result parses to exactly the original minus that entry,
// and replaces the file atomically through the root's os.Root (no symlink escape).
package directive

import (
	"errors"
	"regexp"
	"time"

	"github.com/dhruvmahendrapatel/regulait/agents/endpoint/internal/contract"
	"github.com/dhruvmahendrapatel/regulait/agents/endpoint/internal/enforce"
)

// Schema and the only action this build applies.
const (
	Schema             = "regulait.endpoint-directive/1"
	ActionRemoveServer = "remove_mcp_server"
	// MaxValidity bounds a directive's window; MaxSkew is the clock skew allowed on issuedAt.
	MaxValidity = 7 * 24 * time.Hour
	MaxSkew     = 5 * time.Minute
	maxEnvelope = 64 << 10
)

// SignatureDomain is what a directive's signature covers before the payload bytes: the schema and a NUL (ADR-0331
// addendum, #1033). The gateway signs the same bytes (endpoint-addon-removal.ts: DIRECTIVE_SIGNATURE_DOMAIN).
var SignatureDomain = []byte(Schema + "\x00")

// Directive is a verified directive's payload.
type Directive struct {
	Schema      string    `json:"schema"`
	DirectiveID string    `json:"directiveId"`
	RemovalID   string    `json:"removalId"`
	IdentityID  string    `json:"identityId"`
	IssuedAt    time.Time `json:"issuedAt"`
	NotAfter    time.Time `json:"notAfter"`
	Action      string    `json:"action"`
	Asset       Asset     `json:"asset"`
}

// Asset names the server entry to remove and where it was seen.
type Asset struct {
	SignatureID    string        `json:"signatureId"`
	Root           contract.Root `json:"root"`
	Path           string        `json:"path"`
	ServerName     string        `json:"serverName"`
	IdentityKind   string        `json:"identityKind"`
	Identity       string        `json:"identity"`
	PackageVersion string        `json:"packageVersion,omitempty"`
}

var (
	uuidV4Shape = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
	uuidShape   = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
	// the same entry-name shape the collector reports (collect.serverName), bounded
	serverShape = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`)
)

// ErrRefused wraps every reason a directive is not acted on at all (it is then not reported either: an
// unverifiable directive carries no id this agent can trust).
var ErrRefused = errors.New("directive refused")

// Verify checks one envelope and returns its directive. A directive that verifies but is not for now or not for
// this identity is returned WITH a failed outcome code, so the gateway learns why; one that does not verify is an
// ErrRefused error.
func Verify(raw []byte, keys enforce.Keyring, identityID string, now time.Time) (*Directive, string, error) {
	if len(raw) > maxEnvelope {
		return nil, "", errors.Join(ErrRefused, errors.New("envelope too large"))
	}
	payload, err := enforce.VerifyEnvelopeInDomain(raw, keys, SignatureDomain)
	if err != nil {
		return nil, "", errors.Join(ErrRefused, err)
	}
	var d Directive
	if err := enforce.StrictJSON(payload, &d); err != nil {
		return nil, "", errors.Join(ErrRefused, err)
	}
	if d.Schema != Schema || d.Action != ActionRemoveServer || !uuidV4Shape.MatchString(d.DirectiveID) || !uuidShape.MatchString(d.RemovalID) {
		return nil, "", errors.Join(ErrRefused, errors.New("unknown schema, action or id shape"))
	}
	a := d.Asset
	switch {
	case a.SignatureID == "" || len(a.SignatureID) > 128, a.Path == "" || len(a.Path) > 1024, !serverShape.MatchString(a.ServerName),
		a.Identity == "" || len(a.Identity) > 512, len(a.PackageVersion) > 128:
		return nil, "", errors.Join(ErrRefused, errors.New("asset not well formed"))
	}
	if a.IdentityKind != "package" && a.IdentityKind != "host" && a.IdentityKind != "command" {
		return nil, "", errors.Join(ErrRefused, errors.New("identity kind"))
	}
	if d.IdentityID != identityID {
		return &d, "wrong_identity", nil
	}
	if d.IssuedAt.IsZero() || !d.NotAfter.After(d.IssuedAt) || d.NotAfter.Sub(d.IssuedAt) > MaxValidity || d.IssuedAt.After(now.Add(MaxSkew)) || !now.Before(d.NotAfter) {
		return &d, "expired", nil
	}
	return &d, "", nil
}
