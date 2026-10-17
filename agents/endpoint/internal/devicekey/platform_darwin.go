package devicekey

import (
	"errors"

	"github.com/dhruvmahendrapatel/regulait/agents/endpoint/internal/contract"
)

// secureEnclaveStore stands in for the Secure Enclave store, which needs a cgo build on the macOS runner (SD4j).
// Its probe fails with an error that is NOT ErrNoHardware, so Select refuses instead of falling back: every
// supported Mac has a Secure Enclave, and owner decision d allows the fallback only where there is none.
type secureEnclaveStore struct{}

var errSecureEnclavePending = errors.New("this darwin build has no Secure Enclave key store (it needs the cgo build on the macOS runner, SD4j)")

func (secureEnclaveStore) Provider() string                   { return "secure_enclave" }
func (secureEnclaveStore) Protection() contract.KeyProtection { return contract.KeyHardware }
func (secureEnclaveStore) Probe() error                       { return errSecureEnclavePending }
func (secureEnclaveStore) Create() (Key, error)               { return nil, errSecureEnclavePending }
func (secureEnclaveStore) Load(string) (Key, error)           { return nil, errSecureEnclavePending }
func (secureEnclaveStore) Delete(string) error                { return errSecureEnclavePending }

// PlatformStores returns the Secure Enclave stand-in and no software fallback.
func PlatformStores(string) (Store, Store) {
	return secureEnclaveStore{}, nil
}
