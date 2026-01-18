
# AURYN: InterBrain MCP Server

AURYN is the MCP (Model Context Protocol) server for InterBrain - the universal interface that allows AI agents and external tools to interact with the DreamNode system.

## Why "AURYN"

Named after the Ouroboros amulet from The Neverending Story - a symbol of the infinite, self-referential nature of dreams. AURYN enables the InterBrain to develop itself, creating a self-referential loop where the system can garden its own growth.

## Vision

AURYN is the **meta-catalyst** that unlocks everything else. It's not just another feature - it's the interface that allows:
- AI agents to work with DreamNodes natively
- External tools (Alfred, Raycast, scripts) to query and modify the dream space
- The system to develop itself through agentic workflows
- A unified interface that collapses the distinction between "application" and "agent"

### Bidirectional: Read + Write

AURYN operates in two directions simultaneously:
- **Write**: Route insights to correct DreamNode contexts (knowledge gardening)
- **Read**: Retrieve knowledge to answer questions, draft emails, surface relevant context

This isn't two modes - it's one unified flow. The same semantic search that finds where to store knowledge also finds what knowledge to retrieve.

### Personal Assistant Pattern

Start the day by voicing thoughts: "I need to email this person about that project." AURYN surfaces the relevant DreamNode, loads context, drafts the email. The email is transient (doesn't persist), but the project context it drew from is persistent knowledge.

### Shareability Principle

**Content and context travel together.** If you share AURYN with someone, they inherit everything needed to recreate the experience - submodule dependencies, MCP tools, README context. This is why user-level Claude Code profiles are less attractive: they break the ontology where everything meaningful lives within DreamNodes.

### The Core Insight

MCP is just an API formatted for AI agents. By building AURYN as the canonical interface, we:
- Avoid reinventing the wheel (use InterBrain's existing ontology)
- Unify human and AI interaction (same tools, different invoker)
- Enable the "liminal dreamwalk" - free-flowing ideation that auto-routes to correct contexts

## AURYN as Meta-Agent

AURYN is not just an MCP server - it's the **meta-agent** that orchestrates all other agents through MCP tooling. When Claude Code operates within AURYN's context, it gains the ability to:

- **Create and manage DreamNodes** (ideas, projects, people)
- **Expand context via dreamwalk** (semantic search → filter → submodule import)
- **Garden knowledge** (route insights to correct READMEs)
- **Compose capabilities** (import DreamNodes as submodules to inherit their tools/context)

### README as Universal Memory

Every DreamNode's README.md is its canonical memory - readable by any agent, any tool, any human. This is intentional:
- **Agent-agnostic**: Works with Claude, GPT, local models, or future AI
- **Human-readable**: No special format, just markdown
- **Git-versioned**: Full history, branching, merging
- **Composable**: Submodule imports cascade README context

CLAUDE.md exists only as a thin bootstrap that @imports README.md and submodule context. All knowledge lives in README.

### Agents

Available in `.claude/agents/`:

| Agent | Purpose |
|-------|---------|
| `dreamwalk` | Semantic context expansion - the ONE blessed way to expand context |

### Dreamwalk: Canonical Context Expansion

`/dreamwalk <file>` is the ONE blessed way to expand context:

1. Semantic sweep on input file
2. LLM filters false positives by reading candidate READMEs
3. Truly relevant DreamNodes imported as submodules
4. `sync_context` regenerates .claude/submodule-context.md
5. Reload chat to see new context

This enforces endomorphic-only interaction: never look at external context directly, always replicate into your universe first. Git records the relationship forever.

See `.claude/agents/dreamwalk.md` for the full agent definition.

## Architecture

AURYN is a DreamNode that has InterBrain as a git submodule, importing and using InterBrain's data layer services directly.

```
AURYN/
├── .udd                    # DreamNode metadata
├── README.md               # This file
├── InterBrain/             # Git submodule - the full InterBrain codebase
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts            # MCP server entry point
│   ├── types.ts            # Type definitions
│   ├── services/
│   │   ├── vault-discovery.ts    # Multi-vault DreamNode discovery
│   │   └── standalone-adapter.ts # InterBrain services without Obsidian
│   └── tools/
│       ├── foundation.ts   # CRUD operations
│       ├── submodule.ts    # Relationship management
│       ├── content.ts      # README operations
│       └── semantic.ts     # Semantic search
└── dist/                   # Compiled output
```

### Dependency Pattern

This is a **functional dependency** - AURYN imports and uses InterBrain's code:
- UDDService for .udd file operations
- GitDreamNodeService for DreamNode CRUD
- Semantic search services for vector queries
- Submodule management for relationship handling

The submodule relationship makes this dependency explicit and ensures AURYN always has access to the correct InterBrain version.

## MCP Tools

### Foundation Layer (CRUD + Structure)

| Tool | Description |
|------|-------------|
| `list_dreamnodes` | List all DreamNodes with optional filters (type, name pattern) |
| `get_dreamnode` | Get metadata, readme, relationships for a DreamNode by UUID or name |
| `create_dreamnode` | Create new DreamNode with proper .udd, git init, DreamTalk placeholder |
| `update_dreamnode` | Update metadata (name, type, description) |
| `delete_dreamnode` | Delete a DreamNode (requires confirmation) |

### Relationship Layer (Submodule = Context)

| Tool | Description |
|------|-------------|
| `add_submodule` | Import another DreamNode as submodule (the canonical way) |
| `remove_submodule` | Remove submodule relationship |
| `list_submodules` | List submodules of a DreamNode |
| `sync_context` | Regenerate .claude/submodule-context.md after importing submodules |

### Semantic Layer (The Magic)

| Tool | Description |
|------|-------------|
| `semantic_search` | Query by meaning, return ranked DreamNodes with semantic distances |
| `get_context_for_conversation` | Given conversation text, return relevant DreamNodes |
| `process_stream_of_consciousness` | Sliding window semantic sweep on text/file |
| `index_dreamnodes` | Index all DreamNodes for semantic search |
| `check_ollama_status` | Verify Ollama embedding service is available |

### Content Layer (Conservative by Design)

| Tool | Description |
|------|-------------|
| `read_readme` | Get the README content for a DreamNode |
| `append_to_readme` | Add validated, high-signal content (surgical, minimal) |
| `write_readme` | Write/overwrite README (requires confirmation) |

## Knowledge Gardening Principles

AURYN embodies the principles defined in the **Software Gardening** submodule:
- Two Context Patterns (explicit submodules vs semantic dreamwalk)
- Conservative Signal Philosophy (default to NOT adding)
- Stream Processing Pattern (deterministic sweep → LLM filter → surgical placement)
- Endomorphic Context Retrieval (submodule import over exomorphic lookup)

See `Software Gardening/README.md` for the full discipline.

## Relationship to DreamOS

AURYN is a stepping stone toward the larger DreamOS vision where:
- The file system becomes the dream system
- The file explorer becomes the dream explorer
- The app launcher becomes the dream launcher
- Applications and agents unify (same tools, different invoker)

AURYN demonstrates the pattern: a DreamNode that imports InterBrain as a submodule and extends its capabilities. Future DreamOS components will follow the same pattern.

## Technical Notes

### InterBrain Services to Expose

These existing InterBrain services can be wrapped as MCP tools:

- `GitDreamNodeService` - create, update, delete, list DreamNodes
- `UDDService` - read/write .udd metadata files
- `SubmoduleManagerService` - add/remove submodules
- `IndexingService` + `SearchService` - semantic search
- `VaultService` - file system operations within vault

### Transport

MCP supports multiple transports:
- **stdio** - for CLI tools and Claude Code integration
- **HTTP/SSE** - for web-based tools
- **WebSocket** - for persistent connections

Start with stdio for simplicity, expand as needed.

### No Obsidian Dependency

AURYN imports only the Obsidian-independent parts of InterBrain:
- File system operations (via fs, not Obsidian Vault)
- Git operations (via simple-git)
- Vector math and embeddings
- .udd parsing and writing

The Obsidian-specific UI layer is not imported.

## The Self-Referential Loop

Once AURYN exists:
1. AI can create new DreamNodes
2. AI can route insights to correct contexts
3. AI can import submodules to compose capabilities
4. AURYN can be used to develop AURYN itself

This is the "meta-catalyst" property - the system gains the ability to garden its own growth.

## Quick Start

### Prerequisites

- Node.js 18+
- Ollama running with `nomic-embed-text` model (for semantic search)
- Obsidian with at least one vault

### Installation

```bash
# Clone with submodule
git clone --recurse-submodules <repo-url>

# Install dependencies
npm install

# Build
npm run build
```

### Register with Claude Code

Add to `~/.claude/mcp.json`:

```json
{
  "mcpServers": {
    "auryn": {
      "command": "node",
      "args": ["/path/to/AURYN/dist/index.js"]
    }
  }
}
```

See [MCP Tools](#mcp-tools) for the complete tool reference.

## Next Steps

- Iterate on signal filtering - refine what qualifies for README updates
- Add more tools as needed (canvas operations, DreamTalk handling)
- Explore HTTP transport for web integrations

## Etymology: "Do What You Will"

In Michael Ende's *The Neverending Story*, AURYN bears "Tu was du willst" - "Do what you will." German has no lesser word than "will" - wanting and willing unified. The inscription invites using creative power inherited from the creator, obeying your own will which is one with the divine.

## Known Issues

**Template README Noise**: Most DreamNode READMEs contain boilerplate, causing false positives. Solution: batch-identify via high similarity to template text, clear to minimal state.

**Tool Minimalism**: Audit tools ruthlessly. `append_to_readme` constrains intelligence by forcing "tweet-threading" instead of holistic editing. Optimal: minimal tool set enabling maximum freedom. Read full README → intelligent edit beats append-only.

## Related DreamNodes

- **InterBrain** - The core system (submodule dependency)
- **DreamOS** - The larger vision this serves
- **Software Gardening** - The development philosophy
- **Project Liminality** - The philosophical framework
