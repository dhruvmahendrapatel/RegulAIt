// Package gatewaytest is a fake gateway for the agent's tests. It implements the SD4a contract strictly enough to
// prove what the agent sends: it verifies every client assertion, DPoP proof and report signature, requires a DPoP
// nonce, and counts the bulk token's device cap. It is a test double, not the SD4b implementation, but SD4b must
// accept everything it accepts and refuse everything it refuses.
package gatewaytest

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"time"

	"github.com/go-jose/go-jose/v4"

	"github.com/dhruvmahendrapatel/regulait/agents/endpoint/internal/contract"
)

// Gateway is the fake. Fields are read and written under mu by the tests.
type Gateway struct {
	Server *httptest.Server
	Issuer string

	mu           sync.Mutex
	BulkToken    string
	Cap          int
	Devices      int
	TokenExpired bool
	Tickets      map[string]time.Time // ticket -> expiry
	Registered   map[string]*ecdsa.PublicKey
	Requests     []Request
	Reports      []contract.Report
	ReportBodies [][]byte
	Config       contract.ConfigResponse
	Nonce        string
	usedJTI      map[string]bool
	tokens       map[string]string // access token -> client id
	RotateAfter  int64
	Revoked      bool
}

// Request is what one call carried, for assertions.
type Request struct {
	Method, Path string
	Header       http.Header
	Body         []byte
}

// New starts the fake with a bulk token value made at run time.
func New(bulkToken string, cap int) *Gateway {
	g := &Gateway{BulkToken: bulkToken, Cap: cap, Tickets: map[string]time.Time{}, Registered: map[string]*ecdsa.PublicKey{},
		usedJTI: map[string]bool{}, tokens: map[string]string{}, Nonce: "nonce-1"}
	g.Server = httptest.NewTLSServer(http.HandlerFunc(g.serve))
	g.Issuer = g.Server.URL
	return g
}

// Close stops the server.
func (g *Gateway) Close() { g.Server.Close() }

// Lock and Unlock give tests access to the fields.
func (g *Gateway) Lock()   { g.mu.Lock() }
func (g *Gateway) Unlock() { g.mu.Unlock() }

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func refuse(w http.ResponseWriter, status int, code string) {
	writeJSON(w, status, contract.ErrorBody{Error: code})
}

func (g *Gateway) serve(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(io.LimitReader(r.Body, 2<<20))
	r.Body = io.NopCloser(bytes.NewReader(body))
	g.mu.Lock()
	defer g.mu.Unlock()
	g.Requests = append(g.Requests, Request{Method: r.Method, Path: r.URL.Path, Header: r.Header.Clone(), Body: body})
	w.Header().Set("DPoP-Nonce", g.Nonce)
	switch {
	case r.Method == http.MethodPost && r.URL.Path == contract.RouteEnrolmentTickets:
		g.tickets(w, r, body)
	case r.Method == http.MethodPost && r.URL.Path == contract.RouteRegister:
		g.register(w, r, body)
	case r.Method == http.MethodPost && r.URL.Path == contract.RouteToken:
		g.token(w, r)
	case r.Method == http.MethodGet && r.URL.Path == contract.RouteConfig:
		if _, ok := g.authorized(w, r); ok {
			writeJSON(w, http.StatusOK, g.Config)
		}
	case r.Method == http.MethodPost && r.URL.Path == contract.RouteReports:
		g.report(w, r, body)
	case r.Method == http.MethodPost && r.URL.Path == contract.RouteCredentials:
		g.rotate(w, r, body)
	default:
		refuse(w, http.StatusNotFound, "not_found")
	}
}

func bearer(r *http.Request) string {
	a := r.Header.Get("Authorization")
	if !strings.HasPrefix(a, "Bearer ") {
		return ""
	}
	return strings.TrimPrefix(a, "Bearer ")
}

func (g *Gateway) tickets(w http.ResponseWriter, r *http.Request, body []byte) {
	if bearer(r) != g.BulkToken {
		refuse(w, http.StatusUnauthorized, "invalid_token")
		return
	}
	if g.TokenExpired {
		refuse(w, http.StatusGone, contract.ErrTokenExpired)
		return
	}
	var req contract.TicketRequest
	if err := strictJSON(body, &req); err != nil || req.Hostname == "" || req.OS == "" {
		refuse(w, http.StatusBadRequest, "invalid_body")
		return
	}
	if g.Devices >= g.Cap {
		refuse(w, http.StatusConflict, contract.ErrEnrolmentCapReached)
		return
	}
	g.Devices++
	t := fmt.Sprintf("ticket-%d-%s", g.Devices, randomish())
	exp := time.Now().Add(7 * 24 * time.Hour).UTC()
	g.Tickets[t] = exp
	writeJSON(w, http.StatusCreated, contract.TicketResponse{Ticket: t, TicketID: fmt.Sprintf("tkt_%d", g.Devices), ExpiresAt: exp.Format(time.RFC3339), IdentityCap: 8})
}

