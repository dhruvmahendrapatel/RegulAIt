package devicekey

import (
	"errors"
	"testing"
)

// Only the two "no TPM" statuses allow the DPAPI fallback; every other status is an error that is not ErrNoHardware.
func TestClassifyProviderOpen(t *testing.T) {
	if err := classifyProviderOpen(0, nil); err != nil {
		t.Fatalf("success: %v", err)
	}
	for _, s := range []uint32{0x80090035, 0x8009001E} {
		if err := classifyProviderOpen(s, nil); !errors.Is(err, ErrNoHardware) {
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
		err := classifyProviderOpen(s, func() bool { return false })
		if err == nil || errors.Is(err, ErrNoHardware) {
			t.Errorf("0x%08x: want a plain error (no fallback), got %v", s, err)
		}
	}
}

// NTE_DEVICE_NOT_READY falls back only when TBS confirms there is no TPM; an unknown or present TPM is refused.
func TestClassifyDeviceNotReady(t *testing.T) {
	if err := classifyProviderOpen(0x80090030, func() bool { return true }); !errors.Is(err, ErrNoHardware) {
		t.Fatalf("no TPM per TBS: %v", err)
	}
	for _, absent := range []func() bool{nil, func() bool { return false }} {
		if err := classifyProviderOpen(0x80090030, absent); err == nil || errors.Is(err, ErrNoHardware) {
			t.Fatalf("TPM present or unknown: %v", err)
		}
	}
}
