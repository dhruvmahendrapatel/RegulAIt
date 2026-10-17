package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"time"

	"github.com/dhruvmahendrapatel/regulait/agents/endpoint/internal/auth"
	"github.com/dhruvmahendrapatel/regulait/agents/endpoint/internal/contract"
	"github.com/dhruvmahendrapatel/regulait/agents/endpoint/internal/devicekey"
	"github.com/dhruvmahendrapatel/regulait/agents/endpoint/internal/transport"
)

// Version is set at build time (-ldflags -X).
var Version = "0.0.0-dev"

// Options are the agent's dependencies. Production fills them from the OS; tests replace them.
type Options struct {
	Paths Paths
	// SystemOwner is the uid the config, token and ticket files must belong to (root; tests use their own uid).
	SystemOwner int
	// TicketGID is the group the ticket file is given, resolved by the package's install script (-1 to leave it).
	TicketGID int
	Log       *slog.Logger
	Now       func() time.Time
	Hostname  func() (string, error)
	UserName  func() string
	Stores    func(stateDir string) (devicekey.Store, devicekey.Store)
	HTTP      func(issuer string, ca []byte) (*http.Client, error)
}

func (o *Options) defaults() {
	if o.Log == nil {
		o.Log = slog.New(slog.NewTextHandler(os.Stderr, nil))
	}
	if o.Now == nil {
		o.Now = time.Now
	}
	if o.Hostname == nil {
		o.Hostname = os.Hostname
	}
	if o.UserName == nil {
		o.UserName = currentUserName
	}
	if o.Stores == nil {
		o.Stores = devicekey.PlatformStores
	}
	if o.HTTP == nil {
		o.HTTP = transport.New
	}
}

// Redemption outcomes, written to the status file the agent and posture read.
const (
	OutcomeTicketValid        = "ticket_valid"
	OutcomeRedeemed           = "redeemed"
	OutcomeRefused            = "refused"
	OutcomeTokenFileUnsafe    = "token_file_unsafe"
	OutcomeTokenFileInvalid   = "token_file_invalid"
	OutcomeTokenExpired       = "token_expired"
	OutcomeConfigInvalid      = "config_invalid"
	OutcomeGatewayUnreachable = "gateway_unreachable"
	OutcomeGatewayError       = "gateway_error"
	OutcomeWriteFailed        = "ticket_write_failed"
)

// RedeemStatus is the install step's outcome. It holds no secret.
type RedeemStatus struct {
	Schema   string `json:"schema"`
	Outcome  string `json:"outcome"`
	Code     string `json:"code,omitempty"`
	TicketID string `json:"ticketId,omitempty"`
	At       string `json:"at"`
}

// ticketMargin: a ticket that expires sooner than this is replaced rather than relied on.
const ticketMargin = time.Hour

