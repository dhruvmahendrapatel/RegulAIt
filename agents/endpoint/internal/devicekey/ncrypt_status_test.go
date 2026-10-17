package devicekey

import (
	"errors"
	"testing"
)

// Only the two "no TPM" statuses allow the DPAPI fallback; every other status is an error that is not ErrNoHardware.
func TestClassifyProviderOpen(t *testing.T) {
	if err := classifyProviderOpen(0); err != nil {
		t.Fatalf("success: %v", err)
	}
	for _, s := range []uint32{0x80090035, 0x8009001E} {
		if err := classifyProviderOpen(s); !errors.Is(err, ErrNoHardware) {
			t.Errorf("0x%08x: want no hardware, got %v", s, err)
		}
	}
	for _, s := range []uint32{
		0x80090010, // NTE_PERM
		0x80090030, // NTE_DEVICE_NOT_READY: a TPM is there
		0x8009001D, // NTE_PROVIDER_DLL_FAIL
		0x80090020, // NTE_FAIL
		0x80090016, // NTE_BAD_KEYSET
		0x80290201, // TPM_E_PCP_DEVICE_NOT_READY
		0x80070005, // E_ACCESSDENIED
		0xFFFFFFFF,
	} {
		err := classifyProviderOpen(s)
		if err == nil || errors.Is(err, ErrNoHardware) {
			t.Errorf("0x%08x: want a plain error (no fallback), got %v", s, err)
		}
	}
}
