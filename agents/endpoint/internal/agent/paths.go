package agent

import (
	"os"
	"path/filepath"
	"runtime"
)

// Paths are where the agent's files live.
type Paths struct {
	ConfigFile string // machine config, root-owned, world-readable
	EnrolFile  string // bulk token, root-only (read by the install step only)
	TicketFile string // device ticket, root:regulait-agent 0640
	StatusFile string // install-step outcome, world-readable, no secrets
	StateDir   string // the user's own state, 0700
}

// DefaultPaths are the documented locations per OS (R15 §3.2, §4.4).
func DefaultPaths() Paths {
	home, _ := os.UserHomeDir()
	switch runtime.GOOS {
	case "darwin":
		sys := "/Library/Application Support/RegulAIt/Agent"
		return Paths{ConfigFile: filepath.Join(sys, "config.json"), EnrolFile: filepath.Join(sys, "enrol.json"), TicketFile: filepath.Join(sys, "ticket.json"),
			StatusFile: filepath.Join(sys, "redeem-status.json"), StateDir: filepath.Join(home, "Library", "Application Support", "RegulAIt", "Agent")}
	case "windows":
		sys := filepath.Join(os.Getenv("ProgramData"), "RegulAIt", "Agent")
		return Paths{ConfigFile: filepath.Join(sys, "config.json"), EnrolFile: filepath.Join(sys, "enrol.json"), TicketFile: filepath.Join(sys, "ticket.json"),
			StatusFile: filepath.Join(sys, "redeem-status.json"), StateDir: filepath.Join(os.Getenv("LOCALAPPDATA"), "RegulAIt", "Agent")}
	default:
		state := os.Getenv("XDG_STATE_HOME")
		if state == "" || !filepath.IsAbs(state) {
			state = filepath.Join(home, ".local", "state")
		}
		return Paths{ConfigFile: "/etc/regulait-agent/config.json", EnrolFile: "/etc/regulait-agent/enrol.json", TicketFile: "/var/lib/regulait-agent/ticket.json",
			StatusFile: "/var/lib/regulait-agent/redeem-status.json", StateDir: filepath.Join(state, "regulait-agent")}
	}
}

// SystemOwner is the uid system files must belong to: root, or -1 on Windows (ACLs instead).
func SystemOwner() int {
	if runtime.GOOS == "windows" {
		return -1
	}
	return 0
}
