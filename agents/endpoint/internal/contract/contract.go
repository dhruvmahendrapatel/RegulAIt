// Package contract is the wire contract between the endpoint agent and the gateway (ADR-0195 SD4, R15 §3.3).
//
// The gateway side does not exist yet: SD4b implements it from these types and from the "As built: SD4a" section
// of ADR-0195, which states the same contract in prose. The golden files in testdata/ are the byte-exact bodies
// this agent sends, for SD4b's tests to parse.
//
// Pseudonymity (ADR-0195 decision 20, R15 call 3): the device hostname is sent only in the ticket redemption and
// the self-reported device user name only in the registration, because the gateway keyed-hashes both and stores
// the display names encrypted. A report never carries either, and never carries an absolute path.
package contract

// Route paths under the issuer. The gateway serves only these to an endpoint agent (`via: "endpoint-agent"`).
const (
	RouteEnrolmentTickets = "/v1/endpoint-agent/enrolment-tickets"
	RouteRegister         = "/v1/endpoint-agent/register"
	RouteCredentials      = "/v1/endpoint-agent/credentials"
	RouteConfig           = "/v1/endpoint-agent/config"
	RouteReports          = "/v1/endpoint-agent/reports"
	RouteToken            = "/oauth/token"
	// ResourcePath is the RFC 8707 resource an agent's self token names (ADR-0188 S7 point 1).
	ResourcePath = "/v1/endpoint-agent"
)

// JOSE `typ` values. The DPoP and rotation proofs are ADR-0188 S7's; the report signature is new in SD4.
const (
	TypDPoP            = "dpop+jwt"
	TypKeyRotation     = "regulait-key-rotation+jwt"
	TypReportSignature = "regulait-endpoint-report+jwt"
	// JWKThumbprintURIPrefix makes the RFC 9278 client id from a key's RFC 7638 thumbprint, as S7 does.
	JWKThumbprintURIPrefix = "urn:ietf:params:oauth:jwk-thumbprint:sha-256:"
	// RotateAfterMember is the non-standard token-response member (ADR-0188 decision 12), epoch seconds.
	RotateAfterMember = "regulait_credential_rotate_after"
)

// Headers the report upload adds beside the DPoP pair.
const (
	HeaderContentDigest   = "Content-Digest"
	HeaderReportSignature = "Regulait-Report-Signature"
)

// Schema identifiers. Every body and every file the agent reads names its schema; an unknown one is refused.
const (
	SchemaReport           = "regulait.endpoint-report/1"
	SchemaEnrolFile        = "regulait.endpoint-enrol/1"
	SchemaTicketFile       = "regulait.endpoint-ticket/1"
	SchemaConfigFile       = "regulait.endpoint-agent-config/1"
	SchemaCollection       = "regulait.endpoint-collection/1"
	SchemaPackManifest     = "regulait.update-bundle/1"
	PackProduct            = "regulait-endpoint-pack"
	CollectionManifestFile = "collection-manifest.json"
)

// Kind is a signature kind (ADR-0195 decision 5). `cli` and `env_name` are R15's proposed additions: the agent
// accepts them in a signed manifest, and SD0/SD3 decide whether the catalogue adopts them.
type Kind string

const (
	KindDesktopApp       Kind = "desktop_app"
	KindIDEExtension     Kind = "ide_extension"
	KindBrowserExtension Kind = "browser_extension"
	KindLocalRuntime     Kind = "local_runtime"
	KindAssistantConfig  Kind = "assistant_config"
	KindCLI              Kind = "cli"
	KindEnvName          Kind = "env_name"
)

// Kinds is the closed set; a manifest naming any other kind is refused.
var Kinds = []Kind{KindDesktopApp, KindIDEExtension, KindBrowserExtension, KindLocalRuntime, KindAssistantConfig, KindCLI, KindEnvName}

// Root names the base a reported path is relative to. Absolute paths never leave the device.
type Root string

