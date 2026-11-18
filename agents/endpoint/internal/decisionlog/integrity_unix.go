//go:build !windows

package decisionlog

// windowsProgramDirs are the documented defaults, for DefaultManagedFiles("windows") on another OS (tests); on
// Windows the known-folder API resolves them (integrity_windows.go).
func windowsProgramDirs() (programData, programFiles string) {
	return `C:\ProgramData`, `C:\Program Files`
}
