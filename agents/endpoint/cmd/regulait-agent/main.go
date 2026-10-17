// Command regulait-agent is the RegulAIt endpoint agent (ADR-0195 SD4): a read-only collector of the decision-18
// facts that runs as the logged-in user and sends signed, pseudonymous snapshots only to the org's gateway.
//
//	regulait-agent redeem-ticket [-ticket-gid N]   install step, run once as root by the package; always exits 0
//	regulait-agent register                         first run as a user: create the device key and register it
//	regulait-agent run-once                         one collection and upload
//	regulait-agent run                              run-once on the org's schedule until stopped
//	regulait-agent preview -manifest FILE           collect against a local manifest and print the facts; sends nothing
//	regulait-agent version
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	"github.com/dhruvmahendrapatel/regulait/agents/endpoint/internal/agent"
	"github.com/dhruvmahendrapatel/regulait/agents/endpoint/internal/collect"
	"github.com/dhruvmahendrapatel/regulait/agents/endpoint/internal/pack"
)

func usage() {
	fmt.Fprintln(os.Stderr, "usage: regulait-agent redeem-ticket [-ticket-gid N] | register | run-once | run | preview -manifest FILE | version")
	os.Exit(2)
}

func main() {
	if len(os.Args) < 2 {
		usage()
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

func fail(log *slog.Logger, err error) {
	log.Error("regulait-agent", "err", err)
	os.Exit(1)
}
