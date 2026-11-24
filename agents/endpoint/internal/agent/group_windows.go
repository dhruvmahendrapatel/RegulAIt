package agent

// PackageGroupID: Windows uses ACLs, not a group id, for the ticket file.
func PackageGroupID() int { return -1 }
