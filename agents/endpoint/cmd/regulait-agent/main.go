// Command regulait-agent is the RegulAIt endpoint agent (ADR-0195 SD4): a read-only collector of the decision-18
// facts that runs as the logged-in user and sends signed, pseudonymous snapshots only to the org's gateway.
//
//	regulait-agent redeem-ticket [-ticket-gid N]   install step, run once as root by the package; always exits 0
//	regulait-agent register                         first run as a user: create the device key and register it
//	regulait-agent run-once                         one collection and upload
//	regulait-agent run                              run-once on the org's schedule until stopped
//	regulait-agent preview -manifest FILE           collect against a local manifest and print the facts; sends nothing
//	regulait-agent hook AGENT -policy FILE          on-device enforcement (ADR-0298, ADR-0330, default off): the
//	                                                MCP tool-call hook for AGENT = claude-code, cursor, copilot-cli
//	                                                or codex; reads stdin, never the network
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
	"github.com/dhruvmahendrapatel/regulait/agents/endpoint/internal/enforce"
	"github.com/dhruvmahendrapatel/regulait/agents/endpoint/internal/pack"
)

func usage() {
	fmt.Fprintln(os.Stderr, "usage: regulait-agent redeem-ticket [-ticket-gid N] | enrol [-ticket-gid N] (token on stdin) | update | health | register | run-once | run | preview -manifest FILE | hook claude-code|cursor|copilot-cli|codex -policy FILE | hook-capabilities | version")
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
	case "enrol":
		// ADR-0360 §5: the one-line enrolment, as root. The token is read from standard input only: an argument would be
		// in every user's process list. A failure exits non-zero (unlike the MDM install step).
		fs := flag.NewFlagSet(cmd, flag.ExitOnError)
		gid := fs.Int("ticket-gid", agent.PackageGroupID(), "group id the ticket file is given (default: the package's regulait-agent group)")
		_ = fs.Parse(args)
		if fs.NArg() != 0 {
			fmt.Fprintln(os.Stderr, "enrol takes the token on standard input, never as an argument")
			os.Exit(2)
		}
		opts.TicketGID = *gid
		st := agent.Enrol(ctx, opts, os.Stdin)
		fmt.Printf("enrolment: %s %s\n", st.Outcome, st.Code)
		if st.Outcome != agent.OutcomeRedeemed && st.Outcome != agent.OutcomeTicketValid {
			os.Exit(1)
		}
	case "update":
		// ADR-0360 §4: the root updater, run by the package's system timer. Off unless the config pins the device-policy
		// and release keys and the spool holds a directive signed for this device.
		exe, err := os.Executable()
		if err != nil {
			fail(log, err)
		}
		if exe, err = filepath.EvalSymlinks(exe); err != nil {
			fail(log, err)
		}
		r := agent.SelfUpdate(ctx, opts, exe)
		if r.Outcome == agent.UpdateFailed {
			os.Exit(1)
		}
	case "health":
		h := agent.Health(opts)
		out, _ := json.Marshal(h)
		fmt.Println(string(out))
		if !h.OK {
			os.Exit(1)
		}
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
// policy denies MCP tool calls, and a usage error exits 2, which every supported agent treats as a block. Nothing is
// sent anywhere.
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
	file := fs.String("policy", "", "the signed enforcement policy (regulait.endpoint-enforcement/1)")
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
	stdout, stderr, code := adapter.Hook(os.Stdin, policy)
	if len(stdout) > 0 {
		_, _ = os.Stdout.Write(stdout)
	}
	if stderr != "" {
		fmt.Fprintln(os.Stderr, stderr)
	}
	return code
}

func fail(log *slog.Logger, err error) {
	log.Error("regulait-agent", "err", err)
	os.Exit(1)
}
