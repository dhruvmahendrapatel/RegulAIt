//go:build windows

package decisionlog

import "golang.org/x/sys/windows"

// windowsProgramDirs resolves ProgramData and Program Files with the known-folder API (SHGetKnownFolderPath), never
// the environment, which the user controls. A folder that cannot be resolved is empty, so its files read unreadable.
func windowsProgramDirs() (programData, programFiles string) {
	programData, err := windows.KnownFolderPath(windows.FOLDERID_ProgramData, 0)
	if err != nil {
		programData = ""
	}
	programFiles, err = windows.KnownFolderPath(windows.FOLDERID_ProgramFiles, 0)
	if err != nil {
		programFiles = ""
	}
	return programData, programFiles
}
