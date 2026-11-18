package enforce

// What an HTTP client or a gh command on a command line will do (ADR-0350 §9, review #952). Each parser reads the
// whole argv against a declared option table. It returns every URL the command calls, every local file it reads or
// writes, and two flags:
//   - complete: every argument was understood. An HTTP client argv that is not complete is unresolved (ask or deny):
//     a catalogue deny is never bypassed by an option this table does not know.
//   - exact: the call goes only to its one URL. There is no second URL, no proxy or resolver override, and TLS is not
//     disabled. Only an exact, complete call may let an action "allow" relax the default for commands.
// The local files a call reads or writes are emitted as file actions, so the file rules decide them. A call may be
// allowed, but it never reads /etc/shadow or writes /etc/cron.d unchecked.
//
// No maintained Go module parses curl, wget, httpie or gh argv the way the tool itself does. curlconverter (MIT, JS)
// covers curl only, needs a JS runtime on the device and does not report file I/O (PR body, ADR-0350 §8).

import (
	"net/url"
	"path"
	"slices"
	"strings"
)

// clientCall is one parsed HTTP client argv.
type clientCall struct {
	method   string
	urls     []string
	files    []action
	complete bool
	exact    bool
}

// option kinds shared by the parsers
const (
	oBool       = iota // a flag
	oValue             // a value that is neither a URL, a method nor a file
	oMethod            // the HTTP method
	oURL               // a URL
	oGet               // curl -G: data goes into the query, method GET
	oHead              // curl -I
	oData              // request data; a leading @ names a file to read
	oDataRaw           // request data that is never a file
	oDataURL           // curl --data-urlencode: [name]@file reads a file
	oForm              // curl -F: name=@file or name=<file reads a file
	oUpload            // curl -T: a file to read and upload (PUT)
	oHeader            // a header; a leading @ names a file to read
	oCookie            // curl -b: a value without = names a cookie file to read
	oRead              // a file to read
	oWrite             // a file to write ("-" is stdout)
	oRemoteName        // write a file named after the URL into the working directory
	oNoGlob            // curl -g: no URL globbing
	oRedirect          // a value that changes where the call goes (proxy, resolve, socket)
	oInsecure          // a flag that turns off TLS verification
	oFanOut            // a flag that makes the call reach more than its URL (recursion, span hosts)
	oPostData          // wget --post-data / --body-data: data, method POST unless --method
	oPostFile          // wget --post-file / --body-file: a file to read, method POST unless --method
	oNoConfig          // wget --no-config: no wgetrc
	oUnknownV          // understood but not checkable, with a value (config file, input list, execute)
	oUnknown           // understood but not checkable, a flag (--next)
)

type opt struct {
	kind  int
	value bool
}

func optTable(kind int, value bool, names ...string) map[string]opt {
	m := map[string]opt{}
	for _, n := range names {
		m[n] = opt{kind, value}
	}
	return m
}

func merge(ms ...map[string]opt) map[string]opt {
	out := map[string]opt{}
	for _, m := range ms {
		for k, v := range m {
			out[k] = v
		}
	}
	return out
}