func (g *Gateway) register(w http.ResponseWriter, r *http.Request, body []byte) {
	exp, ok := g.Tickets[bearer(r)]
	if !ok {
		refuse(w, http.StatusUnauthorized, "invalid_ticket")
		return
	}
	if time.Now().After(exp) {
		refuse(w, http.StatusGone, contract.ErrTicketExpired)
		return
	}
	var req contract.RegisterRequest
	if err := strictJSON(body, &req); err != nil {
		refuse(w, http.StatusBadRequest, "invalid_body")
		return
	}
	raw, _ := json.Marshal(req.PublicJWK)
	var jwk jose.JSONWebKey
	if err := jwk.UnmarshalJSON(raw); err != nil || !jwk.IsPublic() {
		refuse(w, http.StatusBadRequest, "invalid_jwk")
		return
	}
	pub, ok := jwk.Key.(*ecdsa.PublicKey)
	if !ok || pub.Curve.Params().Name != "P-256" {
		refuse(w, http.StatusBadRequest, "invalid_jwk")
		return
	}
	tp, _ := jwk.Thumbprint(cryptoSHA256)
	id := contract.JWKThumbprintURIPrefix + base64.RawURLEncoding.EncodeToString(tp)
	g.Registered[id] = pub
	writeJSON(w, http.StatusCreated, contract.RegisterResponse{IdentityID: "wid_" + id[len(id)-8:], ClientID: id})
}

// verifyJWS parses compact with ES256 only and verifies it under key (or the embedded jwk when key is nil).
func verifyJWS(compact, typ string, key *ecdsa.PublicKey) (map[string]any, *ecdsa.PublicKey, error) {
	obj, err := jose.ParseSigned(compact, []jose.SignatureAlgorithm{jose.ES256})
	if err != nil {
		return nil, nil, err
	}
	if len(obj.Signatures) != 1 {
		return nil, nil, errors.New("not one signature")
	}
	h := obj.Signatures[0].Protected
	if t, _ := h.ExtraHeaders["typ"].(string); t != typ {
		return nil, nil, fmt.Errorf("typ %q, want %q", t, typ)
	}
	if key == nil {
		if h.JSONWebKey == nil || !h.JSONWebKey.IsPublic() {
			return nil, nil, errors.New("no public jwk header")
		}
		key, _ = h.JSONWebKey.Key.(*ecdsa.PublicKey)
		if key == nil {
			return nil, nil, errors.New("jwk is not EC")
		}
	}
	payload, err := obj.Verify(key)
	if err != nil {
		return nil, nil, err
	}
	var claims map[string]any
	if err := json.Unmarshal(payload, &claims); err != nil {
		return nil, nil, err
	}
	return claims, key, nil
}

func (g *Gateway) once(jti any) bool {
	s, _ := jti.(string)
	if s == "" || g.usedJTI[s] {
		return false
	}
	g.usedJTI[s] = true
	return true
}

// dpop verifies a DPoP proof for this request and returns its key.
func (g *Gateway) dpop(r *http.Request, accessToken string) (*ecdsa.PublicKey, string) {
	claims, key, err := verifyJWS(r.Header.Get("DPoP"), contract.TypDPoP, nil)
	if err != nil {
		return nil, "invalid_dpop_proof"
	}
	if claims["htm"] != r.Method || claims["htu"] != g.Issuer+r.URL.Path || !g.once(claims["jti"]) {
		return nil, "invalid_dpop_proof"
	}
	if claims["nonce"] != g.Nonce {
		return nil, contract.ErrUseDPoPNonce
	}
	if accessToken != "" {
		h := sha256.Sum256([]byte(accessToken))
		if claims["ath"] != base64.RawURLEncoding.EncodeToString(h[:]) {
			return nil, "invalid_dpop_proof"
		}
	}
	return key, ""
}