// Redeem is the package's install step, run once as root under MDM (R15 §3.2). It redeems the bulk token for a
// device ticket only when the device holds no valid ticket, and it never fails the install: every outcome is
// logged and written to the status file, and the caller exits 0.
func Redeem(ctx context.Context, o Options) RedeemStatus {
	o.defaults()
	st := func(outcome, code, ticketID string) RedeemStatus {
		s := RedeemStatus{Schema: "regulait.endpoint-redeem-status/1", Outcome: outcome, Code: code, TicketID: ticketID, At: o.Now().UTC().Format(time.RFC3339)}
		if b, err := json.MarshalIndent(s, "", "  "); err == nil {
			if err := writeAtomic(o.Paths.StatusFile, append(b, '\n'), 0o644, -1); err != nil {
				o.Log.Error("install step: could not write the status file", "err", err)
			}
		}
		level := slog.LevelInfo
		if outcome != OutcomeRedeemed && outcome != OutcomeTicketValid {
			level = slog.LevelWarn
		}
		o.Log.Log(ctx, level, "install step: enrolment ticket", "outcome", outcome, "code", code)
		return s
	}
	cfg, err := LoadConfig(o.Paths.ConfigFile, o.SystemOwner)
	if err != nil {
		o.Log.Warn("install step", "err", err)
		return st(OutcomeConfigInvalid, "", "")
	}
	if t, err := readTicket(o, cfg); err == nil {
		return st(OutcomeTicketValid, "", t.TicketID)
	}
	raw, err := readChecked(o.Paths.EnrolFile, o.SystemOwner, OwnerOnly)
	if errors.Is(err, ErrUnsafeFile) {
		// the fleet token must never be readable by ordinary users; an exposed one is not used
		o.Log.Error("install step: the bulk token file is not root-only; it was not used", "err", err)
		return st(OutcomeTokenFileUnsafe, "", "")
	}
	if err != nil {
		return st(OutcomeTokenFileInvalid, "unreadable", "")
	}
	var ef EnrolFile
	if err := strictJSON(raw, &ef); err != nil || ef.Schema != contract.SchemaEnrolFile || !validSecret(ef.Token) {
		return st(OutcomeTokenFileInvalid, "malformed", "")
	}
	if iss, err := transport.ParseIssuer(ef.Issuer); err != nil || iss != cfg.Issuer {
		return st(OutcomeTokenFileInvalid, "issuer_mismatch", "")
	}
	if ef.ExpiresAt != "" {
		exp, err := parseTime(ef.ExpiresAt)
		if err != nil {
			return st(OutcomeTokenFileInvalid, "malformed", "")
		}
		if !o.Now().Before(exp) {
			return st(OutcomeTokenExpired, contract.ErrTokenExpired, "")
		}
	}
	host, err := o.Hostname()
	if err != nil || host == "" {
		host = "unknown"
	}
	client, err := o.HTTP(cfg.Issuer, cfg.CABundle)
	if err != nil {
		return st(OutcomeConfigInvalid, "", "")
	}
	body, _ := json.Marshal(contract.TicketRequest{Hostname: host, OS: runtime.GOOS, Arch: runtime.GOARCH, AgentVersion: Version})
	res, err := auth.Send(ctx, client, http.MethodPost, cfg.Issuer+contract.RouteEnrolmentTickets,
		http.Header{"Authorization": {"Bearer " + ef.Token}, "Content-Type": {"application/json"}}, body)
	if err != nil {
		return st(OutcomeGatewayUnreachable, "", "")
	}
	if res.Status >= 500 || res.Status == 429 {
		return st(OutcomeGatewayError, fmt.Sprint(res.Status), "")
	}
	if res.Status != http.StatusCreated {
		code := res.Code()
		if code == "" {
			code = fmt.Sprint(res.Status)
		}
		return st(OutcomeRefused, code, "")
	}
	var tr contract.TicketResponse
	if err := strictJSON(res.Body, &tr); err != nil || !validSecret(tr.Ticket) || tr.TicketID == "" {
		return st(OutcomeGatewayError, "malformed_ticket", "")
	}
	exp, err := parseTime(tr.ExpiresAt)
	if err != nil || !exp.After(o.Now()) {
		return st(OutcomeGatewayError, "malformed_ticket", "")
	}
	tf, _ := json.MarshalIndent(TicketFile{Schema: contract.SchemaTicketFile, Issuer: cfg.Issuer, Ticket: tr.Ticket, TicketID: tr.TicketID,
		ExpiresAt: exp.UTC().Format(time.RFC3339), IdentityCap: tr.IdentityCap}, "", "  ")
	if err := os.MkdirAll(filepath.Dir(o.Paths.TicketFile), 0o755); err != nil {
		return st(OutcomeWriteFailed, "", tr.TicketID)
	}
	if err := writeAtomic(o.Paths.TicketFile, append(tf, '\n'), 0o640, o.TicketGID); err != nil {
		o.Log.Error("install step: could not write the ticket file", "err", err)
		return st(OutcomeWriteFailed, "", tr.TicketID)
	}
	return st(OutcomeRedeemed, "", tr.TicketID)
}

// ErrWaitingForTicket: the device has no usable ticket yet (late first login, an expired ticket). The next MDM
// re-push redeems a new one (R15 §3.2).
var ErrWaitingForTicket = errors.New("waiting for enrolment ticket")

func readTicket(o Options, cfg *Config) (*TicketFile, error) {
	raw, err := readChecked(o.Paths.TicketFile, o.SystemOwner, GroupRead)
	if err != nil {
		return nil, err
	}
	var t TicketFile
	if err := strictJSON(raw, &t); err != nil || t.Schema != contract.SchemaTicketFile || !validSecret(t.Ticket) {
		return nil, errors.New("the ticket file is malformed")
	}
	if t.Issuer != cfg.Issuer {
		return nil, errors.New("the ticket names another issuer")
	}
	exp, err := parseTime(t.ExpiresAt)
	if err != nil || !o.Now().Add(ticketMargin).Before(exp) {
		return nil, errors.New("the ticket has expired")
	}
	return &t, nil
}

// RegistrationError is a refusal from the register route.
type RegistrationError struct {
	Status int
	Code   string
}

func (e *RegistrationError) Error() string {
	return fmt.Sprintf("registration refused: HTTP %d %s", e.Status, e.Code)
}

