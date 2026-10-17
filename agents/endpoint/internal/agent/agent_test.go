//go:build !windows

package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/dhruvmahendrapatel/regulait/agents/endpoint/internal/collect"
	"github.com/dhruvmahendrapatel/regulait/agents/endpoint/internal/contract"
	"github.com/dhruvmahendrapatel/regulait/agents/endpoint/internal/devicekey"
	"github.com/dhruvmahendrapatel/regulait/agents/endpoint/internal/gatewaytest"
	"github.com/dhruvmahendrapatel/regulait/agents/endpoint/internal/pack/packtest"
	"github.com/dhruvmahendrapatel/regulait/agents/endpoint/internal/privacy"
	"github.com/dhruvmahendrapatel/regulait/agents/endpoint/internal/transport"
)

// noHardware stands in for a machine with no TPM, so the file fallback is taken (and flagged).
type noHardware struct{ devicekey.FileStore }

func (noHardware) Provider() string                   { return "tpm" }
func (noHardware) Protection() contract.KeyProtection { return contract.KeyHardware }
func (noHardware) Probe() error                       { return fmt.Errorf("%w: test machine", devicekey.ErrNoHardware) }

const collection = `{"schema":"regulait.endpoint-collection/1","entries":[
 {"signatureId":"sig.config","kind":"assistant_config","provider":"example","keyNames":["EXAMPLE_API_KEY"],
  "files":[{"os":"linux","root":"home","path":".config/example/settings.json"},{"os":"darwin","root":"home","path":".config/example/settings.json"}]},
 {"signatureId":"sig.env","kind":"env_name","provider":"example","envNames":["EXAMPLE_API_KEY"]}
]}`

func bulkToken() string { return "bulk-" + strings.Repeat("t", 24) }

type fixture struct {
	t      *testing.T
	gw     *gatewaytest.Gateway
	dir    string
	opts   Options
	signer *packtest.Signer
	logs   *strings.Builder
}

func newFixture(t *testing.T, cap int) *fixture {
	t.Helper()
	gw := gatewaytest.New(bulkToken(), cap)
	t.Cleanup(gw.Close)
	dir := t.TempDir()
	sys := filepath.Join(dir, "sys")
	os.MkdirAll(sys, 0o755)
	ca := filepath.Join(sys, "ca.pem")
	os.WriteFile(ca, gw.CAPEM(), 0o644)
	cfg := fmt.Sprintf(`{"schema":"regulait.endpoint-agent-config/1","issuer":%q,"caBundleFile":%q}`, gw.Issuer, ca)
	os.WriteFile(filepath.Join(sys, "config.json"), []byte(cfg), 0o644)
	enrol := fmt.Sprintf(`{"schema":"regulait.endpoint-enrol/1","issuer":%q,"token":%q}`, gw.Issuer, bulkToken())
	os.WriteFile(filepath.Join(sys, "enrol.json"), []byte(enrol), 0o600)
	logs := &strings.Builder{}
	f := &fixture{t: t, gw: gw, dir: dir, logs: logs, signer: packtest.NewSigner()}
	f.opts = Options{
		Paths: Paths{ConfigFile: filepath.Join(sys, "config.json"), EnrolFile: filepath.Join(sys, "enrol.json"), TicketFile: filepath.Join(sys, "ticket.json"),
			StatusFile: filepath.Join(sys, "redeem-status.json"), StateDir: filepath.Join(dir, "user", "state")},
		SystemOwner: os.Getuid(), TicketGID: -1,
		Log:      slog.New(slog.NewTextHandler(logs, nil)),
		Hostname: func() (string, error) { return "jdoe-laptop", nil },
		UserName: func() string { return "jdoe" },
		Stores: func(state string) (devicekey.Store, devicekey.Store) {
			d := filepath.Join(state, "keys")
			return noHardware{devicekey.FileStore{Dir: d}}, devicekey.FileStore{Dir: d}
		},
		HTTP: transport.New,
	}
	gw.Lock()
	gw.Config = contract.ConfigResponse{Pack: f.signer.Pack("1.0.0", []byte(collection)), OrgPolicy: contract.OrgPolicy{IntervalSeconds: 60}}
	gw.Unlock()
	return f
}

