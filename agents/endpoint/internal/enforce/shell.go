package enforce

// Shell command lines to actions (ADR-0350 §2). The line is parsed as bash by mvdan.cc/sh (BSD-3-Clause), the same
// parser shfmt uses, so quoting, pipelines, lists, subshells, command substitutions and redirections are split the
// way a shell splits them. Every simple command becomes one exec action with its literal argv. A word that is not
// literal (a variable, a command substitution, arithmetic) makes that command unresolved; the commands inside a
// substitution are still found and decided on their own. Redirections to and from files are file actions. A small
// declared table unwraps commands that run another command (sudo, env, xargs, find -exec, sh -c, ...), and a
// second table recognises package installs. Neither table is a sandbox: see the package comment in command.go.

import (
	"path"
	"path/filepath"
	"strings"

	"mvdan.cc/sh/v3/syntax"
)

func shellActions(line string) []action {
	if len(line) > maxCommandBytes {
		return []action{{kind: "unresolved", cause: "a command line too long to check"}}
	}
	acts := parseShell(line, 0)
	// a cd changes what a relative path names, and we do not follow it: after one, a relative redirect is unresolved
	moved := false
	for _, a := range acts {
		if a.kind == "exec" && dirChangers[path.Base(a.argv[0])] {
			moved = true
		}
	}
	if moved {
		for i, a := range acts {
			if (a.kind == "read" || a.kind == "write") && !path.IsAbs(a.path) && !strings.HasPrefix(a.path, "~/") {
				acts[i] = action{kind: "unresolved", cause: "a relative file name after a change of directory"}
			}
		}
	}
	return acts
}

var dirChangers = set("cd", "pushd", "popd")

func parseShell(line string, depth int) []action {
	if depth > maxShellDepth {
		return []action{{kind: "unresolved", cause: "shells nested too deeply"}}
	}
	file, err := syntax.NewParser(syntax.Variant(syntax.LangBash)).Parse(strings.NewReader(line), "")
	if err != nil {
		return []action{{kind: "unresolved", cause: "a command line the shell parser cannot read"}}
	}
	var acts []action
	syntax.Walk(file, func(n syntax.Node) bool {
		switch x := n.(type) {
		case *syntax.Stmt:
			for _, r := range x.Redirs {
				acts = append(acts, redirectAction(r)...)
			}
		case *syntax.CallExpr:
			if len(x.Args) == 0 {
				return true // assignments only; their values are walked for substitutions
			}
			argv, ok := literalArgv(x.Args)
			if !ok {
				acts = append(acts, action{kind: "unresolved", cause: "a word that is not literal, such as a variable or a command substitution"})
				return true
			}
			acts = append(acts, argvActions(argv, depth)...)
		case *syntax.DeclClause, *syntax.LetClause, *syntax.ArithmCmd, *syntax.TestClause:
			// builtins with no program to run; their words are walked for substitutions
		case *syntax.CoprocClause:
			acts = append(acts, action{kind: "unresolved", cause: "a coprocess"})
		}
		return true
	})
	return acts
}

// literalArgv returns the words as the shell would pass them, when every word is literal.
func literalArgv(words []*syntax.Word) ([]string, bool) {
	argv := make([]string, 0, len(words))
	for _, w := range words {
		s, ok := literalWord(w)
		if !ok {
			return nil, false
		}
		argv = append(argv, s)
	}
	return argv, true
}

func literalWord(w *syntax.Word) (string, bool) {
	var b strings.Builder
	for _, p := range w.Parts {
		switch x := p.(type) {
		case *syntax.Lit:
			b.WriteString(unescape(x.Value))
		case *syntax.SglQuoted:
			if x.Dollar {
				return "", false // $'...' has escapes we do not expand
			}
			b.WriteString(x.Value)
		case *syntax.DblQuoted:
			for _, q := range x.Parts {
				l, ok := q.(*syntax.Lit)
				if !ok {
					return "", false
				}
				b.WriteString(l.Value)
			}
		default:
			return "", false
		}
	}
	return b.String(), true
}

