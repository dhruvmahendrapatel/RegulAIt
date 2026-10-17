package auth

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"testing"

	"github.com/go-jose/go-jose/v4"

	"github.com/dhruvmahendrapatel/regulait/agents/endpoint/internal/contract"
)

func parse(t *testing.T, compact string) (jose.Header, map[string]any, *jose.JSONWebSignature) {
	t.Helper()
	obj, err := jose.ParseSigned(compact, []jose.SignatureAlgorithm{jose.ES256})
	if err != nil {
		t.Fatal(err)
	}
	var claims map[string]any
	json.Unmarshal(obj.UnsafePayloadWithoutVerification(), &claims)
	return obj.Signatures[0].Protected, claims, obj
}

func TestDPoPProof(t *testing.T) {
	k, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	p, err := DPoPProof(k, "POST", "https://gw.example.invalid/v1/endpoint-agent/reports", "n-1", "the-token")
	if err != nil {
		t.Fatal(err)
	}
	h, claims, obj := parse(t, p)
	if h.ExtraHeaders["typ"] != contract.TypDPoP || h.JSONWebKey == nil || !h.JSONWebKey.IsPublic() || h.KeyID != "" {
		t.Fatalf("header %+v", h)
	}
	if _, err := obj.Verify(h.JSONWebKey); err != nil {
		t.Fatal(err)
	}
	ath := sha256.Sum256([]byte("the-token"))
	if claims["htm"] != "POST" || claims["nonce"] != "n-1" || claims["ath"] != base64.RawURLEncoding.EncodeToString(ath[:]) || claims["jti"] == "" {
		t.Fatalf("claims %+v", claims)
	}
	// the token request's proof has no ath, and two proofs never share a jti
	p2, _ := DPoPProof(k, "POST", "https://gw.example.invalid/oauth/token", "", "")
	_, c2, _ := parse(t, p2)
	if _, ok := c2["ath"]; ok || c2["jti"] == claims["jti"] {
		t.Fatalf("claims %+v", c2)
	}
}

func TestClientAssertionAndClientID(t *testing.T) {
	k, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	id, _ := ClientID(&k.PublicKey)
	a, err := ClientAssertion(k, id, "https://gw.example.invalid/oauth/token")
	if err != nil {
		t.Fatal(err)
	}
	h, claims, obj := parse(t, a)
	tp, _ := Thumbprint(&k.PublicKey)
	if h.KeyID != tp || h.JSONWebKey != nil || id != contract.JWKThumbprintURIPrefix+tp {
		t.Fatalf("header %+v id %s", h, id)
	}
	if _, err := obj.Verify(&k.PublicKey); err != nil {
		t.Fatal(err)
	}
	if claims["iss"] != id || claims["sub"] != id || claims["aud"] != "https://gw.example.invalid/oauth/token" || claims["exp"].(float64)-claims["iat"].(float64) != 60 {
		t.Fatalf("claims %+v", claims)
	}
}

func TestReportSignatureAndContentDigest(t *testing.T) {
	// RFC 9530 shape: sha-256=:<standard base64>:
	if got := ContentDigest([]byte(`{"hello": "world"}`)); got != "sha-256=:X48E9qOokqqrvdts8nOJRJN3OWDUoyWxBf7kbu9DBPE=:" {
		t.Fatalf("content digest %s", got)
	}
	k, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	s, err := ReportSignature(k, "cid", "https://gw.example.invalid/v1/endpoint-agent/reports", "snap-1", "sha-256=:x:")
	if err != nil {
		t.Fatal(err)
	}
	h, claims, obj := parse(t, s)
	if h.ExtraHeaders["typ"] != contract.TypReportSignature || claims["contentDigest"] != "sha-256=:x:" || claims["snapshotId"] != "snap-1" {
		t.Fatalf("%+v %+v", h, claims)
	}
	if _, err := obj.Verify(&k.PublicKey); err != nil {
		t.Fatal(err)
	}
}

func TestPublicJWKHasNoPrivateMember(t *testing.T) {
	k, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	m, err := PublicJWK(k.Public())
	if err != nil || m["kty"] != "EC" || m["crv"] != "P-256" {
		t.Fatalf("%v %v", m, err)
	}
	if _, ok := m["d"]; ok {
		t.Fatal("private member present")
	}
	k384, _ := ecdsa.GenerateKey(elliptic.P384(), rand.Reader)
	if _, err := PublicJWK(k384.Public()); err == nil {
		t.Fatal("P-384 accepted")
	}
}
