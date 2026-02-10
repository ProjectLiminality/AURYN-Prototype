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
3. Speak your intent: "Weave the 9/11 investigation into this DreamSong"
4. Release spacebar → AURYN has permission to act
5. AURYN: asks for brief justification, weaves minimal DreamSong, submodule follows implicitly

Voice-first on mobile. Cursor + voice on desktop.

### The Core Principle: Relationships Are Downstream of DreamSongs

Submodule relationships are **never directly manipulated**. They are inferred from DreamSongs.

When you weave a DreamSong (canvas), you place DreamTalk images from other DreamNodes and write text explaining how they relate. The system observes what you reference and manages submodule imports/removals automatically. This is an **enabling constraint**:

- **To import**: Reference a DreamNode's DreamTalk in your DreamSong. The submodule relationship follows.
- **To remove**: Edit the DreamSong to remove the reference. On save, the system cleans up the submodule.
- **No orphan imports**: Every submodule relationship is justified by a story. No unexplained dependencies.
- **No accidental breakage**: You can't remove a submodule that a DreamSong references without first editing the DreamSong.

This means the holarchy view (sub/supermodule relationships) is **read-only visualization** of what has been inferred from your creative work. You don't manage the graph - you tell stories, and the graph emerges.

### Why This Matters

Without this constraint, you get two competing systems: manual submodule management vs. DreamSong-inferred relationships. They fight each other. With it, everything flows from one source of truth: the creative act of dreamweaving.

For agents, this means AURYN doesn't just `add_submodule`. Instead:
1. User says "I need DreamNode X in this context"
2. AURYN asks: "Why does it belong here?" (even one sentence suffices)
3. AURYN weaves a minimal DreamSong: the DreamTalk images + justification text
4. The submodule relationship is created as a downstream effect of the DreamSong existing

This also means **DreamSongs become the holarchy map**. At every level of the hierarchy, the DreamSong explains *why* these submodules are here, how they relate, and what purpose they serve. Far richer context for agentic navigation than bare dependency lists.

### The DreamTalk Requirement

Every DreamNode needs a DreamTalk image. This is not optional decoration - it's what makes a node dreamweave-ready. Without an image, a DreamNode cannot be referenced in a DreamSong, and therefore cannot participate in holarchic relationships.

For DreamNodes that lack a DreamTalk:
- AURYN auto-generates one from the README using AI image generation
- The generated image serves as a placeholder that can be replaced with something more authentic later
- This ensures every DreamNode in the system is always ready for dreamweaving

### DreamTalk Image Intelligence (TODO)

The current image generation is too generic. AURYN needs a smarter pipeline:

**1. Web retrieval first**: Before generating anything, AURYN should check whether the subject already has an established visual identity. Starlink has a logo. YouTube has a logo. These *are* their DreamTalk symbols — don't generate a random satellite dish when the actual mark exists. This needs to be performant and precise (not a full browser scrape, just targeted image retrieval).

**2. Style reference system**: When AURYN does generate an image, it should be guided by:
- A **style reference image** — a visual anchor for the aesthetic. Exposed in settings so each user can set their own, but AURYN ships with at least one default.
- A **meta-prompt** — not fed to the image AI directly, but read by AURYN when it designs the actual generation prompt. This gives artistic direction ("prefer symbolic over literal", "warm tones", etc.) without micromanaging every generation.

**3. Calibrated prompt design**: The styling language AURYN uses when prompting the image AI needs tuning. Right now some results are great and others are completely meaningless relative to what they represent. The meta-prompt + style reference together should bring consistency and intentionality.

The flow becomes: subject → web search for existing visual identity → if found, use it → if not, generate with style reference + meta-prompt → result is a DreamTalk that actually means something.

### Agentic Dreamweaving (Voice-Driven)

AURYN is the dreamweaving assistant, especially for mobile where everything is voice-driven:

1. "Weave these three ideas together" → AURYN asks for brief justification for each
2. User speaks 1-2 sentences per relationship → AURYN has enough to weave
3. AURYN creates minimal DreamSong (images + text) → submodules follow implicitly
4. User can later enrich the DreamSong with more detail on desktop canvas

The DreamSong doesn't need to be elaborate. A minimal weave - DreamTalk images placed on canvas with a sentence of context - is sufficient. The system just needs to know *what* is referenced and *why*.

### Pop-Out to Sovereign

The inverse of importing: content that starts as a local file inside a DreamNode can be promoted to its own sovereign DreamNode. AURYN handles the full flow:

1. User identifies content that deserves sovereignty ("this should be its own thing")
2. AURYN creates a new DreamNode from that content
3. The local file is replaced by a submodule import of the new DreamNode
4. The DreamSong file path is updated to point into the submodule

The final state is the same as if the DreamNode had always existed externally: sovereign repo, submodule clone, correct file path. This is how knowledge gardens grow — not in size, but in interconnectedness. Broad contexts gain finer structure over time as pieces pop out into their own sovereignty.

### Knowledge Refactoring (Unstructured → DreamNodes)

AURYN is where all agentic capacity related to dreamweaving lives. This includes the refactoring of existing unstructured knowledge into DreamNodes:

- **Any file path**: Point AURYN at a folder, a file, a Notion export, a CSV dump, an existing Obsidian vault. Everything is a file, Unix-style.
- **Minimum viable initial structure**: AURYN creates DreamNodes with just enough organization to be compatible with the dreamweaving system. Not every detail predicted upfront — that would alienate you from the knowledge.
- **Organic refinement**: Through ongoing knowledge gardening (talking to AURYN about how things relate, what you're thinking about), finer structure emerges naturally. Pop-out happens when a piece is ready for sovereignty.
- **DreamSong as first pass**: AURYN can weave a DreamSong from existing content, using found images or generating placeholders. You read it, correct it, and the knowledge garden takes root.

The less-is-more principle: initial structuring is light, leaving space for organic growth. The knowledge garden increases its interconnectedness through use, not through upfront engineering.

## MCP Tools

### DreamNode Operations
| Tool | Description |
|------|-------------|
| `read_dreamnode` | Read metadata and README by UUID |
| `create_dreamnode` | Create new DreamNode with .udd and git init |
| `update_dreamnode` | Update metadata (title, type) |
| `delete_dreamnode` | Delete a DreamNode (requires confirmation) |

### Relationships (Read-Only + DreamSong-Driven)
| Tool | Description |
|------|-------------|
| `list_submodules` | List submodules of a DreamNode (read-only view) |
| `sync_context` | Regenerate context file after submodule changes |

Note: `add_submodule` and `remove_submodule` exist as low-level primitives but should not be called directly. Submodule relationships are managed through dreamweaving - the InterBrain infers them from DreamSong canvas references. AURYN's agentic dreamweaving flow (future) will weave DreamSongs that result in submodule changes as a downstream effect.

### Semantic Search
| Tool | Description |
|------|-------------|
| `process_content` | Semantic sweep on text/file, returns candidates |
| `index_dreamnodes` | Index all DreamNodes for search |
| `check_ollama_status` | Verify embedding service is running |

### Missing / TODO
- **Liminal web relationships**: No MCP tool exists yet to create or manage horizontal liminal web relationships (dream-to-dreamer connections). Currently only vertical holarchic relationships (submodules/supermodules) are supported. Need a tool to associate a Dream with a Dreamer (and vice versa) without using the submodule mechanism.

## The Unix Philosophy

MCP tools are prototypes. The real implementation: CLI tools with standard I/O.

```bash
auryn create "New Idea" --type dream
auryn search "something about consciousness"
auryn weave parent-node child-node --reason "brief justification"
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
