package directive

import (
	"context"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"time"
)

// Notice is the developer's on-device notice for a removal. The agent composes it; no text from the gateway reaches
// the device. serverName is shape-checked (Verify), provider and path come from the signed manifest and directive.
func Notice(serverName, provider, configPath string) string {
	return `RegulAIt: your organisation's policy removed the MCP server "` + serverName + `" from ` + provider + ` (` + configPath + `).`
}

// Notifier shows one notice to the logged-in developer. It reports whether a notice was shown.
type Notifier func(ctx context.Context, text string) bool

// PlatformNotifier uses the platform's own notifier as an argument list, never through a shell (ADR-0331 §7; a
// narrow own-code exception, see §9): osascript with the text as an argv item read by the script (never
// interpolated into it), notify-send, or msg. A missing tool is "not notified"; the removal stands either way.
func PlatformNotifier(ctx context.Context, text string) bool {
	name, args := notifierCommand(runtime.GOOS, os.Getenv("USERNAME"), os.Getenv("SystemRoot"), text)
	if name == "" {
		return false
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	return exec.CommandContext(ctx, name, args...).Run() == nil
}

// notifierCommand is the argv for one platform. Every tool is named by its absolute path, never looked up through
// PATH, so a directory earlier on PATH cannot supply a look-alike. On Windows `msg` is addressed to the developer's own
// session user and lives in the system directory (SystemRoot, when it is a plain absolute drive path, else C:\Windows).
func notifierCommand(goos, windowsUser, systemRoot, text string) (string, []string) {
	switch goos {
	case "darwin":
		return "/usr/bin/osascript", []string{"-e", "on run argv", "-e", `display notification (item 1 of argv) with title "RegulAIt"`, "-e", "end run", text}
	case "linux":
		return "/usr/bin/notify-send", []string{"--app-name=RegulAIt", "RegulAIt", text}
	case "windows":
		if windowsUser == "" || strings.ContainsAny(windowsUser, " /\\\"*") {
			return "", nil
		}
		return windowsSystemDir(systemRoot) + `\System32\msg.exe`, []string{windowsUser, "/TIME:300", text}
	}
	return "", nil
}

// windowsSystemDir is SystemRoot when it is a drive-rooted path with no separators beyond the root's own folder
// (for example C:\Windows), else the default C:\Windows.
func windowsSystemDir(systemRoot string) string {
	if len(systemRoot) >= 4 && systemRoot[1] == ':' && systemRoot[2] == '\\' &&
		((systemRoot[0] >= 'A' && systemRoot[0] <= 'Z') || (systemRoot[0] >= 'a' && systemRoot[0] <= 'z')) &&
		!strings.ContainsAny(systemRoot[3:], `\\/.:"*?<>|`) {
		return systemRoot
	}
	return `C:\Windows`
}
