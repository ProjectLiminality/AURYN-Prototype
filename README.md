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

### The Core Insight

MCP is just an API formatted for AI agents. By building AURYN as the canonical interface, we:
- Avoid reinventing the wheel (use InterBrain's existing ontology)
- Unify human and AI interaction (same tools, different invoker)
- Enable the "liminal dreamwalk" - free-flowing ideation that auto-routes to correct contexts

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

## Essential MCP Tools

### Foundation Layer (CRUD + Structure)

| Tool | Description |
|------|-------------|
| `list_dreamnodes` | List all DreamNodes with optional filters (type, name pattern) |
| `get_dreamnode` | Get metadata, readme, relationships for a DreamNode by UUID or name |
| `create_dreamnode` | Create new DreamNode with proper .udd, git init, DreamTalk placeholder |
| `update_dreamnode` | Update metadata (name, type, description) |
| `add_submodule` | Import another DreamNode as submodule (the canonical way) |
| `remove_submodule` | Remove submodule relationship |

### Semantic Layer (The Magic)

| Tool | Description |
|------|-------------|
| `semantic_search` | Query by meaning, return ranked DreamNodes with semantic distances |
| `get_context_for_conversation` | Given conversation text, return relevant DreamNodes (the "dreamwalk" feature) |

### Content Layer (Conservative by Design)

| Tool | Description |
|------|-------------|
| `read_readme` | Get the README content for a DreamNode |
| `append_to_readme` | Add validated, high-signal content (surgical, minimal) |

## Two Context Management Patterns

### Pattern 1: Explicit Submodules

When you know the context you need:
- Import DreamNode as submodule
- README + CLAUDE.md + MCP tools automatically load
- Deterministic, intentional, structural
- The dependency is explicit in the git graph

### Pattern 2: Semantic Dreamwalk

When you're in liminal space, dreaming freely:
- Conversation flows naturally
- Semantic search continuously pulls in relevant DreamNodes
- LLM validates true relevance (crossing a threshold)
- Validated insights route to correct contexts as "memetic nutrients"
- Emergent, fluid, exploratory

Both patterns use the same underlying tools, just orchestrated differently.

## The Conservative Signal Philosophy

The system defaults to **NOT adding** content. This is crucial.

### Why Conservation Matters

- We live in the age of AI slop - easy generation leads to pollution
- The DreamTalk symbol and name are sacred human interfaces
- Knowledge self-organizes in the mind - not everything needs to be written
- Hoarding is a fear response; gardening is trust in natural growth

### Rules for Content Addition

1. **Ambiguity means NO** - if unclear whether to add, don't add
2. **Surgical precision** - one sentence, not paragraphs
3. **Validate before write** - LLM confirms this is truly signal
4. **Keep human interface clean** - README is curated, not dumped into

### What Qualifies as Signal

- Concrete insights: "Use function X instead of Y for this reason"
- Structural decisions: "This DreamNode depends on that one"
- Distilled wisdom: A sentence that captures hours of exploration

### What Does NOT Qualify

- Stream of consciousness exploration
- Redundant reformulations
- "Better safe than sorry" hoarding
- Anything that could be re-derived from first principles

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

### Available Tools

| Tool | Description |
|------|-------------|
| `list_dreamnodes` | List all DreamNodes with optional type/name filters |
| `get_dreamnode` | Get full metadata and README for a DreamNode |
| `create_dreamnode` | Create new DreamNode with git initialization |
| `update_dreamnode` | Update metadata (title, type) |
| `delete_dreamnode` | Delete a DreamNode (requires confirmation) |
| `add_submodule` | Import DreamNode as git submodule |
| `remove_submodule` | Remove submodule relationship |
| `list_submodules` | List submodules of a DreamNode |
| `read_readme` | Read README content |
| `append_to_readme` | Append high-signal content |
| `write_readme` | Write/overwrite README |
| `semantic_search` | Search by semantic similarity |
| `get_context_for_conversation` | Find relevant DreamNodes for ideation |
| `index_dreamnodes` | Index all DreamNodes for search |
| `check_ollama_status` | Verify Ollama is available |

## Next Steps

- Iterate on signal filtering - refine what qualifies for README updates
- Add more tools as needed (canvas operations, DreamTalk handling)
- Explore HTTP transport for web integrations

## Related DreamNodes

- **InterBrain** - The core system (submodule dependency)
- **DreamOS** - The larger vision this serves
- **Project Liminality** - The philosophical framework
## Etymology: "Do What You Will"

In Michael Ende's *The Neverending Story*, AURYN bears "Tu was du willst" - "Do what you will." German has no lesser word than "will" - wanting and willing unified. The inscription invites using creative power inherited from the creator, obeying your own will which is one with the divine.
## Stream Processing Architecture

Invert the flow: deterministic semantic search FIRST (sliding window, low threshold, catch subtle mentions), then LLM filters false positives, then LLM routes precisely with full README context. Mechanistic sweep → intelligent pruning → surgical placement.
## Known Issue: Template README Noise

Most DreamNode READMEs contain boilerplate template text, causing false positives in semantic search. Solution: batch-identify template READMEs (they'll have near-perfect similarity to template text), then clear them to minimal state. READMEs should be genuine pointers - title, DreamTalk, and organic description only.
## Efficiency: File Path Input

Stream processing should accept file paths, not require text copying into context. Tool reads file directly - tokens spent only on results, not input duplication. Async batch processing: point to transcript file, results appear in DreamNodes without babysitting.
## Tool Minimalism: Constraints Enable Freedom

Audit tools ruthlessly - each constraint can limit intelligence. append_to_readme forces "tweet-threading" instead of holistic README editing with full context. Optimal: minimal tool set that enables maximum freedom, not constrains it. Read full README → intelligent edit beats append-only.