var curlOpts = merge(
	optTable(oBool, false, "-V", "--version", "-h", "--help", "-s", "--silent", "-S", "--show-error", "-L", "--location", "-f", "--fail", "--fail-with-body",
		"--fail-early", "-v", "--verbose", "-i", "--include", "-N", "--no-buffer", "-#", "--progress-bar",
		"--no-progress-meter", "--compressed", "-0", "--http1.0", "--http1.1", "--http2", "--http2-prior-knowledge",
		"--http3", "-4", "--ipv4", "-6", "--ipv6", "-j", "--junk-session-cookies", "-l", "--list-only", "-n", "--netrc",
		"--netrc-optional", "-R", "--remote-time", "-M", "--manual", "-q", "--disable", "-J", "--remote-header-name",
		"--create-dirs", "--path-as-is", "--post301", "--post302", "--post303", "--retry-all-errors",
		"--retry-connrefused", "--raw", "--tcp-nodelay", "--no-keepalive", "--no-sessionid",
		"--digest", "--basic", "--ntlm", "--negotiate", "--anyauth", "--styled-output", "--no-styled-output",
		"--crlf", "--ignore-content-length", "--no-clobber", "--remove-on-error", "--ssl", "--ssl-reqd", "-1",
		"--tlsv1", "--tlsv1.0", "--tlsv1.1", "--tlsv1.2", "--tlsv1.3", "--cert-status", "--suppress-connect-headers",
		"--fail-early", "-a", "--append", "-B", "--use-ascii", "-p", "--proxytunnel", "--skip-existing"),
	optTable(oValue, true, "-u", "--user", "-A", "--user-agent", "-e", "--referer", "-m",
		"--max-time", "--connect-timeout", "--retry", "--retry-delay", "--retry-max-time",
		"--cert-type", "--key-type", "--pass", "-r", "--range", "--limit-rate",
		"--max-filesize", "--max-redirs", "--oauth2-bearer", "--keepalive-time", "-y", "--speed-limit", "-Y",
		"--speed-time", "--expect100-timeout", "--ciphers", "--tls13-ciphers", "--noproxy",
		"--aws-sigv4", "--proto", "--proto-redir", "--proto-default", "-C", "--continue-at", "--rate", "--parallel-max", "--tls-max", "--curves", "--create-file-mode",
		"--local-port", "--interface", "-t", "--telnet-option", "-Q", "--quote", "-P", "--ftp-port",
		"-U", "--proxy-user"),
	optTable(oMethod, true, "-X", "--request"),
	optTable(oURL, true, "--url"),
	optTable(oGet, false, "-G", "--get"),
	optTable(oHead, false, "-I", "--head"),
	optTable(oData, true, "-d", "--data", "--data-binary", "--data-ascii", "--json"),
	optTable(oDataRaw, true, "--data-raw", "--form-string"),
	optTable(oDataURL, true, "--data-urlencode"),
	optTable(oForm, true, "-F", "--form"),
	optTable(oUpload, true, "-T", "--upload-file"),
	optTable(oHeader, true, "-H", "--header", "--proxy-header"),
	optTable(oCookie, true, "-b", "--cookie"),
	// every option whose value may name a local file curl reads (review #952): the file rules decide it
	optTable(oRead, true, "--netrc-file", "--etag-compare", "--cacert", "--capath", "-E", "--cert", "--key",
		"--pinnedpubkey", "-z", "--time-cond"),
	optTable(oHeader, true, "-w", "--write-out"), // -w @file reads a format file
	optTable(oDataURL, true, "--url-query"),
	optTable(oWrite, true, "-o", "--output", "-D", "--dump-header", "-c", "--cookie-jar", "--trace", "--trace-ascii",
		"--stderr", "--etag-save", "--libcurl"),
	optTable(oRemoteName, false, "-O", "--remote-name", "--remote-name-all"),
	optTable(oNoGlob, false, "-g", "--globoff"),
	optTable(oRedirect, true, "--request-target", "-x", "--proxy", "--preproxy", "--socks4", "--socks4a", "--socks5", "--socks5-hostname",
		"--resolve", "--connect-to", "--unix-socket", "--abstract-unix-socket", "--doh-url", "--dns-servers"),
	optTable(oInsecure, false, "-k", "--insecure", "--proxy-insecure", "--doh-insecure", "--location-trusted"),
	optTable(oUnknownV, true, "-K", "--config", "--variable", "--output-dir"),
	optTable(oUnknown, false, "-:", "--next", "-Z", "--parallel"),
)

// infoOpts print the client's own version or help and call no URL
var infoOpts = set("-V", "--version", "-h", "--help")

