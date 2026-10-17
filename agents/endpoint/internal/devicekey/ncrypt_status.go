package devicekey

import "fmt"

// NCrypt statuses (winerror.h) that mean the Platform Crypto Provider has no TPM behind it. Owner decision 4: the
// DPAPI fallback is used only where no hardware exists, so only these are "no hardware". Every other status from
// opening the provider (access denied, a provider DLL that fails to initialise, an internal error) is an error,
// and the agent refuses rather than falling back.
const (
	nteProvDLLNotFound = 0x8009001E // NTE_PROV_DLL_NOT_FOUND: the provider's DLL is not installed
	nteDeviceNotFound  = 0x80090035 // NTE_DEVICE_NOT_FOUND: the provider's device (the TPM) does not exist
	// NTE_DEVICE_NOT_READY is ambiguous: Windows returns it both for a TPM that is present but not ready and for a
	// machine with no TPM at all (observed on the CI Windows runner, 2026-10-17). TBS_E_TPM_NOT_FOUND may also be
	// passed through by the provider. Both count as "no hardware" only when TBS itself says no TPM exists.
	nteDeviceNotReady = 0x80090030
	tbsETPMNotFound   = 0x8028400F
)

// classifyProviderOpen maps the status of NCryptOpenStorageProvider for the Platform Crypto Provider to nil (it
// opened), an ErrNoHardware error, or a plain error. tpmPresent asks TBS whether a TPM exists and is consulted only
// for the ambiguous statuses: (false, nil) means TBS answered TBS_E_TPM_NOT_FOUND; a TPM reported present, any
// other TBS error or no probe at all is a refusal.
func classifyProviderOpen(status uint32, tpmPresent func() (bool, error)) error {
	switch status {
	case 0:
		return nil
	case nteDeviceNotFound, nteProvDLLNotFound:
		return fmt.Errorf("%w: the Platform Crypto Provider reports no TPM (NCrypt status 0x%08x)", ErrNoHardware, status)
	case nteDeviceNotReady, tbsETPMNotFound:
		if tpmPresent == nil {
			return fmt.Errorf("the Platform Crypto Provider is not ready (NCrypt status 0x%08x) and TBS was not asked; refusing", status)
		}
		present, err := tpmPresent()
		switch {
		case err != nil:
			return fmt.Errorf("the Platform Crypto Provider is not ready (NCrypt status 0x%08x) and TBS did not answer: %v; refusing", status, err)
		case present:
			return fmt.Errorf("the Platform Crypto Provider reports a TPM that is not ready (NCrypt status 0x%08x); a TPM that is present but failing is not a reason to fall back", status)
		default:
			return fmt.Errorf("%w: TBS reports no TPM on this machine (NCrypt status 0x%08x)", ErrNoHardware, status)
		}
	default:
		return fmt.Errorf("the Platform Crypto Provider did not open (NCrypt status 0x%08x); a TPM that is present but failing is not a reason to fall back", status)
	}
}

// tbsAnswer maps the return of Tbsi_GetDeviceInfo to the tpmPresent contract: success is a TPM, TBS_E_TPM_NOT_FOUND
// is no TPM, and anything else is an error (so the caller refuses).
func tbsAnswer(r uint32) (bool, error) {
	switch r {
	case 0:
		return true, nil
	case tbsETPMNotFound:
		return false, nil
	default:
		return false, fmt.Errorf("Tbsi_GetDeviceInfo returned 0x%08x", r)
	}
}
