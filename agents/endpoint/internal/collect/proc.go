//go:build !windows

package collect

import (
	"github.com/shirou/gopsutil/v4/net"
	"github.com/shirou/gopsutil/v4/process"
)

// processTable reads processes and listeners through gopsutil (BSD-3-Clause), as the agent's user. Other users'
// sockets carry no owner the user may read, so their Name stays "".
type processTable struct{}

func (processTable) Processes() ([]Process, error) {
	procs, err := process.Processes()
	if err != nil {
		return nil, err
	}
	out := make([]Process, 0, len(procs))
	for _, p := range procs {
		name, err := p.Name()
		if err != nil || name == "" {
			continue
		}
		out = append(out, Process{PID: p.Pid, Name: name})
	}
	return out, nil
}

func (processTable) Listeners() ([]Listener, error) {
	conns, err := net.Connections("tcp")
	if err != nil {
		return nil, err
	}
	names := map[int32]string{}
	seen := map[int]bool{}
	var out []Listener
	for _, c := range conns {
		if c.Status != "LISTEN" || seen[int(c.Laddr.Port)] {
			continue
		}
		seen[int(c.Laddr.Port)] = true
		name := ""
		if c.Pid > 0 {
			if n, ok := names[c.Pid]; ok {
				name = n
			} else if p, err := process.NewProcess(c.Pid); err == nil {
				if n, err := p.Name(); err == nil {
					name = n
				}
				names[c.Pid] = name
			}
		}
		out = append(out, Listener{Port: int(c.Laddr.Port), Name: name})
	}
	return out, nil
}
