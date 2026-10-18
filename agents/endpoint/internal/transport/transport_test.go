package transport

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"math/big"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestParseIssuer(t *testing.T) {
	ok := map[string]string{
		"https://GW.Example.invalid/":      "https://gw.example.invalid",
		"https://gw.example.invalid:443":   "https://gw.example.invalid",
		"https://gw.example.invalid:8443/": "https://gw.example.invalid:8443",
		"https://gw.example.invalid/base/": "https://gw.example.invalid/base",
	}
	for in, want := range ok {
		if got, err := ParseIssuer(in); err != nil || got != want {
			t.Errorf("%s: %q %v", in, got, err)
		}
	}
	for _, bad := range []string{"http://gw.example.invalid", "http://127.0.0.1:3000", "https://u:p@gw.example.invalid", "https://gw.example.invalid/?a=1", "gw.example.invalid", "https://"} {
		if _, err := ParseIssuer(bad); err == nil {
			t.Errorf("%s accepted", bad)
		}
	}
}

func TestOnlyIssuerAndNoRedirects(t *testing.T) {
	other := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { t.Error("the other host was reached") }))
	defer other.Close()
	gw := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, other.URL+"/steal", http.StatusFound)
	}))
	defer gw.Close()
	ca := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: gw.Certificate().Raw})
	issuer, _ := ParseIssuer(gw.URL)
	c, err := New(issuer, ca)
	if err != nil {
		t.Fatal(err)
	}
	res, err := c.Get(issuer + "/v1/endpoint-agent/config")
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusFound {
		t.Fatalf("redirect followed: %d", res.StatusCode)
	}
	if _, err := c.Get(other.URL + "/x"); !errors.Is(err, ErrNotIssuer) {
		t.Fatalf("request outside the issuer: %v", err)
	}
	// a server the pinned bundle does not cover is refused (httptest servers share one certificate, so the
	// bundle holds an unrelated one made here)
	c2, _ := New(issuer, unrelatedCA(t))
	if _, err := c2.Get(issuer + "/x"); err == nil {
		t.Fatal("unpinned certificate accepted")
	}
}

func TestTLS13Minimum(t *testing.T) {
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	srv.TLS = &tls.Config{MaxVersion: tls.VersionTLS12}
	srv.StartTLS()
	defer srv.Close()
	ca := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: srv.Certificate().Raw})
	issuer, _ := ParseIssuer(srv.URL)
	c, _ := New(issuer, ca)
	if _, err := c.Get(issuer + "/x"); err == nil {
		t.Fatal("TLS 1.2 server accepted")
	}
}

func unrelatedCA(t *testing.T) []byte {
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	tmpl := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "unrelated test CA"}, NotBefore: time.Now().Add(-time.Hour),
		NotAfter: time.Now().Add(time.Hour), IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	return pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
}
