package bundle

import (
	"bytes"
	"embed"
	"fmt"
	"io/fs"
	"path"
)

// The release keyring is compiled into the operator (ADR-0304 §2a): the same pinned set as infra/release-keys/, which
// scripts/verify-update-bundle.sh uses. CI fails when the two differ. A keyring held only in a ConfigMap could be
// replaced by anyone able to edit that ConfigMap, so it is never the trust anchor.
//
//go:embed keys/*.pub
var embeddedKeys embed.FS

// EmbeddedKeyring returns the compiled-in keys as "<keyId>.pub" -> PEM.
func EmbeddedKeyring() map[string]string {
	out := map[string]string{}
	entries, _ := fs.Glob(embeddedKeys, "keys/*.pub")
	for _, e := range entries {
		b, err := embeddedKeys.ReadFile(e)
		if err == nil {
			out[path.Base(e)] = string(b)
		}
	}
	return out
}

// MergeKeyrings adds the opted-in extra keys to the pinned ones. An extra entry may add a key id; it may never replace
// a pinned one, so an entry with a pinned id and different content is refused rather than ignored.
func MergeKeyrings(pinned, extra map[string]string) (map[string]string, error) {
	out := make(map[string]string, len(pinned)+len(extra))
	for k, v := range pinned {
		out[k] = v
	}
	for k, v := range extra {
		if p, ok := pinned[k]; ok {
			if !bytes.Equal(bytes.TrimSpace([]byte(p)), bytes.TrimSpace([]byte(v))) {
				return nil, &Refusal{Reason: "KeyIDShadowsPinned", Message: fmt.Sprintf("the extra keyring entry %q has the id of a pinned release key with different content", k)}
			}
			continue
		}
		out[k] = v
	}
	return out, nil
}
