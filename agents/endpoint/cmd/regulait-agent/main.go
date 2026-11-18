// Command regulait-agent is the RegulAIt endpoint agent (ADR-0195 SD4): a read-only collector of the decision-18
// facts that runs as the logged-in user and sends signed, pseudonymous snapshots only to the org's gateway.
//
//	regulait-agent redeem-ticket [-ticket-gid N]   install step, run once as root by the package; always exits 0
//	regulait-agent register                         first run as a user: create the device key and register it
//	regulait-agent run-once                         one collection and upload
//	regulait-agent run                              run-once on the org's schedule until stopped
//	regulait-agent preview -manifest FILE           collect against a local manifest and print the facts; sends nothing
//	regulait-agent hook AGENT -policy FILE          on-device enforcement (ADR-0298, ADR-0330, ADR-0350, default off): the
//	                                                MCP and built-in command hook for AGENT = claude-code, cursor, copilot-cli
//	                                                or codex; reads stdin, never the network; its decision is
//	                                                spooled on the device, and the run loop uploads it
//	regulait-agent hook-capabilities                print each hook adapter's contract and capability matrix as JSON
//	regulait-agent version
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/dhruvmahendrapatel/regulait/agents/endpoint/internal/agent"
	"github.com/dhruvmahendrapatel/regulait/agents/endpoint/internal/collect"
	"github.com/dhruvmahendrapatel/regulait/agents/endpoint/internal/decisionlog"
	"github.com/dhruvmahendrapatel/regulait/agents/endpoint/internal/enforce"
	"github.com/dhruvmahendrapatel/regulait/agents/endpoint/internal/pack"
)

func usage() {
	fmt.Fprintln(os.Stderr, "usage: regulait-agent redeem-ticket [-ticket-gid N] | register | run-once | run | preview -manifest FILE | hook claude-code|cursor|copilot-cli|codex -policy FILE | hook-capabilities | version")
	os.Exit(2)
}

func main() {
	if len(os.Args) < 2 {
		usage()
	}
	if os.Args[1] == "hook-capabilities" {
		// the per-agent capability matrix (ADR-0330), for the admin console and for a customer's own review
		out, _ := json.MarshalIndent(enforce.Adapters, "", "  ")
		fmt.Println(string(out))
		return
	}
	if os.Args[1] == "hook" {
		os.Exit(hook(os.Args[2:]))
	}
	log := slog.New(slog.NewTextHandler(os.Stderr, nil))
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	opts := agent.Options{Paths: agent.DefaultPaths(), SystemOwner: agent.SystemOwner(), TicketGID: -1, Log: log}
	cycle := func() *agent.Cycle {
		return &agent.Cycle{Options: opts, Keyring: pack.CompiledKeyring, Identity: agent.ProductionIdentity(), Env: func() (*collect.Env, error) {
			home, err := os.UserHomeDir()
			if err != nil {
				return nil, err
			}
			return collect.NewEnv(home)
		}}
	}
	switch cmd, args := os.Args[1], os.Args[2:]; cmd {
	case "redeem-ticket":
		fs := flag.NewFlagSet(cmd, flag.ExitOnError)
		gid := fs.Int("ticket-gid", -1, "group id the ticket file is given (the package's regulait-agent group)")
		_ = fs.Parse(args)
		opts.TicketGID = *gid
		// never fails an MDM install or upgrade (R15 §3.2): the outcome is in the status file and the log
		agent.Redeem(ctx, opts)
		os.Exit(0)
	case "register":
		if _, err := agent.Register(ctx, opts); err != nil {
			fail(log, err)
		}
	case "run-once":
		if _, err := cycle().RunOnce(ctx); err != nil {
			fail(log, err)
		}
	case "run":
		if err := cycle().Daemon(ctx); err != nil && !errors.Is(err, context.Canceled) {
			fail(log, err)
		}
	case "preview":
		fs := flag.NewFlagSet(cmd, flag.ExitOnError)
		file := fs.String("manifest", "", "a collection manifest (regulait.endpoint-collection/1) to preview against")
		_ = fs.Parse(args)
		if *file == "" {
			usage()
		}
		preview(log, *file)
	case "version":
		fmt.Println(agent.Version)
	default:
		usage()
	}
}

