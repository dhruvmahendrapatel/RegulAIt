// ADR-0355 — OUR DRIVER around agentaudit (manifold-security/agentaudit, Apache-2.0), the only code we write around
// the engine (ADR-0176). It is run as `agentaudit-driver <input root> <report path>` inside the executor's sandbox,
// with no network, and:
//
//   - reads exactly one input file, `agent-config.json` (a `regulait.agent-config-bundle.v1`: the repository's agent
//     configuration files, placed by the gateway), and refuses anything malformed, oversized, absolute, or escaping
//     the bundle root;
//   - scans the bundle IN MEMORY through agentaudit's library API (an fs.FS; nothing is written to disk and nothing
//     the repository declares is ever run: agentaudit only reads);
//   - writes a `regulait.agent-config-audit.v1` report of rule ids, agents, categories, files and key paths. It
//     NEVER writes a finding's value (a command line, a URL, an environment value: agentaudit's own report prints
//     them, and they can be credentials). The gateway maps each rule id to its severity and fix hint;
//   - fails closed: an unreadable input, a scan error or an engine version other than the pinned one writes a
//     `failed` report and exits 2. A scan that could not read or parse a source still completes, with the counts,
//     and the gateway treats it as incomplete (never as clean).
package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"runtime/debug"
	"sort"
	"strings"
	"testing/fstest"
	"time"
	"sync/atomic"
	"unicode/utf8"

	"github.com/manifold-security/agentaudit"
)

const (
	bundleSchema   = "regulait.agent-config-bundle.v1"
	reportSchema   = "regulait.agent-config-audit.v1"
	inputFile      = "agent-config.json"
	enginePath     = "github.com/manifold-security/agentaudit"
	pinnedVersion  = "v0.1.2"
	maxInputBytes  = 8 << 20
	maxFiles       = 500
	maxPathBytes   = 512
	maxKeyBytes    = 300
	maxFindings    = 5000
	maxFileBytes   = 512 << 10
	maxEntityCount = 10000
)

type bundleFile struct {
	Path    string `json:"path"`
	Content string `json:"content"`
}

type bundle struct {
	Schema string       `json:"schema"`
	Files  []bundleFile `json:"files"`
}

type reportFinding struct {
	Rule       string   `json:"rule"`
	Agent      string   `json:"agent"`
	Categories []string `json:"categories"`
	File       string   `json:"file"`
	Key        string   `json:"key"`
}

type report struct {
	Schema            string          `json:"schema"`
	Status            string          `json:"status"`
	Error             string          `json:"error,omitempty"`
	Engine            string          `json:"engine"`
	EngineVersion     string          `json:"engineVersion"`
	InputSha256       string          `json:"inputSha256,omitempty"`
	FilesScanned      int             `json:"filesScanned"`
	ScannedAgents     []string        `json:"scannedAgents"`
	UnreadableSources int             `json:"unreadableSources"`
	UnparsedSources   int             `json:"unparsedSources"`
	OmittedFindings   int             `json:"omittedFindings"`
	Warnings          int             `json:"warnings"`
	Findings          []reportFinding `json:"findings"`
	DurationMs        int64           `json:"durationMs"`
}

// engineVersion is the agentaudit module version linked into this binary (never a claim).
func engineVersion() string {
	info, ok := debug.ReadBuildInfo()
	if !ok {
		return ""
	}
	for _, d := range info.Deps {
		if d.Path == enginePath {
			if d.Replace != nil {
				return "replaced"
			}
			return d.Version
		}
	}
	return ""
}

// cleanBundlePath accepts a relative, slash-separated path inside the bundle root, or returns "".
func cleanBundlePath(p string) string {
	if p == "" || len(p) > maxPathBytes || !utf8.ValidString(p) || strings.ContainsAny(p, "\\\x00") || strings.HasPrefix(p, "/") {
		return ""
	}
	c := path.Clean(p)
	if c != p || c == "." || c == ".." || strings.HasPrefix(c, "../") || !fsValid(c) {
		return ""
	}
	return c
}

func fsValid(p string) bool {
	for _, seg := range strings.Split(p, "/") {
		if seg == "" || seg == "." || seg == ".." {
			return false
		}
		for _, r := range seg {
			if r < 0x20 || r == 0x7f {
				return false
			}
		}
	}
	return true
}

func clip(s string, n int) string {
	if len(s) <= n {
		return s
	}
	s = s[:n]
	for !utf8.ValidString(s) && len(s) > 0 {
		s = s[:len(s)-1]
	}
	return s
}

