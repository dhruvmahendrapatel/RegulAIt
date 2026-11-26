package main

import (
	"net/http"
	"strings"
	"testing"
)

func connect(authority string) *http.Request {
	return &http.Request{Method: http.MethodConnect, Host: authority}
}

func TestParsePorts(t *testing.T) {
	f, err := ParsePorts("portal.example.com:443\nfiles.example.com:8443\n")
	if err != nil {
		t.Fatal(err)
	}
	if len(f.allowed) != 2 {
		t.Fatalf("want 2 targets, got %d", len(f.allowed))
	}
	for _, bad := range []string{
		"", "\n", "portal.example.com", "portal.example.com:", "portal.example.com:0", "portal.example.com:65536",
		"portal.example.com:0443", "portal.example.com:+443", "Portal.example.com:443", "10.0.0.1:443", "localhost:443",
		"portal.example.com:443\n\n", " portal.example.com:443", "a_b.example.com:443", "-a.example.com:443",
		"[::1]:443", "portal.example.com:443:1", strings.Repeat("a.example.com:443\n", 70),
	} {
		if _, err := ParsePorts(bad); err == nil {
			t.Errorf("accepted %q", bad)
		}
	}
}

func TestCheck(t *testing.T) {
	f, err := ParsePorts("portal.example.com:443\nfiles.example.com:8443")
	if err != nil {
		t.Fatal(err)
	}
	for _, ok := range []string{"portal.example.com:443", "PORTAL.example.com:443", "portal.example.com.:443", "files.example.com:8443"} {
		if err := f.Check(connect(ok)); err != nil {
			t.Errorf("refused %s: %v", ok, err)
		}
	}
	for _, bad := range []string{"portal.example.com:8443", "portal.example.com:80", "files.example.com:443", "other.example.com:443", "portal.example.com", "10.0.0.1:443", "[::1]:443", ""} {
		if err := f.Check(connect(bad)); err == nil {
			t.Errorf("admitted %s", bad)
		}
	}
	// a plain-HTTP proxy request is never a robot's (its origins are https only)
	plain, _ := http.NewRequest(http.MethodGet, "http://portal.example.com:443/", nil)
	if err := f.Check(plain); err == nil {
		t.Error("admitted a plain-HTTP proxy request")
	}
}

func TestLoadPortsMissing(t *testing.T) {
	if _, err := LoadPorts("/nonexistent/ports.txt"); err == nil {
		t.Error("a missing ports file was accepted")
	}
}
