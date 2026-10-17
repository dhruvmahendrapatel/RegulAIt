# Endpoint discovery without an agent: the osquery query pack

ADR-0195 decision 2(a) and decision 18. RegulAIt can find AI tools on employee machines without installing anything
of its own there. You run [osquery](https://osquery.io) on your fleet (most MDM and EDR products can deploy it, or
already do), add RegulAIt's query pack to its configuration, and import the results. A software inventory export from
your MDM or EDR can be imported instead of, or as well as, osquery results.

> **Before you enable this, read the [employee notice template](ENDPOINT_EMPLOYEE_NOTICE_TEMPLATE.md).**
> Employee-monitoring and privacy law (for example GDPR and works-council rules) differs by country. RegulAIt makes
> no compliance claim about endpoint discovery. Take legal advice before you deploy the pack or import an inventory.

## What RegulAIt ships, and what it does not

- **Ships**: the query pack `endpoint-discovery/osquery/regulait-ai-discovery.conf` (osquery's JSON pack format) and
  `endpoint-discovery/osquery/manifest.json` (the pack's SHA-256, size, the queries with their tables and platforms,
  and its signature status).
- **Does not ship**: osquery itself, an installer, a service or any code that runs on a device. osquery is yours: you
  choose the version, install it and run it.

## What the pack collects

Each query runs once a day (`interval` 86400) as a snapshot. Every query uses standard osquery tables only.

| Query | Platform | Tables | What it reports |
|---|---|---|---|
| `ai_apps_macos` | macOS | `apps` | installed apps whose bundle name or bundle id is in the AI catalogue |
| `ai_programs_windows` | Windows | `programs` | installed programs whose display name is in the catalogue (exact name) |
| `ai_deb_packages_linux` | Linux | `deb_packages` | Debian packages named after an AI app or local model runtime |
| `ai_rpm_packages_linux` | Linux | `rpm_packages` | RPM packages named after an AI app or local model runtime |
| `ai_running_processes` | all | `processes` | running AI apps, AI CLIs and local runtimes, by process name and path |
| `ai_ide_extensions_vscode` | all | `users`, `vscode_extensions` | VS Code-family editor extensions in the catalogue, per local user |
| `ai_ide_extensions_jetbrains` | all | `users`, `jetbrains_plugins` | JetBrains plugins in the catalogue, per local user |
| `ai_browser_extensions_chromium` | all | `users`, `chrome_extensions` | Chromium-family browser extensions in the catalogue, per local user |
| `ai_local_runtime_listeners` | all | `listening_ports`, `processes` | listening ports of local model runtimes, and their default ports |
| `ai_cli_npm_global` | all | `npm_packages` | AI CLIs installed as global npm packages |
| `ai_cli_binaries_macos` / `_linux` / `_windows` | per OS | `file` | AI CLI binaries in common install directories (path and type only) |
| `ai_env_var_names_posix` | macOS, Linux | `process_envs`, `processes` | the **names** of AI-related environment variables set in running processes |
| `ai_env_var_names_windows` | Windows | `registry` | the **names** of AI-related variables in the user and system environment keys |
| `ai_config_files_macos` / `_linux` / `_windows` | per OS | `file` | AI assistant and MCP config files present in user homes (path, type, modification time) |
| `hidden_assistant_lan_listeners` | all | `listening_ports`, `processes` | programs run from a user, hidden or temp directory that accept connections from the network |
| `hidden_assistant_background_apps_macos` | macOS | `apps` | user-installed macOS apps with no Dock icon or window |

Queries with nothing to look for are left out of the pack (today: Firefox and Safari extensions, whose catalogue lists
are empty).

**Never collected**: environment variable values, process command lines, file contents or hashes of them, registry value
data, browsing history, keystrokes, screenshots or clipboard. The importer refuses any result row that carries a value,
command-line or contents column, so an edited pack cannot widen what RegulAIt stores.

The last two queries look for the shape of an assistant built to stay hidden or to be controlled over the LAN. Their
matches are leads, not proof of AI use: ordinary developer servers share the first shape.

## Deploying the pack through your MDM or EDR

The steps depend on your product; these are the parts every route has in common.

1. **Get the pack and check it.** Take `regulait-ai-discovery.conf` and `manifest.json` from your RegulAIt release.
   Compare the file's SHA-256 with the manifest's `sha256` before you deploy it. The pack is **not signed yet**: the
   signing mechanism is decided in ADR-0195's SD4 spike, and the manifest's `signature.status` says `unsigned` until
   then. Treat the release you obtained the manifest from as the source of trust.
2. **Place the pack on each device** with your MDM's file or configuration-profile deployment, at a path osquery can
   read.
3. **Reference it from your osquery configuration** under `packs`, with the key `regulait_ai_discovery` (the importer
   expects that name; another key works if you give the same name to the importer):

   ```json
   { "packs": { "regulait_ai_discovery": "/path/to/regulait-ai-discovery.conf" } }
   ```

4. **Collect the results.** osquery's filesystem logger writes JSON lines to its results log; your MDM, EDR or log
   pipeline can gather those files. Event, snapshot and batch result formats are all accepted, as JSON lines or as one
   JSON array.
5. **Import them into RegulAIt** as `endpoint_osquery` evidence. The import route and admin page arrive with ADR-0195's
   SD0 foundation (pending in this build; see "Verification status").

## Importing an MDM or EDR software inventory

RegulAIt has no vendor-named presets (ADR-0195 decision 12). Export your software inventory as CSV or JSON and
import it as `endpoint_inventory` evidence with a column mapping:

| Field | Required | Meaning |
|---|---|---|
| `device` | yes | the device name or id (stored only as a pseudonym) |
| `itemName` | yes | the application, extension, package or process name |
| `itemId` | no | a bundle id or extension id |
| `itemType` | no | the kind of item; map your export's words to `application`, `ide_extension`, `browser_extension`, `package` or `process` with `itemTypeValues` |
| `version`, `publisher` | no | kept as reported |
| `user` | no | the assigned or primary user (stored only as a pseudonym) |
| `os` | no | read as macOS, Windows or Linux when it starts with a recognisable name |
| `observedAt` | no | the time the inventory was taken |

Without a mapping, RegulAIt proposes one from the headers and refuses if a required column is ambiguous (for example a
file with both `hostname` and `device`). A row with an empty required cell, an unknown item type or an unreadable time
is refused with its line number; nothing is dropped silently.

## Privacy defaults

- Device users, Windows SIDs and device names are replaced by a keyed hash (one key per tenant). The username part of
  every path (`/Users/<name>/`, `/home/<name>/`, `C:\Users\<name>\`) is replaced the same way. The display name is kept
  encrypted in a separate table and is revealed only under step-up, with an audit record (SD0).
- Endpoint evidence is kept for 90 days by default. Lengthening that is a relaxation an admin makes and is audited.
- RegulAIt never contacts a device and never tests a key it learns about.

## Limits

- osquery reports what its tables see. An app installed outside the locations a table reads, or a Windows program whose
  display name carries a version number, is not matched.
- The `jetbrains_plugins` query matches the catalogue's JetBrains id against the plugin name; the two may differ for a
  given plugin, so this query can miss.
- The process and listener queries see only what runs at the moment osquery runs.
- Environment variable names come from running processes only; a variable set in a shell profile that no running
  process inherited is not seen.
- The pack's catalogue lists are generated from RegulAIt's endpoint signature seed. Signatures you add in RegulAIt do not
  change the pack until the pack is regenerated.

## Verification status (M-041)

- Executed in the build environment on 2026-10-17: `node scripts/endpoint-pack-build.mjs` (generates the pack and
  manifest) and `node scripts/endpoint-pack-build.mjs --check` (exit 0); the shared test suite validates the pack's JSON
  shape, that only the tables above are read, that no value, command line or contents column is selected, and that the
  committed files match the generator.
- **Pending execution**: running the pack under osquery on macOS, Windows and Linux. osquery is not installed in the
  build environment, so no query has been executed and no result shown in this document comes from a real device.
- **Pending (SD0)**: the import route, the `endpoint_osquery` and `endpoint_inventory` sources and the 90-day retention
  setting.
- **Pending (SD4)**: pack signing.