var wgetOpts = merge(
	optTable(oBool, false, "-q", "--quiet", "-v", "--verbose", "-nv", "--no-verbose", "-S", "--server-response",
		"--spider", "-c", "--continue", "-N", "--timestamping", "-4", "--inet4-only", "-6", "--inet6-only", "-nc",
		"--no-clobber", "--content-disposition", "--no-cookies", "--ignore-length", "--no-cache", "--no-dns-cache",
		"--auth-no-challenge", "--https-only", "--show-progress", "--no-proxy", "--debug", "-d", "--no-hsts",
		"-V", "--version", "-h", "--help"),
	optTable(oNoConfig, false, "--no-config"),
	optTable(oValue, true, "-U", "--user-agent", "--user", "--password", "--http-user", "--http-password", "-t",
		"--tries", "-T", "--timeout", "-w", "--wait", "-Q", "--quota", "--limit-rate", "--referer", "--ca-certificate",
		"--certificate", "--private-key", "--max-redirect", "--progress", "--retry-on-http-error"),
	optTable(oMethod, true, "--method"),
	optTable(oHeader, true, "--header"),
	optTable(oPostData, true, "--post-data", "--body-data"),
	optTable(oPostFile, true, "--post-file", "--body-file"),
	optTable(oRead, true, "--load-cookies"),
	optTable(oWrite, true, "-O", "--output-document", "-o", "--output-file", "-a", "--append-output",
		"--save-cookies"),
	optTable(oRedirect, true, "-e", "--execute", "--bind-address"),
	optTable(oInsecure, false, "--no-check-certificate"),
	optTable(oFanOut, false, "-r", "--recursive", "-m", "--mirror", "-p", "--page-requisites", "-H", "--span-hosts"),
	optTable(oUnknownV, true, "-i", "--input-file", "-P", "--directory-prefix", "--config", "-B", "--base"),
)

var httpieOpts = merge(
	optTable(oBool, false, "-v", "--verbose", "-h", "--headers", "-b", "--body", "-j", "--json", "-f", "--form",
		"--multipart", "-F", "--follow", "-I", "--ignore-stdin", "-q", "--quiet", "-x", "--compress", "--offline",
		"--check-status", "-S", "--stream", "--all", "--ignore-netrc", "--chunked", "--debug", "--traceback"),
	optTable(oValue, true, "-p", "--print", "-P", "--history-print", "-s", "--style", "-a", "--auth", "-A",
		"--auth-type", "--cert", "--cert-key", "--timeout", "--max-redirects", "--pretty", "--format-options",
		"--response-charset", "--response-mime", "--boundary", "--ssl", "--ciphers", "--default-scheme"),
	optTable(oDataRaw, true, "--raw"),
	optTable(oWrite, true, "-o", "--output"),
	optTable(oRemoteName, false, "-d", "--download"),
	optTable(oRedirect, true, "--proxy"),
	optTable(oInsecure, true, "--verify"),
	optTable(oUnknownV, true, "--session", "--session-read-only"),
)

var ghAPIOpts = merge(
	optTable(oBool, false, "-i", "--include", "--paginate", "--slurp", "--silent", "--verbose"),
	optTable(oValue, true, "-q", "--jq", "-t", "--template", "--cache", "-p", "--preview", "--hostname"),
	optTable(oMethod, true, "-X", "--method"),
	optTable(oHeader, true, "-H", "--header"),
	optTable(oDataRaw, true, "-f", "--raw-field"),
	optTable(oData, true, "-F", "--field"),
	optTable(oRead, true, "--input"),
)

// parseOpts walks args against table. on gets each option and its value; positional gets each other argument.
// Short options bundle (-sSL, -XPOST, -qO-). It reports false when an argument is not in the table.
func parseOpts(args []string, table map[string]opt, on func(name string, o opt, v string), positional func(string)) bool {
	ok := true
	for i := 0; i < len(args); i++ {
		a := args[i]
		switch {
		case a == "--":
			for _, p := range args[i+1:] {
				positional(p)
			}
			return ok
		case strings.HasPrefix(a, "--"):
			name, v, hasV := strings.Cut(a, "=")
			o, known := table[name]
			if !known {
				ok = false
				continue
			}
			if o.value && !hasV {
				if i+1 >= len(args) {
					return false
				}
				i++
				v = args[i]
			}
			on(name, o, v)
		case strings.HasPrefix(a, "-") && len(a) > 1:
			if o, known := table[a]; known { // a multi-letter short option (wget -nv) or a single one
				if o.value {
					if i+1 >= len(args) {
						return false
					}
					i++
					on(a, o, args[i])
				} else {
					on(a, o, "")
				}
				continue
			}
			for j := 1; j < len(a); j++ {
				name := "-" + a[j:j+1]
				o, known := table[name]
				if !known {
					ok = false
					break
				}
				if !o.value {
					on(name, o, "")
					continue
				}
				v := a[j+1:]
				if v == "" {
					if i+1 >= len(args) {
						return false
					}
					i++
					v = args[i]
				}
				on(name, o, v)
				break
			}
		default:
			positional(a)
		}
	}
	return ok
}

