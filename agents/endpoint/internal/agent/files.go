package agent

import "github.com/dhruvmahendrapatel/regulait/agents/endpoint/internal/fsutil"

// maxFileBytes bounds every small file the agent reads (config, enrol file, ticket, state).
const maxFileBytes = 64 << 10

// readChecked is fsutil.ReadChecked with the agent's file-size bound.
func readChecked(path string, owner int, a fsutil.Access) ([]byte, error) {
	return fsutil.ReadChecked(path, owner, a, maxFileBytes)
}
