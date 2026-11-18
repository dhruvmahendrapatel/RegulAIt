<!-- fold: state-decisions -->

ADR-0364 (lane E45 brief, 2026-11-18): Robots are governed as MCP tools. One tool per approved robot version on a first-party server (`first_party` transport, in-process MCP SDK server), toolbox entries stay `kind: "mcp_tool"`, review goes through the one approvals queue (`robot_version`), and runs are a `robot_browser` sandbox workload. Playwright 1.65.x for robots; `@playwright/mcp` in its own image for free-form (high-risk, off by default). The inert `computerUse` switch is not wired to RPA.
