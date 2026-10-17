package collect

import (
	"bytes"
	"context"
	"os/exec"
	"time"

	"github.com/dhruvmahendrapatel/regulait/agents/endpoint/internal/contract"
)

func platformRoots() map[contract.Root]string {
	return map[contract.Root]string{contract.RootSystemApplications: "/Applications"}
}

func platformRegistry() Registry { return nil }

// platformPlistToXML converts a binary plist with the system's own plutil, by absolute path, reading stdin and
// writing stdout, so no file name and no shell is involved.
func platformPlistToXML() func([]byte) ([]byte, error) {
	return func(raw []byte) ([]byte, error) {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		cmd := exec.CommandContext(ctx, "/usr/bin/plutil", "-convert", "xml1", "-o", "-", "-")
		cmd.Stdin = bytes.NewReader(raw)
		cmd.Env = []string{}
		return cmd.Output()
	}
}
