package agent

import (
	"os"
	"os/user"
	"runtime"
)

// ownUID is the uid the user's own state files must belong to (ownerCurrentUser on Windows, checked by SID).
func ownUID() int {
	if runtime.GOOS == "windows" {
		return ownerCurrentUser
	}
	return os.Getuid()
}

// currentUserName is the self-reported device user name, sent only in the registration (R15 §3.2).
func currentUserName() string {
	if u, err := user.Current(); err == nil && u.Username != "" {
		return u.Username
	}
	for _, v := range []string{"USER", "USERNAME", "LOGNAME"} {
		if s := os.Getenv(v); s != "" {
			return s
		}
	}
	return "unknown"
}
