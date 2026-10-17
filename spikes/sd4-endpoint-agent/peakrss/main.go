// SD4 spike: run a binary and print its peak resident set size (ru_maxrss, KiB on Linux).
// Caveat: Linux counts this helper's own resident memory in the child's peak (the child shares
// the parent's address space until exec), so results near the helper's own RSS are a floor, not
// the child's real figure. In the spike run the floor was 2,388 KiB.
package main

import (
	"fmt"
	"os"
	"os/exec"
	"syscall"
)

func main() {
	for _, bin := range os.Args[1:] {
		cmd := exec.Command(bin)
		if err := cmd.Run(); err != nil {
			fmt.Printf("%s error=%v\n", bin, err)
			continue
		}
		ru := cmd.ProcessState.SysUsage().(*syscall.Rusage)
		fmt.Printf("%s peak_rss_kib=%d\n", bin, ru.Maxrss)
	}
}
