//go:build !windows

package agent

import (
	"os/user"
	"strconv"
)

// PackageGroup is the group the package creates for the device ticket (R15 §3.2).
const PackageGroup = "regulait-agent"

// PackageGroupID is the package group's gid, or -1 when it does not exist (the ticket file keeps its group).
func PackageGroupID() int {
	g, err := user.LookupGroup(PackageGroup)
	if err != nil {
		return -1
	}
	id, err := strconv.Atoi(g.Gid)
	if err != nil {
		return -1
	}
	return id
}
