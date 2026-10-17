// SD4 spike: run a binary and print its peak resident set size (ru_maxrss, KiB on Linux).
// Go starts children with vfork semantics, so the parent's memory is not counted in the child.
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