func (f *fixture) cycle() *Cycle {
	home := fstest.MapFS{
		".config/example/settings.json": {Data: []byte(`{"env":{"EXAMPLE_API_KEY":"sk-ant-api03-` + strings.Repeat("Z", 40) + `"}}`)},
		".bashrc":                       {Data: []byte("export EXAMPLE_API_KEY=\n")},
	}
	return &Cycle{
		Options: f.opts,
		Keyring: f.signer.Keyring(),
		Env: func() (*collect.Env, error) {
			return &collect.Env{OS: "linux", Roots: map[contract.Root]fs.FS{contract.RootHome: home}, StartupFiles: collect.DefaultStartupFiles("linux")}, nil
		},
		Identity: privacy.Identity{HomeDir: "/home/jdoe", UserName: "jdoe", Hostname: "jdoe-laptop"},
	}
}

func TestRedeemWritesARestrictedTicket(t *testing.T) {
	f := newFixture(t, 2)
	st := Redeem(context.Background(), f.opts)
	if st.Outcome != OutcomeRedeemed || st.TicketID == "" {
		t.Fatalf("%+v\n%s", st, f.logs)
	}
	info, err := os.Stat(f.opts.Paths.TicketFile)
	if err != nil || info.Mode().Perm() != 0o640 {
		t.Fatalf("ticket mode: %v %v", info, err)
	}
	status, _ := os.ReadFile(f.opts.Paths.StatusFile)
	if strings.Contains(string(status), bulkToken()) || strings.Contains(string(status), "ticket-") {
		t.Fatalf("the status file carries a secret: %s", status)
	}
	// the hostname went to the ticket route (to be hashed server-side) and the bulk token only as a bearer
	f.gw.Lock()
	req := f.gw.Requests[0]
	f.gw.Unlock()
	if !strings.Contains(string(req.Body), `"hostname":"jdoe-laptop"`) || strings.Contains(string(req.Body), bulkToken()) {
		t.Fatalf("ticket request body: %s", req.Body)
	}
	// a second run with a valid ticket does not redeem again (no second device counted)
	if st := Redeem(context.Background(), f.opts); st.Outcome != OutcomeTicketValid {
		t.Fatalf("%+v", st)
	}
	f.gw.Lock()
	defer f.gw.Unlock()
	if f.gw.Devices != 1 {
		t.Fatalf("devices counted: %d", f.gw.Devices)
	}
}

