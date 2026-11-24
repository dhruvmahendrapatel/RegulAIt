package main

import (
	"bufio"
	"io"
	"net"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/sirupsen/logrus"
)

// fakeUpstream stands in for Smokescreen: it records the request head it receives, answers 200, then echoes
func fakeUpstream(t *testing.T) (addr string, heads chan string) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	heads = make(chan string, 8)
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				br := bufio.NewReader(c)
				var head strings.Builder
				for {
					line, err := br.ReadString('\n')
					if err != nil {
						return
					}
					head.WriteString(line)
					if line == "\r\n" {
						break
					}
				}
				heads <- head.String()
				_, _ = io.WriteString(c, "HTTP/1.1 200 OK\r\n\r\n")
				_, _ = io.Copy(c, br)
			}(c)
		}
	}()
	return ln.Addr().String(), heads
}

func quiet() *logrus.Entry {
	l := logrus.New()
	l.SetOutput(io.Discard)
	return logrus.NewEntry(l)
}

func startFront(t *testing.T, upstream string) string {
	t.Helper()
	f, err := ParsePorts("portal.example.com:443\nfiles.example.com:8443\n")
	if err != nil {
		t.Fatal(err)
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() { _ = NewFront(f, upstream, quiet()).Serve(ln) }()
	return ln.Addr().String()
}

// send writes a raw request head to the front and returns the connection and the parsed response
func send(t *testing.T, front, raw string) (net.Conn, *bufio.Reader, *http.Response) {
	t.Helper()
	c, err := net.DialTimeout("tcp", front, 2*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.Close() })
	_ = c.SetDeadline(time.Now().Add(5 * time.Second))
	if _, err := io.WriteString(c, raw); err != nil {
		t.Fatal(err)
	}
	br := bufio.NewReader(c)
	resp, err := http.ReadResponse(br, &http.Request{Method: http.MethodConnect})
	if err != nil {
		t.Fatal(err)
	}
	return c, br, resp
}

func TestFrontAdmitsTargetAndRewritesRequest(t *testing.T) {
	up, heads := fakeUpstream(t)
	front := startFront(t, up)
	c, br, resp := send(t, front, "CONNECT PORTAL.example.com.:443 HTTP/1.1\r\nHost: PORTAL.example.com.:443\r\nProxy-Authorization: Basic eDp5\r\nX-Extra: 1\r\n\r\nhello")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("want 200, got %d", resp.StatusCode)
	}
	head := <-heads
	if head != "CONNECT portal.example.com:443 HTTP/1.1\r\nHost: portal.example.com:443\r\n\r\n" {
		t.Fatalf("upstream got %q", head)
	}
	// the bytes sent with the request and after it reach the upstream, and its answer comes back
	if _, err := io.WriteString(c, " world"); err != nil {
		t.Fatal(err)
	}
	got := make([]byte, len("hello world"))
	if _, err := io.ReadFull(br, got); err != nil || string(got) != "hello world" {
		t.Fatalf("tunnel: %q %v", got, err)
	}
}

// a client that half-closes after its request still gets the upstream's answer (Smokescreen's own 407, say)
func TestFrontHalfClose(t *testing.T) {
	up, heads := fakeUpstream(t)
	front := startFront(t, up)
	c, err := net.DialTimeout("tcp", front, 2*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	_ = c.SetDeadline(time.Now().Add(5 * time.Second))
	_, _ = io.WriteString(c, "CONNECT portal.example.com:443 HTTP/1.1\r\nHost: portal.example.com:443\r\n\r\nping")
	_ = c.(*net.TCPConn).CloseWrite()
	<-heads
	b, err := io.ReadAll(c)
	if err != nil || string(b) != "HTTP/1.1 200 OK\r\n\r\nping" {
		t.Fatalf("got %q %v", b, err)
	}
}

func TestFrontRefuses(t *testing.T) {
	up, heads := fakeUpstream(t)
	front := startFront(t, up)
	for _, raw := range []string{
		"CONNECT portal.example.com:8443 HTTP/1.1\r\nHost: portal.example.com:8443\r\n\r\n", // a target's host, another port
		"CONNECT portal.example.com:80 HTTP/1.1\r\nHost: portal.example.com:80\r\n\r\n",
		"CONNECT other.example.com:443 HTTP/1.1\r\nHost: other.example.com:443\r\n\r\n",
		"CONNECT 10.0.0.1:443 HTTP/1.1\r\nHost: 10.0.0.1:443\r\n\r\n",
		"CONNECT [::1]:443 HTTP/1.1\r\nHost: [::1]:443\r\n\r\n",
		"CONNECT portal.example.com:0443 HTTP/1.1\r\nHost: portal.example.com:0443\r\n\r\n",
		"CONNECT portal.example.com: HTTP/1.1\r\nHost: portal.example.com:\r\n\r\n",
		"CONNECT u@portal.example.com:443 HTTP/1.1\r\nHost: u@portal.example.com:443\r\n\r\n",
		"GET http://portal.example.com:443/ HTTP/1.1\r\nHost: portal.example.com:443\r\n\r\n", // plain-HTTP proxying
	} {
		_, _, resp := send(t, front, raw)
		if resp.StatusCode != http.StatusForbidden && resp.StatusCode != http.StatusBadRequest {
			t.Errorf("%q: want a refusal, got %d", strings.SplitN(raw, "\r\n", 2)[0], resp.StatusCode)
		}
		if resp.StatusCode == http.StatusForbidden && resp.Header.Get(FrontRefusedHeader) != "refused" {
			t.Errorf("%q: the refusal is not marked as the front's", raw)
		}
	}
	select {
	case h := <-heads:
		t.Fatalf("a refused request reached the upstream: %q", h)
	case <-time.After(200 * time.Millisecond):
	}
}

func TestFrontFailsClosedWithoutUpstream(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	dead := ln.Addr().String()
	ln.Close()
	front := startFront(t, dead)
	_, _, resp := send(t, front, "CONNECT portal.example.com:443 HTTP/1.1\r\nHost: portal.example.com:443\r\n\r\n")
	if resp.StatusCode != http.StatusBadGateway || resp.Header.Get(FrontRefusedHeader) != "refused" {
		t.Fatalf("want the front's 502, got %d", resp.StatusCode)
	}
}

func TestFrontTarget(t *testing.T) {
	for in, want := range map[string]string{"portal.example.com:443": "portal.example.com:443", "Portal.Example.COM.:443": "portal.example.com:443"} {
		if got, ok := frontTarget(in); !ok || got != want {
			t.Errorf("%q: got %q %v", in, got, ok)
		}
	}
	for _, bad := range []string{"", ":443", "portal.example.com", "portal.example.com:+443", "portal.example.com:65536", "localhost:443", "a b.example.com:443", "portal.example.com:443/x", "portal.example.com..:443"} {
		if _, ok := frontTarget(bad); ok {
			t.Errorf("accepted %q", bad)
		}
	}
}