const (
	RootHome               Root = "home"                // the user's home directory
	RootSystemApplications Root = "system_applications" // /Applications (macOS), /usr/share/applications (Linux)
	RootAppData            Root = "appdata"             // %APPDATA% (Windows)
	RootLocalAppData       Root = "localappdata"        // %LOCALAPPDATA% (Windows)
	RootPath               Root = "path"                // a PATH directory outside the home directory, by absolute path
	RootRegistry           Root = "registry"            // a Windows registry view: "HKCU" or "HKLM" plus the key
	RootProcessTable       Root = "process_table"       // the OS process and socket tables
)

// KeyProtection is how the device key is held (owner decision d). Posture shows it per device.
type KeyProtection string

const (
	KeyHardware KeyProtection = "hardware"
	KeySoftware KeyProtection = "software"
)

// TicketRequest is POST /v1/endpoint-agent/enrolment-tickets, authenticated by `Authorization: Bearer <bulk token>`.
// Sent once per device by the install step running as root under MDM (R15 §3.2).
type TicketRequest struct {
	// Hostname is sent only so the gateway can keyed-hash it and store the display name encrypted (call 3).
	Hostname     string `json:"hostname"`
	OS           string `json:"os"`
	Arch         string `json:"arch"`
	AgentVersion string `json:"agentVersion"`
}

// TicketResponse is the 201 answer: one device ticket.
type TicketResponse struct {
	Ticket      string `json:"ticket"`
	TicketID    string `json:"ticketId"`
	ExpiresAt   string `json:"expiresAt"` // RFC 3339, UTC
	IdentityCap int    `json:"identityCap"`
}

// RegisterRequest is POST /v1/endpoint-agent/register, authenticated by `Authorization: Bearer <device ticket>`.
// One per user of the device (the agent runs as the logged-in user).
type RegisterRequest struct {
	PublicJWK     map[string]any `json:"publicJwk"` // EC P-256, public members only
	KeyProtection KeyProtection  `json:"keyProtection"`
	KeyProvider   string         `json:"keyProvider"`
	// KeyFallbackReason is set only with a software key: why no hardware key was used.
	KeyFallbackReason string `json:"keyFallbackReason,omitempty"`
	AgentVersion      string `json:"agentVersion"`
	OS                string `json:"os"`
	Arch              string `json:"arch"`
	// DeviceUser is self-reported and unauthenticated; the gateway keyed-hashes it, stores the display name
	// encrypted, and the reveal UI labels it "self-reported by the device" (R15 §3.2).
	DeviceUser string `json:"deviceUser"`
}

// RegisterResponse is the 201 answer.
type RegisterResponse struct {
	IdentityID string `json:"identityId"`
	ClientID   string `json:"clientId"` // the RFC 9278 thumbprint URI of the registered key
}

// RotateRequest is POST /v1/endpoint-agent/credentials: the new key's public JWK and its proof of possession
// (a compact JWS by the new key, `typ` TypKeyRotation, `jwk` header, `aud` the rotation URL), sent with the
// current key's token (ADR-0188 S7 point 4).
type RotateRequest struct {
	PublicJWK map[string]any `json:"publicJwk"`
	Proof     string         `json:"proof"`
}

// ConfigResponse is GET /v1/endpoint-agent/config.
type ConfigResponse struct {
	Pack      SignedPack `json:"pack"`
	OrgPolicy OrgPolicy  `json:"orgPolicy"`
}

// SignedPack is the collection pack in the ADR-0041 manifest format, shipped inline: the manifest's exact bytes,
// its Ed25519 signature, and each listed file's bytes, all standard base64.
type SignedPack struct {
	Manifest  string            `json:"manifest"`
	Signature string            `json:"signature"`
	Files     map[string]string `json:"files"`
}

