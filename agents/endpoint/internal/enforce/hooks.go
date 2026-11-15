package enforce

import "io"

// HookFunc answers one hook call: stdin is the agent's hook input, policy is nil when none verified.
type HookFunc func(stdin io.Reader, policy *Policy) (stdout []byte, stderr string, exit int)

// Hooks maps each adapter name (the `regulait-agent hook <agent>` argument) to its hook. Every adapter shares Decide
// and the same signed policy; only parsing and rendering differ.
var Hooks = map[string]HookFunc{
	AgentClaudeCode: HookClaudeCode,
	AgentCursor:     HookCursor,
	AgentCopilotCLI: HookCopilot,
	AgentCodex:      HookCodex,
}
