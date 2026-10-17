package devicekey

import "path/filepath"

// PlatformStores returns the TPM store and the file fallback, both under stateDir.
func PlatformStores(stateDir string) (Store, Store) {
	dir := filepath.Join(stateDir, "keys")
	return TPMStore{Dir: dir}, FileStore{Dir: dir}
}
