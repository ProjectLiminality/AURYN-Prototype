# AURYN

AURYN is the agentic layer of DreamOS. Named after the Ouroboros amulet from The Neverending Story - "Do what you will."

## What AURYN Is

AURYN is three things at once:

1. **The template** - what makes a DreamNode a DreamNode (hooks, config, agentic essence)
2. **The copilot** - semantic search, context awareness, voice-to-action
3. **The interface** - MCP tools / CLI for AI agents to work with DreamNodes

When you create a new DreamNode, AURYN gives itself to creation. The template copies, the new node inherits AURYN's essence while AURYN remains whole. The strange loop.

## Current State vs. Future State

**Now**: AURYN imports InterBrain as submodule (for prototyping)
**Future**: InterBrain imports AURYN as submodule (for production)

Why the flip? Because AURYN is a *component* of InterBrain/DreamOS, not the container. AURYN provides:
- DreamNode lifecycle (create, read, update, delete)
- Semantic search and context awareness
- Voice-to-action in Dialogos mode
- The git template that every DreamNode inherits

InterBrain provides the UI, the canvas, the 3D visualization. AURYN is the spirit; InterBrain is the body.

## How AURYN Works

### The Pattern: Context First

1. **Context-provider runs first** - semantic search finds relevant DreamNodes
2. **Filter for true relevance** - LLM reads each candidate's README, drops noise
3. **Return the list** - you see which DreamNodes matter
4. **Act with full knowledge** - AURYN helps with context loaded

This is relevance realization. The system finds the right context before acting.

### The Spacebar Pattern (Dialogos Mode)

In collective dreamweaving sessions:

1. Transcription runs continuously (all voices heard)
2. Hold spacebar → AURYN knows you're addressing it
3. Speak your intent: "Add the 9/11 investigation to this canvas"
4. Release spacebar → AURYN has permission to act
5. AURYN: imports submodule if needed, places DreamTalk on canvas

Voice-first on mobile. Cursor + voice on desktop.

## MCP Tools

### DreamNode Operations
| Tool | Description |
|------|-------------|
| `read_dreamnode` | Read metadata and README by UUID |
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
| `process_content` | Semantic sweep on text/file, returns candidates |
| `index_dreamnodes` | Index all DreamNodes for search |
| `check_ollama_status` | Verify embedding service is running |

### Content
| Tool | Description |
|------|-------------|
| `read_readme` | Get README content |
| `write_readme` | Overwrite README (requires confirmation) |

## The Unix Philosophy

MCP tools are prototypes. The real implementation: CLI tools with standard I/O.

```bash
auryn create "New Idea" --type dream
auryn search "something about consciousness"
auryn import parent-node child-node
```

InterBrain wraps these the same way it wraps git - shell commands, simple, composable. Any AI agent can use them. Any script can call them.

## Architecture

```
AURYN/
├── README.md           # This file
├── CLAUDE.md           # Agent instructions
├── InterBrain/         # Git submodule (temporary - will flip)
├── Software Gardening/ # Git submodule (philosophy)
└── src/                # MCP server / CLI implementation
```

## Setup

```bash
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

AURYN gives itself to every DreamNode. The Ouroboros - creating itself endlessly.