// fileValue is the file a data value names after a leading @ ("@-" is standard input).
func fileValue(v string) string {
	if f, ok := strings.CutPrefix(v, "@"); ok && f != "-" && f != "" {
		return f
	}
	return ""
}

func readAct(p string) action  { return action{kind: "read", path: p} }
func writeAct(p string) action { return action{kind: "write", path: p} }

// httpClient parses argv when argv[0] is an HTTP client; ok is false for any other program.
func httpClient(argv []string) (clientCall, bool) {
	switch path.Base(argv[0]) {
	case "curl":
		return curlCall(argv[1:]), true
	case "wget":
		return wgetCall(argv[1:]), true
	case "http", "https", "xh", "xhs":
		return httpieCall(argv), true
	case "gh":
		if g := ghWords(argv); len(g.words) > 0 && g.words[0] == "api" {
			return ghAPICall(g), true
		}
	}
	return clientCall{}, false
}

func curlCall(args []string) clientCall {
	// exact only with -q (--disable) first: otherwise curl reads a .curlrc from $CURL_HOME, $XDG_CONFIG_HOME or
	// $HOME, which can add URLs, uploads and proxies this argv does not show (review #952)
	c := clientCall{exact: len(args) > 0 && (args[0] == "-q" || args[0] == "--disable")}
	unread := false // an option that is read but cannot be checked (a config file, a second request)
	method, data, get, remote, glob := "", false, false, false, true
	c.complete = parseOpts(args, curlOpts, func(name string, o opt, v string) {
		switch o.kind {
		case oMethod:
			method = v
		case oURL:
			c.urls = append(c.urls, v)
		case oGet:
			get = true
		case oHead:
			method = "HEAD"
		case oData:
			data = true
			if f := fileValue(v); f != "" {
				c.files = append(c.files, readAct(f))
			}
		case oDataRaw:
			data = true
		case oDataURL:
			data = true
			if i := strings.IndexByte(v, '@'); i >= 0 && !strings.Contains(v[:i], "=") && v[i+1:] != "-" {
				c.files = append(c.files, readAct(v[i+1:]))
			}
		case oForm:
			data = true
			if _, val, ok := strings.Cut(v, "="); ok && (strings.HasPrefix(val, "@") || strings.HasPrefix(val, "<")) {
				f, _, _ := strings.Cut(val[1:], ";")
				if f != "-" && f != "" {
					c.files = append(c.files, readAct(f))
				}
			}
		case oUpload:
			if method == "" {
				method = "PUT"
			}
			if v != "-" && v != "." {
				c.files = append(c.files, readAct(v))
			}
		case oHeader:
			if f := fileValue(v); f != "" {
				c.files = append(c.files, readAct(f))
			}
			if name, _, _ := strings.Cut(v, ":"); strings.EqualFold(strings.TrimSpace(name), "host") {
				c.exact = false // a Host header sends the request to another virtual host
			}
		case oCookie:
			if !strings.Contains(v, "=") && v != "-" {
				c.files = append(c.files, readAct(v))
			}
		case oRead:
			if !strings.HasPrefix(v, "sha256//") { // --pinnedpubkey takes a hash or a key file
				c.files = append(c.files, readAct(v))
			}
		case oWrite:
			if v != "-" {
				c.files = append(c.files, writeAct(v))
			}
		case oRemoteName:
			remote = true
		case oNoGlob:
			glob = false
		case oRedirect, oInsecure:
			c.exact = false
		case oUnknownV, oUnknown:
			unread = true
		}
	}, func(p string) { c.urls = append(c.urls, p) }) && !unread
	if len(c.urls) == 0 && !slices.ContainsFunc(args, func(a string) bool { return infoOpts[a] }) {
		c.complete = false // the URL comes from somewhere this argv does not show (stdin, xargs, a config file)
	}
	for i, u := range c.urls {
		if glob && strings.ContainsAny(u, "{[") {
			c.complete = false // URL globbing expands to more URLs than the argv shows
		}
		if !strings.Contains(u, "://") {
			c.urls[i] = "http://" + u // curl's default scheme
		}
	}
	if remote {
		c.complete = c.complete && remoteNames(&c)
	}
	switch {
	case method != "":
	case get:
		method = "GET"
	case data:
		method = "POST"
	default:
		method = "GET"
	}
	c.method = strings.ToUpper(method)
	return c
}

