# Robot egress proxy (stripe/smokescreen v0.1.0): how a run uses it

ADR-0364 §7. Read from smokescreen v0.1.0's own source (`cmd/smokescreen.go`, `pkg/smokescreen/config_loader.go`,
`pkg/smokescreen/acl/v1`, `main.go`) and checked by running the built binary, 2026-11-19.

## The command line

The image's ENTRYPOINT is fixed:

```
smokescreen --config-file /etc/regulait/smokescreen.yaml \
            --disable-acl-policy-action open --disable-acl-policy-action report
```

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

## Can Smokescreen restrict destination PORTS? No.

The ACL (`allowed_domains`, `acl/v1`) matches host names only; no ACL field, config key or flag limits the destination
port for a host. The only port-aware settings are `--deny-address` / `--allow-address` `IP:PORT` entries, which match a
resolved IP address, not a host name, so they cannot express "this host, port 443 only". Checked by running it: with
`example.com` allowed, a request for `example.com:8080` was allowed (`"allow":true`) and dialled.

So today the port limit of ADR-0364 §7 rests on the in-browser route check alone (`originAllowed`: an origin's port is
part of the match, default 443). §7 says that, where Smokescreen has no port setting, a CONNECT filter in front of it
closes the gap as an ADR-0176 exception. **Not built here: the lead decides.**