func TestRedeemRefusals(t *testing.T) {
	t.Run("cap reached", func(t *testing.T) {
		f := newFixture(t, 0)
		if st := Redeem(context.Background(), f.opts); st.Outcome != OutcomeRefused || st.Code != contract.ErrEnrolmentCapReached {
			t.Fatalf("%+v", st)
		}
		if _, err := os.Stat(f.opts.Paths.TicketFile); !errors.Is(err, os.ErrNotExist) {
			t.Fatal("a ticket was written")
		}
	})
	t.Run("token expired at the gateway", func(t *testing.T) {
		f := newFixture(t, 5)
		f.gw.Lock()
		f.gw.TokenExpired = true
		f.gw.Unlock()
		if st := Redeem(context.Background(), f.opts); st.Outcome != OutcomeRefused || st.Code != contract.ErrTokenExpired {
			t.Fatalf("%+v", st)
		}
	})
	t.Run("token expired locally is never sent", func(t *testing.T) {
		f := newFixture(t, 5)
		enrol := fmt.Sprintf(`{"schema":"regulait.endpoint-enrol/1","issuer":%q,"token":%q,"expiresAt":"2020-01-01T00:00:00Z"}`, f.gw.Issuer, bulkToken())
		os.WriteFile(f.opts.Paths.EnrolFile, []byte(enrol), 0o600)
		if st := Redeem(context.Background(), f.opts); st.Outcome != OutcomeTokenExpired {
			t.Fatalf("%+v", st)
		}
		f.gw.Lock()
		defer f.gw.Unlock()
		if len(f.gw.Requests) != 0 {
			t.Fatal("an expired token was sent")
		}
	})
	t.Run("token file readable by others is never used", func(t *testing.T) {
		f := newFixture(t, 5)
		os.Chmod(f.opts.Paths.EnrolFile, 0o644)
		if st := Redeem(context.Background(), f.opts); st.Outcome != OutcomeTokenFileUnsafe {
			t.Fatalf("%+v", st)
		}
		f.gw.Lock()
		defer f.gw.Unlock()
		if len(f.gw.Requests) != 0 {
			t.Fatal("an exposed token was sent")
		}
	})
	t.Run("token file is a symlink", func(t *testing.T) {
		f := newFixture(t, 5)
		real := filepath.Join(f.dir, "elsewhere.json")
		os.Rename(f.opts.Paths.EnrolFile, real)
		os.Symlink(real, f.opts.Paths.EnrolFile)
		if st := Redeem(context.Background(), f.opts); st.Outcome == OutcomeRedeemed {
			t.Fatalf("followed a symlink: %+v", st)
		}
	})
	t.Run("token for another issuer", func(t *testing.T) {
		f := newFixture(t, 5)
		enrol := fmt.Sprintf(`{"schema":"regulait.endpoint-enrol/1","issuer":"https://other.example.invalid","token":%q}`, bulkToken())
		os.WriteFile(f.opts.Paths.EnrolFile, []byte(enrol), 0o600)
		if st := Redeem(context.Background(), f.opts); st.Outcome != OutcomeTokenFileInvalid || st.Code != "issuer_mismatch" {
			t.Fatalf("%+v", st)
		}
	})
	t.Run("wrong bulk token", func(t *testing.T) {
		f := newFixture(t, 5)
		enrol := fmt.Sprintf(`{"schema":"regulait.endpoint-enrol/1","issuer":%q,"token":%q}`, f.gw.Issuer, "bulk-"+strings.Repeat("x", 24))
		os.WriteFile(f.opts.Paths.EnrolFile, []byte(enrol), 0o600)
		if st := Redeem(context.Background(), f.opts); st.Outcome != OutcomeRefused {
			t.Fatalf("%+v", st)
		}
	})
	t.Run("gateway unreachable", func(t *testing.T) {
		f := newFixture(t, 5)
		f.gw.Close()
		if st := Redeem(context.Background(), f.opts); st.Outcome != OutcomeGatewayUnreachable {
			t.Fatalf("%+v", st)
		}
	})
	t.Run("config writable by others", func(t *testing.T) {
		f := newFixture(t, 5)
		os.Chmod(f.opts.Paths.ConfigFile, 0o666)
		if st := Redeem(context.Background(), f.opts); st.Outcome != OutcomeConfigInvalid {
			t.Fatalf("%+v", st)
		}
	})
}