// remoteNames adds the file each URL is saved as in the working directory; false when a URL has no file name.
func remoteNames(c *clientCall) bool {
	for _, raw := range c.urls {
		u, err := url.Parse(raw)
		if err != nil {
			return false
		}
		name := path.Base(u.Path)
		if name == "/" || name == "." || name == "" {
			return false
		}
		c.files = append(c.files, writeAct(name))
	}
	return true
}

func wgetCall(args []string) clientCall {
	// exact only with --no-config: otherwise wget reads $WGETRC or ~/.wgetrc, which can add proxies and uploads
	c := clientCall{exact: slices.Contains(args, "--no-config")}
	unread := false // an option that is read but cannot be checked (a config file, a second request)
	method, post, output := "", false, false
	c.complete = parseOpts(args, wgetOpts, func(name string, o opt, v string) {
		switch o.kind {
		case oMethod:
			method = v
		case oPostData:
			post = true
		case oPostFile:
			post = true
			c.files = append(c.files, readAct(v))
		case oHeader:
		case oRead:
			c.files = append(c.files, readAct(v))
		case oWrite:
			if name == "-O" || name == "--output-document" {
				output = true
			}
			if v != "-" {
				c.files = append(c.files, writeAct(v))
			}
		case oRedirect, oInsecure, oFanOut:
			c.exact = false
		case oUnknownV, oUnknown:
			unread = true
		}
	}, func(p string) {
		if !strings.Contains(p, "://") {
			p = "http://" + p
		}
		c.urls = append(c.urls, p)
	}) && !unread
	if len(c.urls) == 0 && !slices.ContainsFunc(args, func(a string) bool { return infoOpts[a] }) {
		c.complete = false // the URL comes from somewhere this argv does not show
	}
	if !output {
		c.complete = c.complete && remoteNames(&c) // wget saves each URL into the working directory
	}
	switch {
	case method != "":
	case post:
		method = "POST"
	default:
		method = "GET"
	}
	c.method = strings.ToUpper(method)
	return c
}

// httpie request items, longest separator first (httpie's own order)
var httpieSeps = []string{":=@", "=@", "==", ":=", "=", "@", ":"}