// unescape removes the backslashes an unquoted literal keeps, as the shell does.
func unescape(s string) string {
	if !strings.Contains(s, `\`) {
		return s
	}
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] == '\\' && i+1 < len(s) {
			i++
			if s[i] == '\n' {
				continue
			}
		}
		b.WriteByte(s[i])
	}
	return b.String()
}

// harmless redirect targets: device files that read or write no file of the user's.
var deviceFiles = map[string]bool{"/dev/null": true, "/dev/stdout": true, "/dev/stderr": true, "/dev/stdin": true, "/dev/tty": true}

func redirectAction(r *syntax.Redirect) []action {
	var write bool
	switch r.Op {
	case syntax.RdrOut, syntax.AppOut, syntax.RdrAll, syntax.AppAll, syntax.RdrClob, syntax.AppClob, syntax.RdrInOut:
		write = true
	case syntax.RdrIn:
	default:
		return nil // here-documents, here-strings and fd duplication touch no file
	}
	if r.Word == nil {
		return nil
	}
	target, ok := literalWord(r.Word)
	if !ok {
		return []action{{kind: "unresolved", cause: "a redirection to a file name that is not literal"}}
	}
	if deviceFiles[target] {
		return nil
	}
	if write {
		return []action{{kind: "write", path: target}}
	}
	return []action{{kind: "read", path: target}}
}

// wrapper describes a program that runs another program from its own arguments.
type wrapper struct {
	// valueOpts take a value in the next argument
	valueOpts map[string]bool
	// positional is how many non-option arguments come before the inner command (timeout's duration)
	positional int
	// assigns: NAME=value arguments come before the inner command (env)
	assigns bool
}

func set(xs ...string) map[string]bool {
	m := map[string]bool{}
	for _, x := range xs {
		m[x] = true
	}
	return m
}

var wrappers = map[string]wrapper{
	"sudo":    {valueOpts: set("-u", "-g", "-C", "-h", "-p", "-r", "-t", "-U", "-D", "--user", "--group", "--host", "--prompt", "--chdir")},
	"doas":    {valueOpts: set("-u", "-C")},
	"env":     {valueOpts: set("-u", "-C", "--unset", "--chdir"), assigns: true},
	"nice":    {valueOpts: set("-n", "--adjustment")},
	"nohup":   {},
	"time":    {valueOpts: set("-f", "-o", "--format", "--output")},
	"timeout": {valueOpts: set("-s", "-k", "--signal", "--kill-after"), positional: 1},
	"command": {},
	"exec":    {valueOpts: set("-a")},
	"builtin": {},
	"stdbuf":  {valueOpts: set("-i", "-o", "-e")},
	"ionice":  {valueOpts: set("-c", "-n", "-p")},
	"xargs":   {valueOpts: set("-I", "-n", "-P", "-L", "-s", "-d", "-E", "-a", "--max-args", "--max-procs", "--delimiter", "--arg-file", "--replace")},
	"watch":   {valueOpts: set("-n", "-d", "--interval")},
}

var shells = set("sh", "bash", "zsh", "dash", "ksh", "mksh", "ash", "fish")

// opaque programs run code the command line does not show.
var opaque = set("eval", "source", ".", "trap")

// argvActions decides one argv: the program itself, what it wraps, and any package install it is.
func argvActions(argv []string, depth int) []action {
	acts := []action{{kind: "exec", argv: argv}}
	// a program named by a relative path (./x, ../x, dir/x) is a file in or near the workspace whose contents are not
	// seen: unresolved, as a script file is (review #941)
	if p := filepath.ToSlash(argv[0]); strings.Contains(p, "/") && !rooted(argv[0]) {
		acts = append(acts, action{kind: "unresolved", cause: "a program file named by path"})
	}
	prog := path.Base(filepath.ToSlash(argv[0]))
	switch {
	case opaque[prog]:
		acts = append(acts, action{kind: "unresolved", cause: "`" + prog + "` runs code that is not on the command line"})
	case shells[prog]:
		acts = append(acts, shellFlagC(argv, depth)...)
	case prog == "find":
		acts = append(acts, findExec(argv, depth)...)
	case prog == "env" && envSplit(argv) >= 0:
		// env -S 'cmd args' splits its value into a command line
		if i := envSplit(argv); i+1 < len(argv) {
			acts = append(acts, parseShell(argv[i+1], depth+1)...)
		} else {
			acts = append(acts, action{kind: "unresolved", cause: "env -S without a command"})
		}
	default:
		if w, ok := wrappers[prog]; ok {
			if inner := unwrap(argv[1:], w); len(inner) > 0 {
				acts = append(acts, argvActions(inner, depth)...)
			}
		}
	}
	acts = append(acts, packageActions(argv)...)
	return acts
}

func envSplit(argv []string) int {
	for i, a := range argv {
		if a == "-S" || a == "--split-string" {
			return i
		}
	}
	return -1
}

func unwrap(args []string, w wrapper) []string {
	pos := w.positional
	for i := 0; i < len(args); i++ {
		a := args[i]
		switch {
		case a == "--":
			if i+1 < len(args) {
				return args[i+1:]
			}
			return nil
		case strings.HasPrefix(a, "-") && len(a) > 1:
			if w.valueOpts[a] {
				i++
			}
		case w.assigns && strings.Contains(a, "=") && !strings.HasPrefix(a, "="):
		case pos > 0:
			pos--
		default:
			return args[i:]
		}
	}
	return nil
}

// shellFlagC parses the script of sh -c 'script' as a command line of its own. A shell started with a script file
// or stdin runs code the command line does not show.
func shellFlagC(argv []string, depth int) []action {
	for i := 1; i < len(argv); i++ {
		a := argv[i]
		if a == "-c" || (strings.HasPrefix(a, "-") && !strings.HasPrefix(a, "--") && strings.Contains(a[1:], "c")) {
			if i+1 < len(argv) {
				return parseShell(argv[i+1], depth+1)
			}
			return []action{{kind: "unresolved", cause: "a shell started without a script"}}
		}
		if !strings.HasPrefix(a, "-") {
			break
		}
	}
	return []action{{kind: "unresolved", cause: "a shell running a script file or standard input"}}
}

// findExec decides the commands find -exec, -execdir, -ok and -okdir run.
func findExec(argv []string, depth int) []action {
	var acts []action
	for i := 1; i < len(argv); i++ {
		switch argv[i] {
		case "-exec", "-execdir", "-ok", "-okdir":
			j := i + 1
			for j < len(argv) && argv[j] != ";" && argv[j] != "+" {
				j++
			}
			if j > i+1 {
				acts = append(acts, argvActions(argv[i+1:j], depth)...)
			}
			i = j
		}
	}
	return acts
}