func TestRegister(t *testing.T) {
	f := newFixture(t, 5)
	if _, err := Register(context.Background(), f.opts); !errors.Is(err, ErrWaitingForTicket) {
		t.Fatalf("registered without a ticket: %v", err)
	}
	Redeem(context.Background(), f.opts)
	s, err := Register(context.Background(), f.opts)
	if err != nil {
		t.Fatal(err)
	}
	if s.KeyProtection != contract.KeySoftware || s.KeyProvider != "file" || !strings.Contains(s.FallbackReason, "no key hardware") {
		t.Fatalf("software fallback not recorded: %+v", s)
	}
	f.gw.Lock()
	reg := f.gw.Requests[len(f.gw.Requests)-1]
	f.gw.Unlock()
	var body contract.RegisterRequest
	json.Unmarshal(reg.Body, &body)
	if body.KeyProtection != contract.KeySoftware || body.KeyFallbackReason == "" || body.DeviceUser != "jdoe" {
		t.Fatalf("registration body: %s", reg.Body)
	}
	if _, ok := body.PublicJWK["d"]; ok {
		t.Fatal("the private key was sent")
	}
	if !strings.Contains(f.logs.String(), "SOFTWARE fallback") {
		t.Fatal("the fallback was not logged")
	}
	// idempotent: a second call sends nothing
	n := len(f.gw.Requests)
	if _, err := Register(context.Background(), f.opts); err != nil || len(f.gw.Requests) != n {
		t.Fatalf("re-registered: %v", err)
	}
	st, _ := os.Stat(filepath.Join(f.opts.Paths.StateDir, "state.json"))
	if st.Mode().Perm() != 0o600 {
		t.Fatalf("state mode %o", st.Mode().Perm())
	}
}

func TestRegisterWithExpiredTicket(t *testing.T) {
	f := newFixture(t, 5)
	Redeem(context.Background(), f.opts)
	raw, _ := os.ReadFile(f.opts.Paths.TicketFile)
	var tf TicketFile
	json.Unmarshal(raw, &tf)
	tf.ExpiresAt = time.Now().Add(-time.Minute).UTC().Format(time.RFC3339)
	b, _ := json.Marshal(tf)
	os.WriteFile(f.opts.Paths.TicketFile, b, 0o640)
	if _, err := Register(context.Background(), f.opts); !errors.Is(err, ErrWaitingForTicket) {
		t.Fatalf("expired ticket used: %v", err)
	}
	// a world-readable ticket is refused too
	tf.ExpiresAt = time.Now().Add(48 * time.Hour).UTC().Format(time.RFC3339)
	b, _ = json.Marshal(tf)
	os.WriteFile(f.opts.Paths.TicketFile, b, 0o644)
	os.Chmod(f.opts.Paths.TicketFile, 0o644)
	if _, err := Register(context.Background(), f.opts); !errors.Is(err, ErrWaitingForTicket) {
		t.Fatalf("world-readable ticket used: %v", err)
	}
}

func TestRunOnceUploadsASignedPseudonymousReport(t *testing.T) {
	f := newFixture(t, 5)
	Redeem(context.Background(), f.opts)
	c := f.cycle()
	r, err := c.RunOnce(context.Background())
	if err != nil {
		t.Fatalf("%v\n%s", err, f.logs)
	}
	if r.Interval != MinInterval {
		t.Fatalf("org interval of 60 s not clamped to the floor: %v", r.Interval)
	}
	f.gw.Lock()
	defer f.gw.Unlock()
	if len(f.gw.Reports) != 1 {
		t.Fatalf("reports: %d", len(f.gw.Reports))
	}
	rep := f.gw.Reports[0]
	body := string(f.gw.ReportBodies[0])
	if rep.ManifestVersion != "1.0.0" || rep.KeyProtection != contract.KeySoftware || len(rep.Facts) != 2 {
		t.Fatalf("report: %s", body)
	}
	for _, forbidden := range []string{"jdoe", "/home/", strings.Repeat("Z", 12), bulkToken()} {
		if strings.Contains(body, forbidden) {
			t.Fatalf("report carries %q: %s", forbidden, body)
		}
	}
	// the nonce challenge was answered: the first token request had no nonce, the retry had the gateway's
	var tokenCalls int
	for _, q := range f.gw.Requests {
		if q.Path == contract.RouteToken {
			tokenCalls++
		}
	}
	if tokenCalls != 2 {
		t.Fatalf("token calls: %d", tokenCalls)
	}
}