func httpieCall(argv []string) clientCall {
	// never exact: httpie and xh read default options from a config file ($HTTPIE_CONFIG_DIR, $XH_CONFIG_DIR) and
	// have no option to skip it, so an action rule only tightens their calls (review #952)
	c := clientCall{}
	unread := false // an option that is read but cannot be checked (a config file, a second request)
	method, data, download := "", false, false
	var pos []string
	c.complete = parseOpts(argv[1:], httpieOpts, func(name string, o opt, v string) {
		switch o.kind {
		case oDataRaw:
			data = true
		case oWrite:
			if v != "-" {
				c.files = append(c.files, writeAct(v))
			}
		case oRemoteName:
			download = true
		case oRedirect:
			c.exact = false
		case oInsecure: // --verify=no turns TLS verification off; a CA bundle path keeps it on
			if v == "no" || v == "false" {
				c.exact = false
			}
		case oUnknownV:
			unread = true
		}
	}, func(p string) { pos = append(pos, p) }) && !unread
	if len(pos) > 1 && httpMethods[strings.ToUpper(pos[0])] {
		method, pos = pos[0], pos[1:]
	}
	if len(pos) == 0 {
		c.complete = false
		return c
	}
	raw := pos[0]
	switch {
	case strings.HasPrefix(raw, ":"):
		raw = "http://localhost" + raw
	case !strings.Contains(raw, "://"):
		scheme := "http://"
		if b := path.Base(argv[0]); b == "https" || b == "xhs" {
			scheme = "https://"
		}
		raw = scheme + raw
	}
	c.urls = []string{raw}
	for _, item := range pos[1:] {
		sep, at := "", -1
		for _, s := range httpieSeps {
			if i := strings.Index(item, s); i > 0 && (at < 0 || i < at) {
				sep, at = s, i
			}
		}
		switch sep {
		case "":
			c.complete = false // not a request item: httpie would refuse it
		case ":=@", "=@", "@":
			data = true
			if f := item[at+len(sep):]; f != "" && f != "-" {
				c.files = append(c.files, readAct(f))
			}
		case ":=", "=":
			data = true
		}
	}
	if download && c.complete {
		c.complete = remoteNames(&c)
	}
	switch {
	case method != "":
	case data:
		method = "POST"
	default:
		method = "GET"
	}
	c.method = strings.ToUpper(method)
	return c
}

var httpMethods = set("GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS")

// gh's repository placeholders, each one path segment
var ghPlaceholders = strings.NewReplacer("{owner}", "_", "{repo}", "_", "{branch}", "_")

func ghAPICall(g ghArgv) clientCall {
	c := clientCall{exact: !g.early}
	method, host, data, endpoint := "", "api.github.com", false, ""
	var extra []string
	c.complete = parseOpts(g.rest, ghAPIOpts, func(name string, o opt, v string) {
		switch o.kind {
		case oMethod:
			method = v
		case oValue:
			if name == "--hostname" {
				host = "api." + v
			}
		case oData:
			data = true
			if _, val, ok := strings.Cut(v, "="); ok {
				if f := fileValue(val); f != "" {
					c.files = append(c.files, readAct(f))
				}
			}
		case oDataRaw:
			data = true
		case oRead:
			data = true
			if v != "-" {
				c.files = append(c.files, readAct(v))
			}
		}
	}, func(p string) {
		if endpoint == "" {
			endpoint = p
		} else {
			extra = append(extra, p)
		}
	})
	if len(extra) > 0 || endpoint == "" {
		c.complete = false
		return c
	}
	if endpoint == "graphql" {
		return c // a GraphQL call: no REST URL, and no catalogue action (ADR-0350 §9)
	}
	endpoint = ghPlaceholders.Replace(endpoint)
	if strings.ContainsAny(endpoint, "{}") {
		c.complete = false
		return c
	}
	if strings.Contains(endpoint, "://") {
		c.urls = []string{endpoint}
	} else {
		c.urls = []string{"https://" + host + "/" + strings.TrimPrefix(endpoint, "/")}
	}
	switch {
	case method != "":
	case data:
		method = "POST"
	default:
		method = "GET"
	}
	c.method = strings.ToUpper(method)
	return c
}

// ghArgv is a gh argv with its repository flag lifted out: the command words, then everything after them.
type ghArgv struct {
	words []string
	rest  []string
	// early: a --flag=value or -fVALUE came before the command words (gh still runs the command); it is not read,
	// so the call is not exact. lost: a flag before the words whose shape does not say whether it takes the next
	// argument, so the command words cannot be placed (review #952): the call is unresolved.
	early, lost bool
}

