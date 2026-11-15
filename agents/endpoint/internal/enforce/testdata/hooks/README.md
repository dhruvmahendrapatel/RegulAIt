# Hook payload fixtures (ADR-0330)

One directory per coding agent. Each file is one hook input as the agent writes it to the hook's stdin, built from
the vendor's documented field table on the date the contract was checked (2026-11-15). Where the docs give a literal
example it is used as is: `copilot-cli/builtin-bash.json` is the docs' own test payload. The other vendors document
the fields only as a template or a table, so their fixtures fill those fields with made-up values. Every fixture but that one
carries `"secret-argument"` inside the tool arguments, and the tests assert that it never reaches the hook output.

When a vendor's contract changes, add a fixture for the new shape; never edit one in place.