func TestRunOnceRefusesAnUntrustedPack(t *testing.T) {
	f := newFixture(t, 5)
	Redeem(context.Background(), f.opts)
	c := f.cycle()
	c.Keyring = packtest.NewSigner().Keyring() // a different pinned key
	if _, err := c.RunOnce(context.Background()); err == nil || !strings.Contains(err.Error(), "does not verify") {
		t.Fatalf("untrusted pack accepted: %v", err)
	}
	f.gw.Lock()
	defer f.gw.Unlock()
	if len(f.gw.Reports) != 0 {
		t.Fatal("a report was sent without a trusted manifest")
	}
}

func TestRunOnceRefusesADowngrade(t *testing.T) {
	f := newFixture(t, 5)
	Redeem(context.Background(), f.opts)
	c := f.cycle()
	if _, err := c.RunOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	f.gw.Lock()
	f.gw.Config.Pack = f.signer.Pack("0.9.0", []byte(collection))
	f.gw.Unlock()
	if _, err := c.RunOnce(context.Background()); err == nil || !strings.Contains(err.Error(), "downgrade") {
		t.Fatalf("downgrade accepted: %v", err)
	}
}

func TestPseudonymityGuardStopsTheUpload(t *testing.T) {
	f := newFixture(t, 5)
	Redeem(context.Background(), f.opts)
	c := f.cycle()
	// a user whose name is also a catalogue token: the guard refuses rather than risk naming them
	c.Identity.UserName = "example"
	if _, err := c.RunOnce(context.Background()); !errors.Is(err, privacy.ErrIdentifying) {
		t.Fatalf("guard did not stop the upload: %v", err)
	}
	f.gw.Lock()
	defer f.gw.Unlock()
	if len(f.gw.Reports) != 0 {
		t.Fatal("report sent")
	}
}

func TestRotation(t *testing.T) {
	f := newFixture(t, 5)
	Redeem(context.Background(), f.opts)
	c := f.cycle()
	f.gw.Lock()
	f.gw.RotateAfter = time.Now().Add(-time.Minute).Unix()
	f.gw.Unlock()
	r, err := c.RunOnce(context.Background())
	if err != nil || !r.Rotated {
		t.Fatalf("not rotated: %v %+v\n%s", err, r, f.logs)
	}
	s, _ := loadState(f.opts)
	if s.PendingKeyID != "" {
		t.Fatalf("pending key left: %+v", s)
	}
	// the next cycle authenticates with the new key
	if _, err := c.RunOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	f.gw.Lock()
	defer f.gw.Unlock()
	if len(f.gw.Reports) != 2 {
		t.Fatalf("reports: %d", len(f.gw.Reports))
	}
}

func TestDroppedSnapshotsAreCounted(t *testing.T) {
	f := newFixture(t, 5)
	Redeem(context.Background(), f.opts)
	c := f.cycle()
	if _, err := c.RunOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	// the gateway now fails reports with 503: the snapshot is lost and counted
	failing := c.HTTP
	c.HTTP = func(issuer string, ca []byte) (*http.Client, error) {
		cl, err := failing(issuer, ca)
		if err != nil {
			return nil, err
		}
		cl.Transport = failReports{cl.Transport}
		return cl, nil
	}
	if _, err := c.RunOnce(context.Background()); err == nil {
		t.Fatal("no error")
	}
	c.HTTP = failing
	if _, err := c.RunOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	f.gw.Lock()
	defer f.gw.Unlock()
	if got := f.gw.Reports[len(f.gw.Reports)-1].DroppedSnapshots; got != 1 {
		t.Fatalf("dropped snapshots: %d", got)
	}
}

type failReports struct{ next http.RoundTripper }

func (f failReports) RoundTrip(r *http.Request) (*http.Response, error) {
	if r.URL.Path == contract.RouteReports {
		return &http.Response{StatusCode: 503, Body: io.NopCloser(strings.NewReader(`{"error":"unavailable"}`)), Header: http.Header{}, Request: r}, nil
	}
	return f.next.RoundTrip(r)
}

