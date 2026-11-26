// ADR-0364 S3 §7 — THE FRONT FILTER (owner, D-2026-11-22-07: defence in depth). The run's sandbox reaches this
// listener, never Smokescreen: it accepts only a CONNECT whose authority is exactly one of the run's targets (the same
// ports file as the in-Smokescreen hook), and only then hands the connection to Smokescreen on a loopback listener in
// the same process. Smokescreen then applies its own ACL, its IP checks and the PostDecisionRequestHandler (portfilter.go)
// as the second layer, so a destination must pass two independent parsers before a byte leaves the proxy.
//
// Built on the Go standard library (net/http, net) only; the comparison with goproxy, tinyproxy and Envoy is in
// engines/robot-egress/README.md ("Front filter").
//
// The upstream request is re-written, not relayed: Smokescreen receives `CONNECT <target> HTTP/1.1` with a Host header
// equal to the target and no other header, so it judges exactly the authority this filter allowed.
package main

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/sirupsen/logrus"
)

// FrontRefusedHeader marks a refusal made here (Smokescreen's own refusals carry no such header and answer 407)
const FrontRefusedHeader = "X-Regulait-Egress-Front"

const (
	frontHeaderTimeout = 10 * time.Second
	frontDialTimeout   = 5 * time.Second
	frontMaxHeader     = 8 * 1024
)

// Front is the CONNECT filter in front of Smokescreen
type Front struct {
	filter   *PortFilter
	upstream string // Smokescreen's loopback address, host:port
	dial     func(ctx context.Context, network, addr string) (net.Conn, error)
	log      *logrus.Entry
}

// NewFront returns a front filter that admits the filter's targets and chains them to upstream
// NewFront returns a front filter that admits the filter's targets and chains them to upstream, logging each refusal
// as one JSON line (`regulait front filter`, the refused target and the reason) through log
func NewFront(filter *PortFilter, upstream string, log *logrus.Entry) *Front {
	d := &net.Dialer{Timeout: frontDialTimeout}
	return &Front{filter: filter, upstream: upstream, dial: d.DialContext, log: log}
}

// frontTarget parses a CONNECT authority strictly: `host:port`, a DNS name (validHost after lower-casing and dropping
// one trailing dot) and a canonical decimal port. Anything else (an IP literal, brackets, userinfo, a path, spaces, an
// empty port) is refused. It returns the canonical key the ports file uses.
func frontTarget(authority string) (string, bool) {
	i := strings.LastIndexByte(authority, ':')
	if i <= 0 {
		return "", false
	}
	host := strings.TrimSuffix(strings.ToLower(authority[:i]), ".")
	port := authority[i+1:]
	if !validHost(host) {
		return "", false
	}
	n, err := strconv.Atoi(port)
	if err != nil || n < 1 || n > 65535 || strconv.Itoa(n) != port {
		return "", false
	}
	return host + ":" + port, true
}

func (f *Front) refuse(w http.ResponseWriter, r *http.Request, status int, why string) {
	f.log.WithFields(logrus.Fields{"method": r.Method, "target": r.RequestURI, "status": status}).Warn("regulait front filter: " + why)
	w.Header().Set(FrontRefusedHeader, "refused")
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("Connection", "close")
	w.WriteHeader(status)
	_, _ = io.WriteString(w, "regulait egress front: "+why+"\n")
}

// ServeHTTP admits only a CONNECT to one of the run's targets; every refusal is 403 with FrontRefusedHeader
func (f *Front) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodConnect {
		f.refuse(w, r, http.StatusForbidden, "only CONNECT is allowed")
		return
	}
	// for a CONNECT, net/http sets Host from the request-target; both must agree (no Host-header smuggling)
	if r.RequestURI != r.Host {
		f.refuse(w, r, http.StatusForbidden, "the CONNECT target and Host differ")
		return
	}
	key, ok := frontTarget(r.RequestURI)
	if !ok {
		f.refuse(w, r, http.StatusForbidden, "the CONNECT target is not host:port")
		return
	}
	if _, ok := f.filter.allowed[key]; !ok {
		f.refuse(w, r, http.StatusForbidden, key+" is not one of the run's targets")
		return
	}
	hj, ok := w.(http.Hijacker)
	if !ok {
		f.refuse(w, r, http.StatusInternalServerError, "the connection cannot be handed on")
		return
	}
	// not r.Context(): net/http cancels it when the client half-closes, and the tunnel must still open
	ctx, cancel := context.WithTimeout(context.Background(), frontDialTimeout)
	up, err := f.dial(ctx, "tcp", f.upstream)
	cancel()
	if err != nil {
		// fail closed: without Smokescreen there is no path out
		f.refuse(w, r, http.StatusBadGateway, "the proxy is not available")
		return
	}
	client, buf, err := hj.Hijack()
	if err != nil {
		up.Close()
		return
	}
	if _, err := fmt.Fprintf(up, "CONNECT %s HTTP/1.1\r\nHost: %s\r\n\r\n", key, key); err != nil {
		up.Close()
		client.Close()
		return
	}
	pipe(client, buf.Reader, up)
}

// pipe copies both ways. Bytes the client sent after its request (already buffered) go first. When the client
// half-closes, the upstream's write side is closed too and its answer still flows back; when the upstream ends, both
// connections close.
func pipe(client net.Conn, buffered *bufio.Reader, up net.Conn) {
	var once sync.Once
	closeBoth := func() { client.Close(); up.Close() }
	done := make(chan struct{})
	go func() {
		_, _ = io.Copy(up, buffered) // buffered reads through to client once its buffer is drained
		if cw, ok := up.(interface{ CloseWrite() error }); ok {
			_ = cw.CloseWrite()
		} else {
			once.Do(closeBoth)
		}
		close(done)
	}()
	_, _ = io.Copy(client, up)
	once.Do(closeBoth)
	<-done
}

// Serve runs the front filter on ln until it fails
func (f *Front) Serve(ln net.Listener) error {
	srv := &http.Server{
		Handler:           f,
		ReadHeaderTimeout: frontHeaderTimeout,
		MaxHeaderBytes:    frontMaxHeader,
		ErrorLog:          nil,
	}
	err := srv.Serve(ln)
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}
