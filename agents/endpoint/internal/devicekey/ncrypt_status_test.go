package devicekey

import (
	"errors"
	"testing"
)

func tbsSays(present bool, err error) func() (bool, error) {
	return func() (bool, error) { return present, err }
}

// Only "no TPM" answers allow the DPAPI fallback; every other status is an error that is not ErrNoHardware.
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
		0x8009001D, // NTE_PROVIDER_DLL_FAIL
		0x80090020, // NTE_FAIL
		0x80090016, // NTE_BAD_KEYSET
		0x80290201, // TPM_E_PCP_DEVICE_NOT_READY
		0x80070005, // E_ACCESSDENIED
		0xFFFFFFFF,
	} {
		// TBS is not consulted for unambiguous statuses, even when it would say "no TPM"
		err := classifyProviderOpen(s, tbsSays(false, nil))
		if err == nil || errors.Is(err, ErrNoHardware) {
			t.Errorf("0x%08x: want a plain error (no fallback), got %v", s, err)
		}
	}
}

// The ambiguous statuses fall back only when TBS answers TBS_E_TPM_NOT_FOUND.
func TestClassifyAmbiguousAsksTBS(t *testing.T) {
	cases := []struct {
		name       string
		status     uint32
		tpmPresent func() (bool, error)
		noHardware bool
	}{
		{"CI runner: NTE_DEVICE_NOT_READY + TBS no TPM", 0x80090030, tbsSays(false, nil), true},
		{"TBS_E_TPM_NOT_FOUND passed through + TBS no TPM", 0x8028400F, tbsSays(false, nil), true},
		{"NTE_DEVICE_NOT_READY + TPM present", 0x80090030, tbsSays(true, nil), false},
		{"NTE_DEVICE_NOT_READY + TBS error", 0x80090030, tbsSays(false, errors.New("TBS_E_INTERNAL_ERROR")), false},
		{"NTE_DEVICE_NOT_READY + no probe", 0x80090030, nil, false},
		{"TBS_E_TPM_NOT_FOUND + TPM present", 0x8028400F, tbsSays(true, nil), false},
		{"TBS_E_TPM_NOT_FOUND + TBS error", 0x8028400F, tbsSays(false, errors.New("tbs.dll missing")), false},
	}
	for _, c := range cases {
		err := classifyProviderOpen(c.status, c.tpmPresent)
		if err == nil {
			t.Errorf("%s: want an error", c.name)
		} else if errors.Is(err, ErrNoHardware) != c.noHardware {
			t.Errorf("%s: noHardware=%v, got %v", c.name, c.noHardware, err)
		}
	}
}

// Tbsi_GetDeviceInfo: success is a TPM, TBS_E_TPM_NOT_FOUND is none, anything else is an error.
func TestTBSAnswer(t *testing.T) {
	if p, err := tbsAnswer(0); !p || err != nil {
		t.Errorf("success: %v %v", p, err)
	}
	if p, err := tbsAnswer(0x8028400F); p || err != nil {
		t.Errorf("not found: %v %v", p, err)
	}
	for _, r := range []uint32{0x80284001, 0x80284002, 0x80284008, 0xFFFFFFFF} {
		if _, err := tbsAnswer(r); err == nil {
			t.Errorf("0x%08x: want an error", r)
		}
	}
}