// The rotation's answer is lost after the gateway switched keys: the old key is refused, and the next cycle
// recovers by trying the pending key.
func TestRotationLostAnswer(t *testing.T) {
	f := newFixture(t, 5)
	Redeem(context.Background(), f.opts)
	c := f.cycle()
	f.gw.Lock()
	f.gw.RotateAfter = time.Now().Add(-time.Minute).Unix()
	f.gw.Unlock()
	working := c.HTTP
	c.HTTP = func(issuer string, ca []byte) (*http.Client, error) {
		cl, err := working(issuer, ca)
		if err != nil {
			return nil, err
		}
		cl.Transport = loseRotationAnswer{cl.Transport}
		return cl, nil
	}
	r, err := c.RunOnce(context.Background())
	if err != nil || r.Rotated {
		t.Fatalf("%v %+v", err, r)
	}
	s, _ := loadState(f.opts)
	if s.PendingKeyID == "" {
		t.Fatal("no pending key recorded")
	}
	c.HTTP = working
	if _, err := c.RunOnce(context.Background()); err != nil {
		t.Fatalf("not recovered: %v\n%s", err, f.logs)
	}
	s, _ = loadState(f.opts)
	if s.PendingKeyID != "" || !strings.Contains(f.logs.String(), "lost answer") {
		t.Fatalf("state after recovery: %+v", s)
	}
}

type loseRotationAnswer struct{ next http.RoundTripper }

func (l loseRotationAnswer) RoundTrip(r *http.Request) (*http.Response, error) {
	res, err := l.next.RoundTrip(r)
	if err == nil && r.URL.Path == contract.RouteCredentials {
		res.Body.Close()
		return nil, errors.New("connection reset after the gateway answered")
	}
	return res, err
}

// A kind turned off in the machine's config is reported as turned off locally, even when the org also turned it
// off; a kind only the org turned off says so.
func TestLocalDisabledKindsNarrowCollection(t *testing.T) {
	f := newFixture(t, 5)
	cfg := fmt.Sprintf(`{"schema":"regulait.endpoint-agent-config/1","issuer":%q,"caBundleFile":%q,"disabledKinds":["env_name"]}`,
		f.gw.Issuer, filepath.Join(f.dir, "sys", "ca.pem"))
	if err := os.WriteFile(f.opts.Paths.ConfigFile, []byte(cfg), 0o644); err != nil {
		t.Fatal(err)
	}
	f.gw.Lock()
	f.gw.Config.OrgPolicy.DisabledKinds = []contract.Kind{contract.KindEnvName, contract.KindAssistantConfig}
	f.gw.Unlock()
	Redeem(context.Background(), f.opts)
	r, err := f.cycle().RunOnce(context.Background())
	if err != nil {
		t.Fatalf("%v\n%s", err, f.logs)
	}
	reasons := map[contract.Kind]string{}
	for _, g := range r.Report.Gaps {
		reasons[g.Kind] = g.Reason
	}
	if reasons[contract.KindEnvName] != collect.GapDisabledByLocalPolicy || reasons[contract.KindAssistantConfig] != collect.GapDisabledByOrgPolicy {
		t.Fatalf("gaps: %+v", r.Report.Gaps)
	}
	if len(r.Report.Facts) != 0 {
		t.Fatalf("a turned-off kind was collected: %+v", r.Report.Facts)
	}
}

// A system file owned by another uid is an unsafe file, and a bulk token file so owned is never used.
func TestFileOwnedByAnotherUIDIsUnsafe(t *testing.T) {
	if os.Getuid() != 0 {
		t.Skip("needs root to give a file to another uid")
	}
	f := newFixture(t, 5)
	if err := os.Chown(f.opts.Paths.EnrolFile, 4242, -1); err != nil {
		t.Fatal(err)
	}
	if _, err := readChecked(f.opts.Paths.EnrolFile, 0, OwnerOnly); !errors.Is(err, ErrUnsafeFile) || !strings.Contains(err.Error(), "owned by uid 4242") {
		t.Fatalf("another uid's file: %v", err)
	}
	if st := Redeem(context.Background(), f.opts); st.Outcome != OutcomeTokenFileUnsafe {
		t.Fatalf("%+v", st)
	}
	f.gw.Lock()
	defer f.gw.Unlock()
	if len(f.gw.Requests) != 0 {
		t.Fatal("a token owned by another uid was sent")
	}
}

