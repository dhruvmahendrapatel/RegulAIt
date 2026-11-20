# Robot egress proxy (stripe/smokescreen v0.1.0): how a run uses it

ADR-0364 §7. Read from smokescreen v0.1.0's own source (`cmd/smokescreen.go`, `pkg/smokescreen/config_loader.go`,
`pkg/smokescreen/acl/v1`, `main.go`) and checked by running the built binary, 2026-11-19.

## The command line

The image's ENTRYPOINT is fixed:

```
robot-egress --config-file /etc/regulait/smokescreen.yaml \
             --disable-acl-policy-action open --disable-acl-policy-action report
```

`robot-egress` is smokescreen v0.1.0 used as a library (`portfilter/main.go` is smokescreen's own `main.go` plus one
hook; the same flags and config); see "ports" below.

Per run the executor appends:

| Flag | Value | Note |
|---|---|---|
| `--egress-acl-file` | the run's ACL file, `smokescreenAcl(allowedOrigins)` from `@regulait/shared` | one `default` rule, `action: enforce` |
| `--listen-ip` | the address on the sandbox network the runner reaches | default: all interfaces |
| `--listen-port` | only if not 4750 | default 4750 (`EXPOSE 4750`) |
| `--allow-range <CIDR>` | only where the org's private-network setting allows it (ADR-0043), each audited | repeatable |

The runner gets `REGULAIT_ROBOT_EGRESS_PROXY=http://<listen-ip>:<port>`.

Run it with an empty environment: smokescreen also honours upstream-proxy settings
(`--upstream-http-proxy-addr`, `--upstream-https-proxy-addr`), and nothing of the host's proxy configuration belongs in
a run's egress path.

## The fixed configuration (`smokescreen.yaml`)

- `allow_missing_role: true` — **required.** A role comes only from a client TLS certificate's CommonName
  (`defaultRoleFromRequest`, `main.go`). The sandbox presents none, so without this switch every request is refused
  ("Client role cannot be determined"); with it, every request is judged by the ACL's `default` rule. There is no
  command-line flag for it, which is why the image ships a config file.
- `deny_ranges: [169.254.169.254/32, fd00:ec2::254/128]` — the cloud metadata addresses, on top of the default refusal
  of every address that is not global unicast (loopback, private, link-local and so on, unless `--allow-range` or
  `--unsafe-allow-private-ranges` is given; neither is set). The same as `--deny-range` on the command line.
- `connect_timeout: 10s`.

## Flag spellings checked

- `--disable-acl-policy-action` is a string-slice flag: give it once per action (`open`, `report`). An ACL naming a
  disabled action is refused when it loads.
- `--deny-range`, `--allow-range` (CIDR, repeatable), `--deny-address` / `--allow-address` (`IP[:PORT]`, repeatable).
- `--egress-acl-file`, `--config-file`, `--listen-ip`, `--listen-port`.
- Checked by running the binary: a host off the ACL is refused with 407 (`"decision_reason":"default rule policy
  used"`), 169.254.169.254 is refused, an allowed host is tunnelled.

## Can Smokescreen restrict destination PORTS? Not by configuration: the port filter does it

The ACL (`allowed_domains`, `acl/v1`) matches host names only; no ACL field, config key or flag limits the destination
port for a host. The only port-aware settings are `--deny-address` / `--allow-address` `IP:PORT` entries, which match a
resolved IP address, not a host name, so they cannot express "this host, port 443 only". Checked by running it: with
`example.com` allowed, a request for `example.com:8080` was allowed (`"allow":true`) and dialled.

So the image's binary adds ONE hook through smokescreen's library API (ADR-0176 exception, ADR-0364 §7):
`smokescreen.Config.PostDecisionRequestHandler func(*http.Request) error` (pkg/smokescreen/config.go). Smokescreen calls
it in `handleConnect` (and for plain-HTTP proxy requests) only after its own ACL and IP checks allowed the request, and
denies the request when it returns an error (`denyError`, logged in the CANONICAL-PROXY-DECISION line's `error`).
`portfilter/portfilter.go` (`PortFilter.Check`):

- refuses every request that is not `CONNECT` (a robot's origins are https only);
- parses the CONNECT authority with smokescreen's own `pkg/smokescreen/hostport.New` and refuses a `host:port` that is not
  in the run's ports file.

The ports file is `/etc/regulait-egress/ports.txt` (fixed in the binary), one `host:port` per line, written by the
executor beside the ACL from the same offer targets (`egressPortsFile`, 0600, the same owner, mount and cleanup). A
missing, empty or malformed file stops the binary before it listens (fail closed). Tests: `go test` in `portfilter/`
(run in the image build too), and the executor's network-level test `robot-egress.integration.test.ts` (an allowed host
on a port it does not name is refused with 407).