// preview runs the collectors locally against an unsigned manifest and prints the facts. It exists so an admin
// can see exactly what the agent would report on a machine before enrolling it; nothing is sent anywhere.
func preview(log *slog.Logger, file string) {
	raw, err := os.ReadFile(file)
	if err != nil {
		fail(log, err)
	}
	col, err := pack.ParseCollection(raw)
	if err != nil {
		fail(log, err)
	}
	home, err := os.UserHomeDir()
	if err != nil {
		fail(log, err)
	}
	env, err := collect.NewEnv(home)
	if err != nil {
		fail(log, err)
	}
	facts, gaps := collect.Collect(env, col, nil)
	out, _ := json.MarshalIndent(map[string]any{"facts": facts, "gaps": gaps}, "", "  ")
	fmt.Println(string(out))
}

// hook answers one coding-agent hook call (ADR-0298, ADR-0330). Every failure blocks: a missing or unverifiable
// policy denies MCP tool calls, and a usage error exits 2, which every supported agent treats as a block. The hook
// itself sends nothing: the decision is spooled in the user's state directory (internal/decisionlog, ADR-0310
// addendum), without the call's arguments, and the agent's run loop uploads it to the org's gateway.
func hook(args []string) int {
	const usage = "RegulAIt: usage: regulait-agent hook claude-code|cursor|copilot-cli|codex -policy FILE"
	if len(args) < 1 {
		fmt.Fprintln(os.Stderr, usage)
		return enforce.ExitBlock
	}
	adapter, ok := enforce.Lookup(args[0])
	if !ok {
		fmt.Fprintln(os.Stderr, usage)
		return enforce.ExitBlock
	}
	fs := flag.NewFlagSet("hook "+args[0], flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	file := fs.String("policy", "", "the signed enforcement policy (regulait.endpoint-enforcement/2)")
	if err := fs.Parse(args[1:]); err != nil || *file == "" {
		fmt.Fprintln(os.Stderr, "RegulAIt: the enforcement hook is registered without a policy file, so it blocks.")
		return enforce.ExitBlock
	}
	// the keyring: the compiled keys plus the device-policy signer's keys the admin pinned in the agent's
	// root-owned config (owner decision B4). An unreadable or invalid config pins nothing, so the hook still denies.
	keys := enforce.CompiledKeyring
	if cfg, err := agent.LoadConfig(agent.DefaultPaths().ConfigFile, agent.SystemOwner()); err == nil {
		keys = keys.With(cfg.DevicePolicyKeys)
	}
	var policy *enforce.Policy
	if f, err := os.Open(*file); err == nil {
		policy, _ = enforce.LoadPolicy(f, keys, time.Now())
		_ = f.Close()
	}
	r := adapter.HookDecide(os.Stdin, policy, hookEnv(adapter.Name))
	spoolDecision(adapter.Name, r, policy)
	if len(r.Stdout) > 0 {
		_, _ = os.Stdout.Write(r.Stdout)
	}
	if r.Stderr != "" {
		fmt.Fprintln(os.Stderr, r.Stderr)
	}
	return r.Exit
}

// spoolDecision records the answered call (internal/decisionlog). It is silent: no error, and no panic, from the
// spool ever changes the decision, the exit code, stdout or stderr.
func spoolDecision(agentName string, r enforce.HookResult, policy *enforce.Policy) {
	defer func() { _ = recover() }()
	state := agent.DefaultPaths().StateDir
	if !filepath.IsAbs(state) {
		// no home directory in the hook's environment: never spool relative to the coding agent's working directory
		return
	}
	spool := decisionlog.New(state)
	_ = decisionlog.Record(spool, spool, agentName, r.Call, r.Decision, policy, time.Now())
}

// hookEnv is what a command decision reads from the device (ADR-0350). The device id stays empty until the agent
// delivers policies itself (slice 2), so a policy's per-device exceptions never apply yet: strict by default.
func hookEnv(agentName string) enforce.HookEnv {
	env := enforce.HookEnv{Now: time.Now(), Resolve: resolveExisting}
	if home, err := os.UserHomeDir(); err == nil {
		env.Home = home
	}
	if agentName == enforce.AgentClaudeCode {
		// Claude Code sets it for every hook: the project root, a workspace root besides the call's cwd
		env.ProjectDir = os.Getenv("CLAUDE_PROJECT_DIR")
	}
	return env
}

// resolveExisting resolves symlinks in the longest prefix of p that exists, so a link cannot step around a path
// rule; the rest of p (a file about to be created) is kept as written.
func resolveExisting(p string) string {
	rest := ""
	for dir := p; ; dir = filepath.Dir(dir) {
		if real, err := filepath.EvalSymlinks(dir); err == nil {
			return filepath.Join(real, rest)
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return p
		}
		rest = filepath.Join(filepath.Base(dir), rest)
	}
}

func fail(log *slog.Logger, err error) {
	log.Error("regulait-agent", "err", err)
	os.Exit(1)
}
