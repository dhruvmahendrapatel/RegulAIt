// ADR-0364 S3 §7 — THE PORT FILTER. Smokescreen's ACL names hosts only (it cannot limit a host's destination ports), so
// this hook, Smokescreen's own `Config.PostDecisionRequestHandler`, refuses every request whose destination is not one
// of the run's targets, host AND port. Smokescreen calls it only after its own ACL and IP checks allowed the request,
// and denies the request when it returns an error (logged in the CANONICAL-PROXY-DECISION line's `error`).
//
// The targets are the run's ports file (one `host:port` per line), written by the executor next to the run's ACL from
// the same offer targets, and mounted read-only with it. A missing, empty or malformed file stops the proxy before it
// listens: there is no unfiltered mode.
package main

import (
	"errors"
	"fmt"
	"net/http"
	"os"
	"strconv"
	"strings"

	"github.com/stripe/smokescreen/pkg/smokescreen/hostport"
)

// PortsFile is where the executor mounts the run's ports file (beside the ACL; SMOKESCREEN_PORTS_FILE in the executor)
const PortsFile = "/etc/regulait-egress/ports.txt"

const maxTargets = 64
const maxFileBytes = 64 * 1024

// PortFilter holds the run's allowed `host:port` pairs (host lower-case, no trailing dot)
type PortFilter struct {
	allowed map[string]struct{}
}

// validHost: a lower-case DNS name of at least two labels whose last label holds a letter (never an IP literal),
// checked label by label (the executor's isRobotEgressHost)
func validHost(h string) bool {
	if len(h) < 3 || len(h) > 253 {
		return false
	}
	labels := strings.Split(h, ".")
	if len(labels) < 2 {
		return false
	}
	for _, l := range labels {
		if len(l) < 1 || len(l) > 63 || l[0] == '-' || l[len(l)-1] == '-' {
			return false
		}
		for i := 0; i < len(l); i++ {
			c := l[i]
			if !((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-') {
				return false
			}
		}
	}
	return strings.IndexFunc(labels[len(labels)-1], func(r rune) bool { return r >= 'a' && r <= 'z' }) >= 0
}

// ParsePorts reads a ports file's text: one `host:port` per line, a final newline optional, nothing else
func ParsePorts(text string) (*PortFilter, error) {
	if len(text) > maxFileBytes {
		return nil, errors.New("the ports file is too large")
	}
	f := &PortFilter{allowed: map[string]struct{}{}}
	lines := strings.Split(strings.TrimSuffix(text, "\n"), "\n")
	if len(lines) > maxTargets {
		return nil, errors.New("the ports file names more than 64 targets")
	}
	for i, line := range lines {
		host, port, ok := strings.Cut(line, ":")
		if !ok || !validHost(host) {
			return nil, fmt.Errorf("ports file line %d is not host:port", i+1)
		}
		n, err := strconv.Atoi(port)
		if err != nil || n < 1 || n > 65535 || strconv.Itoa(n) != port {
			return nil, fmt.Errorf("ports file line %d has no valid port", i+1)
		}
		f.allowed[host+":"+port] = struct{}{}
	}
	return f, nil
}

// LoadPorts reads and parses the ports file at path
func LoadPorts(path string) (*PortFilter, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("the ports file was not read: %w", err)
	}
	return ParsePorts(string(b))
}

// Check is the PostDecisionRequestHandler: nil admits the request, an error denies it. A robot run's origins are
// https only, so its browser only ever sends CONNECT; a plain-HTTP proxy request is refused outright.
func (f *PortFilter) Check(req *http.Request) error {
	if req.Method != http.MethodConnect {
		return errors.New("regulait port filter: only CONNECT is allowed")
	}
	// Smokescreen's own parsing and normalisation of the CONNECT authority (the call its handleConnect makes)
	hp, err := hostport.New(req.Host, false)
	if err != nil {
		return fmt.Errorf("regulait port filter: %w", err)
	}
	key := strings.TrimSuffix(strings.ToLower(hp.Host), ".") + ":" + strconv.Itoa(hp.Port)
	if _, ok := f.allowed[key]; !ok {
		return fmt.Errorf("regulait port filter: %s is not one of the run's targets", key)
	}
	return nil
}
