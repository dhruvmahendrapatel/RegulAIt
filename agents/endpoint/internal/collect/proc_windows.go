//go:build windows

package collect

import (
	"encoding/binary"
	"errors"
	"unsafe"

	"golang.org/x/sys/windows"
)

// processTable on Windows uses x/sys/windows directly, not gopsutil: gopsutil links github.com/yusufpapurcu/wmi and
// github.com/go-ole/go-ole on Windows, whose last releases (2024-01 and 2023-08) fail ADR-0176's 12-month rule.
// Processes come from a Toolhelp snapshot, listeners from GetExtendedTcpTable (iphlpapi), which gives the owning
// PID of every listener without elevation (R15 §2.2).
type processTable struct{}

var (
	iphlpapi                = windows.NewLazySystemDLL("iphlpapi.dll")
	procGetExtendedTcpTable = iphlpapi.NewProc("GetExtendedTcpTable")
)

const tcpTableOwnerPIDListener = 3 // TCP_TABLE_OWNER_PID_LISTENER

func snapshotNames() (map[uint32]string, error) {
	snap, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return nil, err
	}
	defer windows.CloseHandle(snap)
	names := map[uint32]string{}
	var e windows.ProcessEntry32
	e.Size = uint32(unsafe.Sizeof(e))
	for err = windows.Process32First(snap, &e); err == nil; err = windows.Process32Next(snap, &e) {
		names[e.ProcessID] = windows.UTF16ToString(e.ExeFile[:])
	}
	if !errors.Is(err, windows.ERROR_NO_MORE_FILES) {
		return nil, err
	}
	return names, nil
}

func (processTable) Processes() ([]Process, error) {
	names, err := snapshotNames()
	if err != nil {
		return nil, err
	}
	out := make([]Process, 0, len(names))
	for pid, n := range names {
		if n != "" {
			out = append(out, Process{PID: int32(pid), Name: n})
		}
	}
	return out, nil
}

// tcpTable returns the listener table for one address family: AF_INET rows are 24 bytes, AF_INET6 rows 56, and
// in both the local port (network byte order) and the owning PID sit at fixed offsets.
func tcpTable(family uint32) ([]byte, error) {
	var size uint32
	for i := 0; i < 4; i++ {
		var buf []byte
		var p uintptr
		if size > 0 {
			buf = make([]byte, size)
			p = uintptr(unsafe.Pointer(&buf[0]))
		}
		r, _, _ := procGetExtendedTcpTable.Call(p, uintptr(unsafe.Pointer(&size)), 0, uintptr(family), tcpTableOwnerPIDListener, 0)
		switch windows.Errno(r) {
		case 0:
			return buf[:size], nil
		case windows.ERROR_INSUFFICIENT_BUFFER:
			continue
		default:
			return nil, windows.Errno(r)
		}
	}
	return nil, errors.New("the TCP table kept growing")
}

func (processTable) Listeners() ([]Listener, error) {
	names, err := snapshotNames()
	if err != nil {
		return nil, err
	}
	seen := map[int]bool{}
	var out []Listener
	for _, fam := range []struct {
		af             uint32
		row, port, pid int
	}{{windows.AF_INET, 24, 8, 20}, {windows.AF_INET6, 56, 20, 52}} {
		buf, err := tcpTable(fam.af)
		if err != nil {
			return nil, err
		}
		if len(buf) < 4 {
			continue
		}
		n := int(binary.LittleEndian.Uint32(buf[0:4]))
		for i := 0; i < n; i++ {
			off := 4 + i*fam.row
			if off+fam.row > len(buf) {
				break
			}
			row := buf[off : off+fam.row]
			port := int(binary.BigEndian.Uint16(row[fam.port : fam.port+2]))
			pid := binary.LittleEndian.Uint32(row[fam.pid : fam.pid+4])
			if seen[port] {
				continue
			}
			seen[port] = true
			out = append(out, Listener{Port: port, Name: names[pid]})
		}
	}
	return out, nil
}
