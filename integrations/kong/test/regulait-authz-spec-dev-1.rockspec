-- The test runner for the regulait-authz plugin spec, PINNED EXACTLY.
--
-- Not a rock anyone installs: it exists only so `luarocks build --only-deps`
-- installs busted and every rock busted pulls in at one exact version each.
-- LuaRocks has no lockfile it can produce offline, so this file is the lock:
-- every transitive dependency is listed with `==`, LEAVES FIRST, because
-- luarocks installs dependencies in order and a rock whose dependency is
-- already installed at a satisfying version does not fetch a newer one. The
-- workflow then lists the installed tree and fails if it holds any rock or
-- version not named here (.github/workflows/integrations.yml).
--
-- Test-only: none of these ship in the plugin, and none is loaded by Kong.
-- Licences (all MIT or MIT/X11): busted, luassert, say, lua_cliargs,
-- luasystem, dkjson, lua-term, penlight, luafilesystem, mediator_lua.
-- Versions resolved from luarocks.org on 2026-10-05. To bump one, change it
-- here only: the workflow's installed-tree check reads this file. A busted bump
-- also changes the runner path in the workflow's spec step, which names the
-- busted version directory.
rockspec_format = "3.0"
package = "regulait-authz-spec"
version = "dev-1"
source = { url = "git+https://example.invalid/regulait-authz-spec.git" }
description = {
  summary = "Pinned test dependencies for the regulait-authz Kong plugin spec",
  license = "Proprietary",
}
dependencies = {
  "lua >= 5.1, < 5.2",
  -- leaves first
  "luafilesystem == 1.9.0-1",
  "penlight == 1.15.0-1",
  "say == 1.4.1-3",
  "luassert == 1.9.0-1",
  "lua_cliargs == 3.0.2-1",
  "luasystem == 0.7.1-1",
  "dkjson == 2.11-1",
  "lua-term == 0.8-1",
  "mediator_lua == 1.1.2-0",
  -- the runner, last
  "busted == 2.3.0-1",
}
build = { type = "none" }