// OrgPolicy is the per-org settings the gateway serves. It is authenticated by TLS and the agent's token only, not
// by the pack signature, so the agent clamps every value to the compiled bounds and can only be narrowed by it.
type OrgPolicy struct {
	// IntervalSeconds between snapshots. Default daily (decision 9); clamped to [1 h, 7 d].
	IntervalSeconds int `json:"intervalSeconds"`
	// DisabledKinds turns collectors off for the org (narrowing only).
	DisabledKinds []Kind `json:"disabledKinds"`
}

// Report is POST /v1/endpoint-agent/reports: one snapshot of the decision-18 facts. Idempotent on SnapshotID.
type Report struct {
	Schema          string        `json:"schema"`
	SnapshotID      string        `json:"snapshotId"`  // UUID v4
	CollectedAt     string        `json:"collectedAt"` // RFC 3339, UTC
	AgentVersion    string        `json:"agentVersion"`
	OS              string        `json:"os"`
	Arch            string        `json:"arch"`
	ManifestVersion string        `json:"manifestVersion"`
	ManifestDigest  string        `json:"manifestDigest"` // hex SHA-256 of the collection manifest bytes
	KeyProtection   KeyProtection `json:"keyProtection"`
	// DroppedSnapshots counts snapshots not delivered since the last accepted one, so a gap is visible.
	DroppedSnapshots int    `json:"droppedSnapshots"`
	Facts            []Fact `json:"facts"`
	Gaps             []Gap  `json:"gaps"`
	// FactsDigest is the hex SHA-256 of the agent's own encoding of Facts. It is opaque to the gateway, which
	// stores it and compares it for equality only (never recomputes it), and it is a digest of redacted facts,
	// never of raw collector output (R15 §2.3).
	FactsDigest string `json:"factsDigest"`
}

// Fact is one matched observation. Every value in it is catalogue data from the signed manifest, a relative path,
// a version string read from a manifest file, a port, or a key name. Never a value, a file's contents or a person.
type Fact struct {
	Kind        Kind     `json:"kind"`
	SignatureID string   `json:"signatureId"`
	Provider    string   `json:"provider"`
	MatchedOn   string   `json:"matchedOn"`  // which manifest field matched, e.g. "bundleId", "processName"
	Identifier  string   `json:"identifier"` // the manifest identifier that matched (catalogue data)
	Location    Location `json:"location"`
	Version     string   `json:"version,omitempty"`
	Port        int      `json:"port,omitempty"`
	// PortOnly marks a listener whose owning process could not be read (another user's), so only the port matched.
	PortOnly bool       `json:"portOnly,omitempty"`
	Keys     []KeyFound `json:"keys,omitempty"`
}

// Location is where a fact was seen, relative to a Root.
type Location struct {
	Root Root   `json:"root"`
	Path string `json:"path"`
}

// KeyFound records key presence only (R15 call 2): no value and no prefix.
type KeyFound struct {
	KeyName string `json:"keyName"`          // the field or variable name holding the key
	RuleID  string `json:"ruleId,omitempty"` // the compiled `dlp.secret.*` rule that matched, if any
	Present bool   `json:"present"`
}

// Gap is something a collector could not observe, so posture tells the truth about coverage.
type Gap struct {
	Kind   Kind   `json:"kind"`
	Reason string `json:"reason"`
}

// ReportResponse is the 202 answer.
type ReportResponse struct {
	Accepted  bool `json:"accepted"`
	Duplicate bool `json:"duplicate"`
}

// ErrorBody is every refusal's body. Error is a stable code (e.g. `enrolment_cap_reached`).
type ErrorBody struct {
	Error string `json:"error"`
}

// Refusal codes the agent acts on.
const (
	ErrEnrolmentCapReached = "enrolment_cap_reached"
	ErrTokenExpired        = "token_expired"
	ErrTokenRevoked        = "token_revoked"
	ErrTicketExpired       = "ticket_expired"
	ErrTicketExhausted     = "ticket_exhausted"
	ErrUseDPoPNonce        = "use_dpop_nonce"
	ErrDeviceRevoked       = "device_revoked"
)
