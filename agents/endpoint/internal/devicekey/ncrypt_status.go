package devicekey

import "fmt"

// NCrypt statuses (winerror.h) that mean the Platform Crypto Provider has no TPM behind it. Owner decision 4: the
// DPAPI fallback is used only where no hardware exists, so only these are "no hardware". Every other status from
// opening the provider (access denied, a TPM that is present but not ready, a provider DLL that fails to
// initialise, an internal error) is an error, and the agent refuses rather than falling back.
const (
	nteProvDLLNotFound = 0x8009001E // NTE_PROV_DLL_NOT_FOUND: the provider's DLL is not installed
	nteDeviceNotFound  = 0x80090035 // NTE_DEVICE_NOT_FOUND: the provider's device (the TPM) does not exist
	// NTE_DEVICE_NOT_READY is ambiguous: Windows returns it both for a TPM that is present but not ready and for a
	// machine with no TPM at all (observed on the CI Windows runner, 2026-10-17). It counts as "no hardware" only
	// when TBS itself says no TPM exists (tpmAbsent); otherwise it is a failing TPM and is refused.
	nteDeviceNotReady = 0x80090030
)

// classifyProviderOpen maps the status of NCryptOpenStorageProvider for the Platform Crypto Provider to nil (it
// opened), an ErrNoHardware error, or a plain error. tpmAbsent asks TBS whether a TPM exists; it is consulted only
// for the ambiguous NTE_DEVICE_NOT_READY.
func classifyProviderOpen(status uint32, tpmAbsent func() bool) error {
	switch status {
	case 0:
		return nil
	case nteDeviceNotFound, nteProvDLLNotFound:
		return fmt.Errorf("%w: the Platform Crypto Provider reports no TPM (NCrypt status 0x%08x)", ErrNoHardware, status)
	case nteDeviceNotReady:
		if tpmAbsent != nil && tpmAbsent() {
			return fmt.Errorf("%w: TBS reports no TPM on this machine (NCrypt status 0x%08x)", ErrNoHardware, status)
		}
		return fmt.Errorf("the Platform Crypto Provider reports a TPM that is not ready (NCrypt status 0x%08x); a TPM that is present but failing is not a reason to fall back", status)
	default:
		return fmt.Errorf("the Platform Crypto Provider did not open (NCrypt status 0x%08x); a TPM that is present but failing is not a reason to fall back", status)
	}
}
