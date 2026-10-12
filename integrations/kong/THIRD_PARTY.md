# Third-party components — `integrations/kong`

Open-source components this directory uses (ADR-0176 admission rules: MIT, Apache-2.0, BSD or ISC;
maintained; pinned; works air-gapped).

**Nothing below ships in the plugin.** The plugin (`kong/plugins/regulait-authz/`) loads only what
Kong itself provides (`resty.http`, `cjson.safe`, `resty.openssl` — lua-resty-openssl, BSD-2-Clause,
bundled with Kong — and the Kong PDK). Every row here is a TEST
dependency of `test/handler_spec.lua` and `test/workload_spec.lua`, installed by CI at the exact versions in
`test/regulait-authz-spec-dev-1.rockspec` (the lock: every transitive rock is pinned with `==`, and
the workflow fails if the installed tree differs). It is fetched from luarocks.org at CI time only;
the air-gapped deployment never sees it. Versions resolved 2026-10-05.

| Component | Version | Licence | Used for, and why |
|---|---|---|---|
| busted (luarocks `lunarmodules/busted`, github.com/lunarmodules/busted) | `2.3.0-1` (released early 2026) | MIT | The runner for `test/handler_spec.lua` (ADR-0179 review, finding 9), replacing a hand-written runner. Run under LuaJIT, the Lua 5.1 dialect of Kong's OpenResty. |
| luassert (`lunarmodules/luassert`) | `1.9.0-1` | MIT | busted's assertion library (`assert.are.equal`, `assert.is_nil`, ...). |
| say (`lunarmodules/say`) | `1.4.1-3` | MIT | luassert's message strings. |
| lua_cliargs (`lunarmodules/lua_cliargs`) | `3.0.2-1` | MIT | busted's command-line parser. |
| luasystem (`lunarmodules/luasystem`) | `0.7.1-1` | MIT | busted's clock and terminal calls (C module, built against LuaJIT's headers). |
| dkjson (`dhkolf/dkjson`) | `2.11-1` | MIT/X11 | busted's JSON output handler. |
| lua-term (`hoelzro/lua-term`) | `0.8-1` | MIT/X11 | busted's terminal colour output (C module). |
| penlight (`tieske/penlight`) | `1.15.0-1` | MIT/X11 | busted's utility library. |
| luafilesystem (`hisham/luafilesystem`) | `1.9.0-1` | MIT/X11 | penlight's and busted's file-system calls (C module). |
| mediator_lua (`olivine-labs/mediator_lua`) | `1.1.2-0` | MIT | busted's event bus. Last released long ago; admitted as a frozen transitive dependency of a maintained runner, not used directly. |
| lua-resty-openssl (`fffonion/lua-resty-openssl`) | `1.2.0-1` | BSD-2-Clause | ADR-0188 S7: the cryptography of the plugin's PDP client (Ed25519 signing, SHA-256, random bytes). Kong bundles it, so the plugin ships nothing new; the spec loads the real library under LuaJIT's FFI so the signatures and the RFC 7638 thumbprint are checked, not stubbed. No rock dependencies. Resolved 2026-10-12. |
| LuaJIT (Ubuntu 24.04 `luajit`) | `2.1.0+git20231223.c525bcb+dfsg-1` | MIT | The interpreter the spec runs on in CI. |
| LuaRocks (Ubuntu 24.04 `luarocks`) | `3.8.0+dfsg1-1` | MIT | Installs the rocks above from the pinned rockspec. |