func loadState(o Options) (*State, error) {
	raw, err := readChecked(filepath.Join(o.Paths.StateDir, "state.json"), ownUID(), OwnerOnly)
	if errors.Is(err, os.ErrNotExist) {
		return &State{Schema: schemaState}, nil
	}
	if err != nil {
		return nil, err
	}
	var s State
	if err := strictJSON(raw, &s); err != nil || s.Schema != schemaState {
		return nil, errors.New("the state file is malformed")
	}
	return &s, nil
}

func saveState(o Options, s *State) error {
	if err := ensurePrivateDir(o.Paths.StateDir); err != nil {
		return err
	}
	b, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	return writeAtomic(filepath.Join(o.Paths.StateDir, "state.json"), append(b, '\n'), 0o600, -1)
}

// storeByName finds the store a saved key id belongs to.
func storeByName(o Options, name string) (devicekey.Store, error) {
	hw, sw := o.Stores(o.Paths.StateDir)
	for _, s := range []devicekey.Store{hw, sw} {
		if s != nil && s.Provider() == name {
			return s, nil
		}
	}
	return nil, fmt.Errorf("this build has no %q key store", name)
}

// Register is the per-user first run (R15 §3.2): create the device key (hardware by default), and register its
// public half with the device ticket. It is idempotent: a registered user is left alone, and a key created by a
// registration whose answer was lost is reused, so the gateway sees the same key again.
func Register(ctx context.Context, o Options) (*State, error) {
	o.defaults()
	cfg, err := LoadConfig(o.Paths.ConfigFile, o.SystemOwner)
	if err != nil {
		return nil, err
	}
	s, err := loadState(o)
	if err != nil {
		return nil, err
	}
	if s.ClientID != "" && s.Issuer == cfg.Issuer {
		return s, nil
	}
	ticket, err := readTicket(o, cfg)
	if err != nil {
		o.Log.Warn("not enrolled", "reason", ErrWaitingForTicket.Error(), "detail", err)
		return nil, fmt.Errorf("%w: %v", ErrWaitingForTicket, err)
	}
	var key devicekey.Key
	if s.KeyID != "" {
		if store, err := storeByName(o, s.KeyProvider); err == nil {
			key, _ = store.Load(s.KeyID)
		}
	}
	if key == nil {
		hw, sw := o.Stores(o.Paths.StateDir)
		sel, err := devicekey.Select(hw, sw, o.Log)
		if err != nil {
			return nil, err
		}
		key, err = sel.Store.Create()
		if err != nil {
			return nil, fmt.Errorf("creating the device key: %w", err)
		}
		s.KeyID, s.KeyProvider, s.KeyProtection, s.FallbackReason = key.ID(), sel.Store.Provider(), sel.Store.Protection(), sel.FallbackReason
		s.Issuer = cfg.Issuer
		if err := saveState(o, s); err != nil {
			return nil, err
		}
	}
	jwk, err := auth.PublicJWK(key.Public())
	if err != nil {
		return nil, err
	}
	clientID, err := auth.ClientID(key.Public())
	if err != nil {
		return nil, err
	}
	body, _ := json.Marshal(contract.RegisterRequest{PublicJWK: jwk, KeyProtection: s.KeyProtection, KeyProvider: s.KeyProvider,
		KeyFallbackReason: s.FallbackReason, AgentVersion: Version, OS: runtime.GOOS, Arch: runtime.GOARCH, DeviceUser: o.UserName()})
	client, err := o.HTTP(cfg.Issuer, cfg.CABundle)
	if err != nil {
		return nil, err
	}
	res, err := auth.Send(ctx, client, http.MethodPost, cfg.Issuer+contract.RouteRegister,
		http.Header{"Authorization": {"Bearer " + ticket.Ticket}, "Content-Type": {"application/json"}}, body)
	if err != nil {
		return nil, err
	}
	if res.Status != http.StatusCreated {
		return nil, &RegistrationError{Status: res.Status, Code: res.Code()}
	}
	var rr contract.RegisterResponse
	if err := strictJSON(res.Body, &rr); err != nil || rr.IdentityID == "" {
		return nil, errors.New("the registration answer is malformed")
	}
	if rr.ClientID != clientID {
		return nil, errors.New("the gateway registered a different key than the agent sent")
	}
	s.ClientID, s.IdentityID, s.RegisteredAt = rr.ClientID, rr.IdentityID, o.Now().UTC().Format(time.RFC3339)
	if err := saveState(o, s); err != nil {
		return nil, err
	}
	o.Log.Info("registered", "keyProtection", s.KeyProtection, "keyProvider", s.KeyProvider)
	return s, nil
}
