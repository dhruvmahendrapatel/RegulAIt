package collect

import (
	"os"
	"strings"

	"golang.org/x/sys/windows/registry"

	"github.com/dhruvmahendrapatel/regulait/agents/endpoint/internal/contract"
)

func platformRoots() map[contract.Root]string {
	return map[contract.Root]string{contract.RootAppData: os.Getenv("APPDATA"), contract.RootLocalAppData: os.Getenv("LOCALAPPDATA")}
}

func platformPlistToXML() func([]byte) ([]byte, error) { return nil }

func platformRegistry() Registry { return winRegistry{} }

// winRegistry reads the uninstall and environment keys, read-only. HKLM is readable by users without elevation.
type winRegistry struct{}

const uninstallPath = `Software\Microsoft\Windows\CurrentVersion\Uninstall`

var views = []struct {
	name string
	key  registry.Key
}{{"HKLM", registry.LOCAL_MACHINE}, {"HKCU", registry.CURRENT_USER}}

func (winRegistry) Uninstall() ([]UninstallEntry, error) {
	var out []UninstallEntry
	opened := 0
	for _, v := range views {
		for _, base := range []string{uninstallPath, `Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall`} {
			k, err := registry.OpenKey(v.key, base, registry.READ)
			if err != nil {
				continue
			}
			opened++
			names, _ := k.ReadSubKeyNames(maxListing)
			for _, n := range names {
				sk, err := registry.OpenKey(k, n, registry.QUERY_VALUE)
				if err != nil {
					continue
				}
				dn, _, _ := sk.GetStringValue("DisplayName")
				ver, _, _ := sk.GetStringValue("DisplayVersion")
				sk.Close()
				if strings.TrimSpace(dn) != "" {
					out = append(out, UninstallEntry{View: v.name, Key: base + `\` + n, DisplayName: dn, Version: ver})
				}
			}
			k.Close()
		}
	}
	if opened == 0 {
		return nil, registry.ErrNotExist
	}
	return out, nil
}

func (winRegistry) Environment() ([]EnvValue, error) {
	var out []EnvValue
	paths := map[string]string{"HKCU": `Environment`, "HKLM": `SYSTEM\CurrentControlSet\Control\Session Manager\Environment`}
	for _, v := range views {
		k, err := registry.OpenKey(v.key, paths[v.name], registry.QUERY_VALUE)
		if err != nil {
			continue
		}
		names, _ := k.ReadValueNames(maxListing)
		for _, n := range names {
			val, _, err := k.GetStringValue(n)
			if err != nil {
				continue
			}
			out = append(out, EnvValue{View: v.name, Name: n, Value: val})
		}
		k.Close()
	}
	return out, nil
}