// ghWords splits gh's command words (gist create, pr merge, api) from the arguments after them. A -R/--repo
// written before the words is dropped: it names the repository, not the action.
func ghWords(argv []string) ghArgv {
	var g ghArgv
	args, need := argv[1:], 2
	for i := 0; i < len(args); i++ {
		a := args[i]
		if len(g.words) == need {
			g.rest = args[i:]
			return g
		}
		switch {
		case a == "-R" || a == "--repo":
			i++
		case strings.HasPrefix(a, "--repo=") || (strings.HasPrefix(a, "-R") && len(a) > 2):
		case (strings.HasPrefix(a, "--") && strings.Contains(a, "=")) || (!strings.HasPrefix(a, "--") && strings.HasPrefix(a, "-") && len(a) > 2):
			g.early = true // cobra skips a flag that carries its own value while it looks for the command
		case strings.HasPrefix(a, "-"):
			g.lost = true
			g.rest = args[i:]
			return g
		default:
			g.words = append(g.words, a)
			if a == "api" && len(g.words) == 1 {
				need = 1
			}
		}
	}
	return g
}

// ghCommand is what one gh command reads. files options and file positionals are local files the command sends.
type ghCommand struct {
	opts            map[string]opt
	positionals     int // the most positionals the command takes; -1 for any number
	positionalFiles bool
}

var ghCommands = map[string]ghCommand{
	"gist create": {positionals: -1, positionalFiles: true, opts: merge(
		optTable(oValue, true, "-d", "--desc", "-f", "--filename"),
		optTable(oBool, false, "-p", "--public", "-w", "--web"))},
	"issue create": {positionals: 0, opts: merge(
		optTable(oValue, true, "-R", "--repo", "-t", "--title", "-b", "--body", "-a", "--assignee", "-l", "--label", "-m",
			"--milestone", "-p", "--project", "-T", "--template"),
		optTable(oRead, true, "-F", "--body-file", "--recover"),
		optTable(oBool, false, "-w", "--web", "-e", "--editor"))},
	"pr merge": {positionals: 1, opts: merge(
		optTable(oValue, true, "-R", "--repo", "-b", "--body", "-t", "--subject", "-A", "--author-email", "--match-head-commit"),
		optTable(oRead, true, "-F", "--body-file"),
		optTable(oBool, false, "-m", "--merge", "-r", "--rebase", "-s", "--squash", "-d", "--delete-branch",
			"--auto", "--admin", "--disable-auto"))},
}

func init() {
	ghCommands["gist new"] = ghCommands["gist create"]
}

// ghCall parses a gh command from the table: the files it sends and whether every argument was understood.
func ghCall(g ghArgv) (files []action, complete bool) {
	if len(g.words) < 2 || g.lost {
		return nil, false
	}
	cmd, ok := ghCommands[g.words[0]+" "+g.words[1]]
	if !ok {
		return nil, false
	}
	n := 0
	complete = parseOpts(g.rest, cmd.opts, func(name string, o opt, v string) {
		if o.kind == oRead && v != "-" {
			files = append(files, readAct(v))
		}
	}, func(p string) {
		n++
		if cmd.positionalFiles && p != "-" {
			files = append(files, readAct(p))
		}
	})
	if (cmd.positionals >= 0 && n > cmd.positionals) || g.early {
		complete = false
	}
	return files, complete
}

// isClient: argv runs an HTTP client or gh.
func isClient(argv []string) bool {
	if _, ok := httpClient(argv); ok {
		return true
	}
	return path.Base(argv[0]) == "gh"
}

// clientActions are the actions an HTTP client or gh command adds to its exec action: the local files it reads and
// writes, and an unresolved action when an HTTP client argv is not fully understood.
func clientActions(argv []string) []action {
	if c, ok := httpClient(argv); ok {
		acts := c.files
		if !c.complete {
			acts = append(acts, action{kind: "unresolved", cause: "an HTTP client call whose arguments this check cannot fully read"})
		}
		return acts
	}
	if path.Base(argv[0]) == "gh" {
		g := ghWords(argv)
		files, _ := ghCall(g)
		if g.lost {
			files = append(files, action{kind: "unresolved", cause: "a gh command whose words this check cannot place"})
		}
		return files
	}
	return nil
}
