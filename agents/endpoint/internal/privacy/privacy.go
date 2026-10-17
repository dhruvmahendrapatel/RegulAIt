// Package privacy is the last check before a report leaves the device (ADR-0195 decision 20, R15 call 3).
//
// The collectors already report only catalogue identifiers and paths relative to a root, so a report should
// never name the person or the machine. This guard proves it for each report instead of trusting it: it refuses
// a report that contains the home directory's absolute path, or the user name or host name as a whole token. A
// refused report is not sent, and the log line says why without repeating the value.
package privacy

import (
	"errors"
	"path/filepath"
	"strings"
)

// Identity is what must not appear in a report.
type Identity struct {
	HomeDir  string
	UserName string
	Hostname string
}

// ErrIdentifying is returned for a report that names the user or the device.
var ErrIdentifying = errors.New("report refused by the pseudonymity guard")

// minToken is the shortest user or host name compared as a token; shorter ones would refuse ordinary words.
const minToken = 3

// tokens splits on the separators a JSON report puts around a name: quotes, path separators, whitespace and
// punctuation that is not part of a name. Dots, dashes and underscores stay inside a token, so "example.app"
// is one token and never equals a user called "app".
func tokens(s string) []string {
	return strings.FieldsFunc(s, func(r rune) bool {
		switch r {
		case '"', '\'', '/', '\\', ' ', '\t', '\n', '\r', ',', ':', ';', '=', '{', '}', '[', ']', '(', ')', '@':
			return true
		}
		return false
	})
}

// Check refuses body if it names id's home directory, user or host.
func (id Identity) Check(body []byte) error {
	s := string(body)
	lower := strings.ToLower(s)
	if h := strings.TrimRight(id.HomeDir, `/\`); len(h) >= minToken {
		for _, form := range []string{h, filepath.ToSlash(h), strings.ReplaceAll(h, `\`, `\\`)} {
			if strings.Contains(lower, strings.ToLower(form)) {
				return errors.Join(ErrIdentifying, errors.New("it contains the home directory path"))
			}
		}
	}
	names := map[string]string{}
	if u := strings.ToLower(lastSegment(id.UserName)); len(u) >= minToken {
		names[u] = "the user name"
	}
	if host := strings.ToLower(id.Hostname); len(host) >= minToken {
		names[host] = "the host name"
		if short, _, ok := strings.Cut(host, "."); ok && len(short) >= minToken {
			names[short] = "the host name"
		}
	}
	for _, t := range tokens(lower) {
		if what, ok := names[t]; ok {
			return errors.Join(ErrIdentifying, errors.New("it contains "+what))
		}
	}
	return nil
}

// lastSegment drops a Windows `DOMAIN\` prefix.
func lastSegment(u string) string {
	if i := strings.LastIndexAny(u, `\/`); i >= 0 {
		return u[i+1:]
	}
	return u
}