// A symlink where a file is expected (ELOOP under O_NOFOLLOW) is an unsafe file: token_file_unsafe, nothing sent.
func TestSymlinkIsAnUnsafeFile(t *testing.T) {
	f := newFixture(t, 5)
	real := filepath.Join(f.dir, "elsewhere.json")
	if err := os.Rename(f.opts.Paths.EnrolFile, real); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(real, f.opts.Paths.EnrolFile); err != nil {
		t.Fatal(err)
	}
	if _, err := readChecked(f.opts.Paths.EnrolFile, os.Getuid(), OwnerOnly); !errors.Is(err, ErrUnsafeFile) {
		t.Fatalf("symlink: %v", err)
	}
	if st := Redeem(context.Background(), f.opts); st.Outcome != OutcomeTokenFileUnsafe {
		t.Fatalf("%+v", st)
	}
	f.gw.Lock()
	defer f.gw.Unlock()
	if len(f.gw.Requests) != 0 {
		t.Fatal("a token behind a symlink was sent")
	}
}

// Neither the bulk token nor the device ticket appears in anything the agent logs or returns as an error, on the
// happy path or on any of the refusals below.
func TestSecretsNeverReachLogsOrErrors(t *testing.T) {
	f := newFixture(t, 5)
	var errs []string
	note := func(err error) {
		if err != nil {
			errs = append(errs, err.Error())
		}
	}
	st := Redeem(context.Background(), f.opts)
	if st.Outcome != OutcomeRedeemed {
		t.Fatalf("%+v", st)
	}
	raw, err := os.ReadFile(f.opts.Paths.TicketFile)
	if err != nil {
		t.Fatal(err)
	}
	var tf TicketFile
	if err := json.Unmarshal(raw, &tf); err != nil || !validSecret(tf.Ticket) {
		t.Fatalf("ticket file: %v", err)
	}
	c := f.cycle()
	_, err = c.RunOnce(context.Background())
	note(err)
	// refusals: an untrusted pack, a failing report route, a gateway that no longer knows the ticket, a refused token
	c.Keyring = packtest.NewSigner().Keyring()
	_, err = c.RunOnce(context.Background())
	note(err)
	c.Keyring = f.signer.Keyring()
	working := c.HTTP
	c.HTTP = func(issuer string, ca []byte) (*http.Client, error) {
		cl, err := working(issuer, ca)
		if err != nil {
			return nil, err
		}
		cl.Transport = failReports{cl.Transport}
		return cl, nil
	}
	_, err = c.RunOnce(context.Background())
	note(err)
	c.HTTP = working
	f.gw.Lock()
	f.gw.Tickets = map[string]time.Time{}
	f.gw.Unlock()
	os.RemoveAll(f.opts.Paths.StateDir)
	_, err = Register(context.Background(), f.opts)
	note(err)
	os.Remove(f.opts.Paths.TicketFile)
	f.gw.Lock()
	f.gw.TokenExpired = true
	f.gw.Unlock()
	st2 := Redeem(context.Background(), f.opts)
	if len(errs) < 3 || st2.Outcome != OutcomeRefused {
		t.Fatalf("the refusals did not fail: %q %+v", errs, st2)
	}
	everything := f.logs.String() + "\n" + strings.Join(errs, "\n") + "\n" + fmt.Sprintf("%+v %+v", st, st2)
	for name, secret := range map[string]string{"bulk token": bulkToken(), "ticket": tf.Ticket} {
		if strings.Contains(everything, secret) {
			t.Errorf("the %s appears in logs or errors:\n%s", name, everything)
		}
	}
}
