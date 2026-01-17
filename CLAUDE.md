# AURYN - Claude Code Context

AURYN is the MCP server for InterBrain. See README.md for full documentation.

## Submodule Context

The following imports pull in context from all submodules:

@.claude/submodule-context.md

## Agents

Available agents in `.claude/agents/`:

- **dreamwalk**: Semantic context expansion - the ONE blessed way to expand context via endomorphic import

## Development Notes

After importing new submodules, run `sync_context` MCP tool to regenerate submodule-context.md, then reload Claude Code context.