func (g *Gateway) token(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseForm(); err != nil {
		refuse(w, http.StatusBadRequest, "invalid_request")
		return
	}
	key, code := g.dpop(r, "")
	if code != "" {
		refuse(w, http.StatusBadRequest, code)
		return
	}
	clientID := r.PostForm.Get("client_id")
	reg, ok := g.Registered[clientID]
	if !ok || g.Revoked {
		refuse(w, http.StatusUnauthorized, "invalid_client")
		return
	}
	if !reg.Equal(key) {
		refuse(w, http.StatusBadRequest, "dpop_key_mismatch")
		return
	}
	claims, _, err := verifyJWS(r.PostForm.Get("client_assertion"), "JWT", reg)
	if err != nil || claims["iss"] != clientID || claims["sub"] != clientID || claims["aud"] != g.Issuer+contract.RouteToken || !g.once(claims["jti"]) {
		refuse(w, http.StatusUnauthorized, "invalid_client")
		return
	}
	if r.PostForm.Get("grant_type") != "client_credentials" || r.PostForm.Get("resource") != g.Issuer+contract.ResourcePath {
		refuse(w, http.StatusBadRequest, "invalid_request")
		return
	}
	tok := "at-" + randomish()
	g.tokens[tok] = clientID
	resp := map[string]any{"access_token": tok, "token_type": "DPoP", "expires_in": 300}
	if g.RotateAfter != 0 {
		resp[contract.RotateAfterMember] = g.RotateAfter
	}
	writeJSON(w, http.StatusOK, resp)
}

func (g *Gateway) authorized(w http.ResponseWriter, r *http.Request) (string, bool) {
	a := r.Header.Get("Authorization")
	tok := strings.TrimPrefix(a, "DPoP ")
	clientID, ok := g.tokens[tok]
	if !strings.HasPrefix(a, "DPoP ") || !ok {
		refuse(w, http.StatusUnauthorized, "invalid_token")
		return "", false
	}
	key, code := g.dpop(r, tok)
	if code == contract.ErrUseDPoPNonce {
		w.Header().Set("WWW-Authenticate", `DPoP error="use_dpop_nonce"`)
		refuse(w, http.StatusUnauthorized, code)
		return "", false
	}
	if code != "" || !g.Registered[clientID].Equal(key) {
		refuse(w, http.StatusUnauthorized, "invalid_dpop_proof")
		return "", false
	}
	return clientID, true
}

func (g *Gateway) report(w http.ResponseWriter, r *http.Request, body []byte) {
	clientID, ok := g.authorized(w, r)
	if !ok {
		return
	}
	d := sha256.Sum256(body)
	digest := "sha-256=:" + base64.StdEncoding.EncodeToString(d[:]) + ":"
	if r.Header.Get(contract.HeaderContentDigest) != digest {
		refuse(w, http.StatusBadRequest, "content_digest_mismatch")
		return
	}
	claims, _, err := verifyJWS(r.Header.Get(contract.HeaderReportSignature), contract.TypReportSignature, g.Registered[clientID])
	if err != nil || claims["contentDigest"] != digest || claims["aud"] != g.Issuer+contract.RouteReports || claims["iss"] != clientID || !g.once(claims["jti"]) {
		refuse(w, http.StatusBadRequest, "invalid_report_signature")
		return
	}
	var rep contract.Report
	if err := strictJSON(body, &rep); err != nil || rep.Schema != contract.SchemaReport || claims["snapshotId"] != rep.SnapshotID {
		refuse(w, http.StatusBadRequest, "invalid_body")
		return
	}
	for _, prev := range g.Reports {
		if prev.SnapshotID == rep.SnapshotID {
			writeJSON(w, http.StatusAccepted, contract.ReportResponse{Accepted: true, Duplicate: true})
			return
		}
	}
	g.Reports = append(g.Reports, rep)
	g.ReportBodies = append(g.ReportBodies, body)
	writeJSON(w, http.StatusAccepted, contract.ReportResponse{Accepted: true})
}

func (g *Gateway) rotate(w http.ResponseWriter, r *http.Request, body []byte) {
	current, ok := g.authorized(w, r)
	if !ok {
		return
	}
	var req contract.RotateRequest
	if err := strictJSON(body, &req); err != nil {
		refuse(w, http.StatusBadRequest, "invalid_body")
		return
	}
	claims, key, err := verifyJWS(req.Proof, contract.TypKeyRotation, nil)
	if err != nil || claims["aud"] != g.Issuer+contract.RouteCredentials {
		refuse(w, http.StatusBadRequest, "invalid_rotation_proof")
		return
	}
	raw, _ := json.Marshal(req.PublicJWK)
	var jwk jose.JSONWebKey
	if jwk.UnmarshalJSON(raw) != nil || !key.Equal(jwk.Key) {
		refuse(w, http.StatusBadRequest, "invalid_rotation_proof")
		return
	}
	tp, _ := jwk.Thumbprint(cryptoSHA256)
	id := contract.JWKThumbprintURIPrefix + base64.RawURLEncoding.EncodeToString(tp)
	// the old key mints nothing after a rotation (ADR-0188 S7 point 4)
	delete(g.Registered, current)
	g.Registered[id] = key
	g.RotateAfter = 0
	writeJSON(w, http.StatusCreated, contract.RegisterResponse{IdentityID: "wid_rotated", ClientID: id})
}
