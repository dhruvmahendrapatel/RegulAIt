// Package transport is the agent's only HTTP client (R15 §3.3): HTTPS to the configured issuer and nothing else,
// TLS 1.3 minimum, the OS trust store or, when a CA bundle is configured, only that bundle (private PKI and
// air-gapped installs), the OS proxy settings honoured, and redirects never followed, so a response cannot send
// the agent anywhere else.
package transport

import (
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// ParseIssuer normalises the gateway's issuer URL: https only, no user info, query or fragment, the host
// lowercased, the default port and trailing slashes dropped. It mirrors the gateway's parsePublicUrl except that
// plain http is never accepted, not even on loopback.
func ParseIssuer(raw string) (string, error) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return "", fmt.Errorf("the issuer is not a URL: %w", err)
	}
	if u.Scheme != "https" {
		return "", errors.New("the issuer must be an https URL")
	}
	if u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Opaque != "" {
		return "", errors.New("the issuer may not carry user info, a query or a fragment")
	}
	host := strings.ToLower(u.Hostname())
	if host == "" {
		return "", errors.New("the issuer has no host")
	}
	port := u.Port()
	if port == "443" {
		port = ""
	}
	h := host
	if strings.Contains(host, ":") {
		h = "[" + host + "]"
	}
	if port != "" {
		h += ":" + port
	}
	return "https://" + h + strings.TrimRight(u.EscapedPath(), "/"), nil
}

// New returns a client that reaches only issuer. caPEM, when non-empty, replaces the OS trust store.
func New(issuer string, caPEM []byte) (*http.Client, error) {
	if _, err := ParseIssuer(issuer); err != nil {
		return nil, err
	}
	tlsConf := &tls.Config{MinVersion: tls.VersionTLS13}
	if len(caPEM) > 0 {
		pool := x509.NewCertPool()
		if !pool.AppendCertsFromPEM(caPEM) {
			return nil, errors.New("the CA bundle holds no PEM certificate")
		}
		tlsConf.RootCAs = pool
	}
	base := &http.Transport{
		Proxy:                 http.ProxyFromEnvironment,
		DialContext:           (&net.Dialer{Timeout: 15 * time.Second}).DialContext,
		TLSClientConfig:       tlsConf,
		TLSHandshakeTimeout:   15 * time.Second,
		ResponseHeaderTimeout: 30 * time.Second,
		ForceAttemptHTTP2:     true,
		MaxIdleConns:          2,
		IdleConnTimeout:       60 * time.Second,
	}
	return &http.Client{
		Transport:     onlyIssuer{issuer: issuer, next: base},
		Timeout:       60 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}, nil
}

// onlyIssuer refuses any request that is not under the issuer, before it is dialled.
type onlyIssuer struct {
	issuer string
	next   http.RoundTripper
}

// ErrNotIssuer is a request the agent would have sent somewhere other than its gateway.
var ErrNotIssuer = errors.New("the agent sends nothing outside its gateway")

func (o onlyIssuer) RoundTrip(r *http.Request) (*http.Response, error) {
	u := *r.URL
	u.RawQuery, u.Fragment = "", ""
	s := u.String()
	if s != o.issuer && !strings.HasPrefix(s, o.issuer+"/") {
		return nil, ErrNotIssuer
	}
	return o.next.RoundTrip(r)
}