func loadBundle(root string) (fstest.MapFS, string, int, error) {
	f, err := os.Open(filepath.Join(root, inputFile))
	if err != nil {
		return nil, "", 0, errors.New("input_unreadable")
	}
	defer f.Close()
	raw, err := io.ReadAll(io.LimitReader(f, maxInputBytes+1))
	if err != nil {
		return nil, "", 0, errors.New("input_unreadable")
	}
	if len(raw) > maxInputBytes {
		return nil, "", 0, errors.New("input_too_large")
	}
	sum := sha256.Sum256(raw)
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	var b bundle
	if err := dec.Decode(&b); err != nil || dec.More() {
		return nil, "", 0, errors.New("input_invalid")
	}
	if b.Schema != bundleSchema || len(b.Files) == 0 || len(b.Files) > maxFiles {
		return nil, "", 0, errors.New("input_invalid")
	}
	fsys := fstest.MapFS{}
	for _, bf := range b.Files {
		p := cleanBundlePath(bf.Path)
		if p == "" {
			return nil, "", 0, errors.New("input_invalid_path")
		}
		if _, dup := fsys[p]; dup {
			return nil, "", 0, errors.New("input_duplicate_path")
		}
		fsys[p] = &fstest.MapFile{Data: []byte(bf.Content), Mode: 0o444}
	}
	// a file and a directory of the same name cannot both exist
	for p := range fsys {
		for dir := path.Dir(p); dir != "."; dir = path.Dir(dir) {
			if _, clash := fsys[dir]; clash {
				return nil, "", 0, errors.New("input_invalid_path")
			}
		}
	}
	return fsys, hex.EncodeToString(sum[:]), len(b.Files), nil
}

func write(out string, r report) {
	r.Schema = reportSchema
	r.Engine = "agentaudit"
	if r.ScannedAgents == nil {
		r.ScannedAgents = []string{}
	}
	if r.Findings == nil {
		r.Findings = []reportFinding{}
	}
	data, err := json.Marshal(r)
	if err != nil {
		os.Exit(2)
	}
	tmp := out + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		os.Exit(2)
	}
	if err := os.Rename(tmp, out); err != nil {
		os.Exit(2)
	}
}

func fail(out, code, version string, started time.Time) {
	write(out, report{Status: "failed", Error: code, EngineVersion: version, DurationMs: time.Since(started).Milliseconds()})
	os.Exit(2)
}

func main() {
	started := time.Now()
	if len(os.Args) != 3 {
		fmt.Fprintln(os.Stderr, "usage: agentaudit-driver <input root> <report path>")
		os.Exit(2)
	}
	in, out := os.Args[1], os.Args[2]
	version := strings.TrimPrefix(engineVersion(), "v")
	if "v"+version != pinnedVersion {
		fail(out, "engine_version_mismatch", version, started)
	}
	fsys, digest, nFiles, err := loadBundle(in)
	if err != nil {
		fail(out, err.Error(), version, started)
	}
	var warnings atomic.Int64
	scanner := agentaudit.New(
		agentaudit.WithWarnFunc(func(error) { warnings.Add(1) }),
		agentaudit.WithMaxFindings(maxFindings),
		agentaudit.WithMaxFileSize(maxFileBytes),
		agentaudit.WithMaxReadBytes(maxInputBytes),
		agentaudit.WithMaxEntities(maxEntityCount),
	)
	rep, err := scanner.Scan(fsys)
	if err != nil {
		fail(out, "scan_failed", version, started)
	}
	findings := make([]reportFinding, 0, len(rep.Findings()))
	for _, f := range rep.Findings() {
		cats := make([]string, 0, len(f.Categories))
		for _, c := range f.Categories {
			cats = append(cats, clip(string(c), 64))
		}
		sort.Strings(cats)
		// rule id, agent, categories, file and key path only: the capability's VALUE is never written
		findings = append(findings, reportFinding{
			Rule:       clip(f.RuleID, 128),
			Agent:      clip(f.Agent, 64),
			Categories: cats,
			File:       clip(f.Capability.Provenance.File, maxPathBytes),
			Key:        clip(f.Capability.Provenance.Key, maxKeyBytes),
		})
	}
	agents := append([]string{}, rep.ScannedAgents()...)
	sort.Strings(agents)
	write(out, report{
		Status:            "completed",
		EngineVersion:     version,
		InputSha256:       digest,
		FilesScanned:      nFiles,
		ScannedAgents:     agents,
		UnreadableSources: rep.UnreadableSources(),
		UnparsedSources:   rep.UnparsedSources(),
		OmittedFindings:   rep.OmittedFindings(),
		Warnings:          int(warnings.Load()),
		Findings:          findings,
		DurationMs:        time.Since(started).Milliseconds(),
	})
}
