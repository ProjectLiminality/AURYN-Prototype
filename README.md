# AURYN

AURYN is the MCP server that lets AI agents work with DreamNodes. Named after the Ouroboros amulet from The Neverending Story - "Do what you will."

## How It Works

### The Pattern: Context First

When you share information with AURYN:

1. **Context-provider runs first** - semantic search finds relevant DreamNodes
2. **Filter for true relevance** - LLM reads each candidate's README, drops noise
3. **Return the list** - you see which DreamNodes matter for this context
4. **Act with full knowledge** - now AURYN can truly help (garden knowledge, answer questions, draft responses)

This is relevance realization. The system finds the right context before acting.

### Example Flow

You: "I need to email João about the car registration"

AURYN:
1. Invokes context-provider with your message
2. Semantic search returns candidates: "João", "Car", "Portugal Bureaucracy"...
3. LLM filters: "João" and "Car" are relevant, "Portugal Bureaucracy" is noise
4. Returns: **Relevant: João, Car**
5. Now with context loaded, drafts email drawing from both DreamNodes

### The Agent

| Agent | Purpose |
|-------|---------|
| `context-provider` | Find relevant DreamNodes for any input. Semantic search → read READMEs → filter → return list. |

The context-provider is the first step. Always. It enables everything else.

## What AURYN Does

**Read**: Surface relevant knowledge to answer questions, draft emails, provide context
**Write**: Route insights to correct DreamNode READMEs (knowledge gardening)

Same semantic search powers both directions.

## MCP Tools

### DreamNode Operations
| Tool | Description |
|------|-------------|
| `read_dreamnode` | Read metadata and README by UUID (from context-provider) |
| `create_dreamnode` | Create new DreamNode with .udd and git init |
| `update_dreamnode` | Update metadata (title, type) |
| `delete_dreamnode` | Delete a DreamNode (requires confirmation) |

### Relationships
| Tool | Description |
|------|-------------|
| `add_submodule` | Import another DreamNode as submodule |
| `remove_submodule` | Remove submodule relationship |
| `list_submodules` | List submodules of a DreamNode |
| `sync_context` | Regenerate context file after submodule changes |

### Semantic Search
| Tool | Description |
|------|-------------|
| `process_content` | Semantic sweep on text or file, returns candidate DreamNodes |
| `index_dreamnodes` | Index all DreamNodes for search |
| `check_ollama_status` | Verify embedding service is running |

### Content
| Tool | Description |
|------|-------------|
| `read_readme` | Get README content |
| `write_readme` | Overwrite README (requires confirmation) |

## Architecture

AURYN imports InterBrain as a git submodule and exposes its services via MCP:

```
AURYN/
├── README.md           # This file - defines the dance
├── CLAUDE.md           # Bootstrap: imports README + submodule READMEs
├── InterBrain/         # Git submodule - the DreamNode system
├── Software Gardening/ # Git submodule - the development philosophy
└── src/                # MCP server implementation
```

## Setup

```bash
# Clone with submodules
git clone --recurse-submodules <repo-url>
npm install && npm run build
```

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

Requires Ollama with `nomic-embed-text` for semantic search.

## Philosophy

README is the universal memory format:
- **Agent-agnostic**: Works with any AI
- **Human-readable**: Just markdown
- **Git-versioned**: Full history
- **Composable**: Submodules cascade context

This README defines both what AURYN is (for humans) and how it behaves (for agents). The dance between user and agent, described once.
