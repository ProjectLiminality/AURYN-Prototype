# AURYN

AURYN is the agentic layer of DreamOS. Named after the Ouroboros amulet from The Neverending Story - "Do what you will."

## What AURYN Is

AURYN is three things at once:

1. **The template** - what makes a DreamNode a DreamNode (hooks, config, agentic essence)
2. **The copilot** - semantic search, context awareness, voice-to-action
3. **The interface** - MCP tools / CLI for AI agents to work with DreamNodes

When you create a new DreamNode, AURYN gives itself to creation. The template copies, the new node inherits AURYN's essence while AURYN remains whole. The strange loop.

## Current State (as of 2026-02-12)

AURYN is a fully functional MCP server with **35 tools** across 13 domains. All tools are implemented with proper error handling and graceful degradation (Ollama and Radicle failures are non-fatal). The codebase is clean TypeScript with zero TODOs or stubs.

**What works now:**
- DreamNode CRUD (create, read, update, delete)
- Submodule relationships with bidirectional tracking (parent ↔ child)
- Semantic search (fuzzy always + vector-based when Ollama available) with sliding window chunking
- DreamSong weaving and reading (Obsidian canvas format)
- Sub-agent loading (DreamNode as agent with scoped tools and cascading context)
- Session spawning (open Claude Code in any DreamNode's context, macOS)
- Liminal web relationships (Dream-to-Dreamer horizontal connections via liminal-web.json)
- Pop-out to sovereign (promote local content to its own DreamNode with submodule replacement and DreamSong updates)
- Merge DreamNodes (unify two nodes into one sovereign entity preserving both git histories and all cross-references)
- Social resonance filter (Radicle publish/clone, peer sync, cherry-pick collaboration with full state machine, collaboration memory)
- Coherence beacon (ignite/detect beacon commits after dreamweaving)

**What's crystallizing conceptually but not yet implemented:**
- AURYN-native session spawning — The InterBrain's "open in Claude Code" button (currently a terminal icon on the selected DreamNode) should use AURYN's DreamTalk symbol instead, and by default spawn Claude Code in AURYN's directory (not the DreamNode's), with the selected DreamNode's README and DreamSong auto-loaded into context. This is the current best prototype of AURYN as its own thing — the agent always starts from AURYN's root with the relevant DreamNode context injected. Eventually "claude" gets replaced by "auryn" and sessions start at the vault root, but spawning into AURYN is the stepping stone.
- Voice transcription pipeline (own the full lifecycle from spoken word to actionable text)
- Canvas-submodule sync (bidirectional: canvas references ↔ git submodules)
- Holarchic resonance management (downstream/upstream cherry-pick flows between sovereign repos and submodule clones)
- Situational assessment as a native operation (pull latest submodule state → read DreamSong + READMEs + recent commits → produce status → update README)
- Knowledge refactoring (unstructured files → DreamNodes)
- DreamTalk image intelligence (symbol generation using DreamTalk library constraints, not generic AI images)
- Vault-level meta-context (root README as life project dashboard)
- Absorb merge (parent absorbs child submodule) — When merging A and B where B is a submodule of A, the merge should detect this parent-child relationship and handle it as absorption: ensure B's main is up-to-date with its submodule clone in A, remove the submodule, merge B's history into A, and update all other parents that had B as a submodule to now point at the merged A. This is the inverse of pop-out-to-sovereign: where pop-out promotes a local file to a sovereign DreamNode, absorb merge dissolves that sovereignty back into the parent. First real-world scenario: PRISM absorbing TorrentPlayer.

**Owned by other DreamNodes (not AURYN's territory):**
- Publishing/distribution → PRISM (GitHub Pages, platform mirroring, torrent seeding)
- DreamTalk symbol creation engine → DreamTalk (animation library, Cinema 4D backend)

## Architecture

```
AURYN/
├── README.md           # This file
├── CLAUDE.md           # Agent instructions
├── InterBrain/         # Git submodule (temporary - will flip in production)
├── Software Gardening/ # Git submodule (philosophy)
└── src/
    ├── index.ts                    # MCP server entry point
    ├── services/
    │   └── standalone-adapter.ts   # All service implementations (~1180 lines)
    └── tools/
        ├── foundation.ts           # CRUD operations
        ├── submodule.ts            # Relationship management
        ├── semantic.ts             # Search operations
        ├── dreamweaving.ts         # Canvas generation
        ├── agent-loader.ts         # Sub-agent management
        ├── spawn-chat.ts           # Session spawning
        ├── pop-out.ts              # Pop-out to sovereign
        ├── merge.ts                # Merge DreamNodes
        ├── liminal-web.ts          # Liminal web relationships
        ├── social-resonance.ts     # Radicle ops + peer sync + collab memory
        ├── cherry-pick.ts          # Cherry-pick workflow state machine
        └── coherence-beacon.ts     # Beacon ignite/detect
```

**Now**: AURYN imports InterBrain as submodule (for prototyping)
**Future**: InterBrain imports AURYN as submodule (for production)

## How AURYN Works

### The Pattern: Context First

1. **Context-provider runs first** - semantic search finds relevant DreamNodes
2. **Filter for true relevance** - LLM reads each candidate's README, drops noise
3. **Return the list** - you see which DreamNodes matter
4. **Act with full knowledge** - AURYN helps with context loaded

### Two Axes of Resonance

AURYN mediates two orthogonal dimensions of how DreamNodes relate:

**Horizontal (Social Resonance)**: Dream-to-Dreamer connections across the liminal web. Peers share DreamNodes through cherry-pick-based curation. Signal propagates transitively through trust relationships. Managed by the InterBrain's social resonance filter.

**Vertical (Holarchic Resonance)**: Parent-child nesting via submodules. Changes flow in two directions:
- **Downstream** (sovereign → submodule clones): The sovereign main branch advances; each submodule clone cherry-picks what's relevant to its context. Safe, frequent, pull-based.
- **Upstream** (submodule clone → sovereign): A feature matures in context; when ready, it gets cherry-picked back to sovereign main. Deliberate, conscious, push-based.

The two axes intersect at the **sovereign DreamNode** — the canonical version at the vault root. Horizontal resonance (peers) feeds into it. Vertical resonance (contexts) flows out of it and back.

**Cherry-pick is the universal operation** because it preserves sovereignty. A merge says "I accept your history as mine." A cherry-pick says "I was inspired by your change and I recreate it in my own context." In the agentic age, every commit is a prompt — the AI agent understands intent and implements appropriately for its context, making merge conflicts a non-concept.

**Context branches**: Complex DreamNodes (like InterBrain) maintain a branch per context they're imported into. The branch name mirrors the parent DreamNode. Simple DreamNodes track main directly.

### The Core Principle: Relationships Are Downstream of DreamSongs

Submodule relationships are **never directly manipulated**. They are inferred from DreamSongs.

When you weave a DreamSong (canvas), you place DreamTalk images from other DreamNodes and write text explaining how they relate. The system observes what you reference and manages submodule imports/removals automatically. This is an **enabling constraint**:

- **To import**: Reference a DreamNode's DreamTalk in your DreamSong. The submodule relationship follows.
- **To remove**: Edit the DreamSong to remove the reference. On save, the system cleans up the submodule.
- **No orphan imports**: Every submodule relationship is justified by a story.
- **No accidental breakage**: You can't remove a submodule that a DreamSong references without first editing the DreamSong.

DreamSongs become the holarchy map. At every level, the DreamSong explains *why* these submodules are here and how they relate. Far richer context for agentic navigation than bare dependency lists.

### The DreamTalk Requirement

Every DreamNode needs a DreamTalk image — it's what makes a node dreamweave-ready. Without an image, a DreamNode cannot be referenced in a DreamSong and therefore cannot participate in holarchic relationships.

### Pop-Out to Sovereign

The inverse of importing: content that starts as a local file inside a DreamNode can be promoted to its own sovereign DreamNode. AURYN handles the full flow:

1. User identifies content that deserves sovereignty ("this should be its own thing")
2. AURYN creates a new sovereign DreamNode from that content
3. The local file is replaced by a submodule import of the new DreamNode
4. The DreamSong is updated — file references now point into the submodule
5. A context branch is created in the submodule clone (named after the parent)

The final state is the same as if the DreamNode had always existed externally: sovereign repo, submodule clone with context branch, correct DreamSong paths. This is how knowledge gardens grow — not in size, but in interconnectedness.

### Knowledge Refactoring (Unstructured → DreamNodes)

Point AURYN at any file path — a folder, a Notion export, a CSV dump, an existing Obsidian vault. AURYN creates DreamNodes with minimum viable structure, just enough for dreamweaving compatibility. Through ongoing knowledge gardening, finer structure emerges naturally. Pop-out happens when a piece is ready for sovereignty.

### Situational Assessment

AURYN can assess the state of any DreamNode that contains submodules (like a project DreamSong):

1. **Pull latest** — update all submodule pointers to sovereign state
2. **Read the DreamSong** — understand the narrative and relationships
3. **Check each submodule** — read README + recent commits for ground truth
4. **Report honestly** — what's alive, what's stale, what's missing
5. **Update the README** — the Current State section reflects reality

The README is the always-current truth. When AURYN does a situational assessment, it reads the README first. If the README is stale, that's the first thing to fix.

## MCP Tools (35 total)

### DreamNode Operations (4)
| Tool | Description |
|------|-------------|
| `create_dreamnode` | Create new DreamNode with git init, Radicle init, returns UUID |
| `read_dreamnode` | Read metadata and README by UUID |
| `update_dreamnode` | Update metadata (title, type) |
| `delete_dreamnode` | Delete a DreamNode (requires confirmation) |

### Relationships (4)
| Tool | Description |
|------|-------------|
| `add_submodule` | Import a DreamNode as submodule (low-level primitive) |
| `remove_submodule` | Remove a submodule relationship |
| `list_submodules` | List submodules of a DreamNode |
| `sync_context` | Regenerate `.claude/submodule-context.md` with @imports for all submodule READMEs |

Note: `add_submodule` and `remove_submodule` are low-level primitives. The intended flow is DreamSong-driven: weave a DreamSong → submodule relationships are inferred as a downstream effect.

### Liminal Web (3)
| Tool | Description |
|------|-------------|
| `add_liminal_link` | Add a horizontal link between a Dreamer and another DreamNode |
| `remove_liminal_link` | Remove a liminal web link |
| `list_liminal_links` | List all connections for a DreamNode (Dreamer: direct read; Dream: scans all Dreamers) |

Note: Links are stored in Dreamer nodes' `liminal-web.json` as UUID arrays. Interpreted as bidirectional — only Dreamers hold the data.

### Semantic Search (3)
| Tool | Description |
|------|-------------|
| `process_content` | Unified search: fuzzy (always) + semantic (if Ollama). Handles text and files with sliding window chunking. |
| `index_dreamnodes` | Index all DreamNodes for vector search |
| `check_ollama_status` | Verify Ollama embedding service is available |

### Dreamweaving (2)
| Tool | Description |
|------|-------------|
| `weave_dreamsong` | Generate DreamSong.canvas from source DreamNodes with descriptions |
| `read_dreamsong` | Parse DreamSong.canvas into topologically sorted content blocks |

### Agent Management (3)
| Tool | Description |
|------|-------------|
| `load_dreamnode_agent` | Load DreamNode as sub-agent with README context and scoped tools |
| `unload_dreamnode_agent` | Remove a loaded sub-agent |
| `list_loaded_agents` | List all currently loaded sub-agents |

### Session Management (2)
| Tool | Description |
|------|-------------|
| `spawn_chat` | Open Claude Code in a DreamNode's directory (macOS) |
| `pop_out_to_sovereign` | Promote local content to sovereign DreamNode with submodule replacement, DreamSong path updates, and context branch creation |

### Lifecycle (1)
| Tool | Description |
|------|-------------|
| `merge_dreamnodes` | Merge two DreamNodes into one sovereign entity, preserving both git histories, updating all cross-references, and keeping ghost forks for backpropagation |

### Social Resonance (3)
| Tool | Description |
|------|-------------|
| `radicle_clone` | Clone a DreamNode from Radicle network by RID |
| `radicle_publish` | Publish/share a DreamNode on the Radicle network |
| `radicle_follow_peer` | Follow a peer DID, optionally add as delegate |

### Peer Sync (3)
| Tool | Description |
|------|-------------|
| `fetch_peer_commits` | Fetch new commits from all peer remotes |
| `list_pending_commits` | List peer commits not yet accepted/rejected |
| `read_collaboration_memory` | Read acceptance/rejection history for a Dreamer |

### Cherry-Pick Workflow (5)
| Tool | Description |
|------|-------------|
| `cherry_pick_preview` | Enter preview: stash local changes, cherry-pick, show diff |
| `cherry_pick_accept` | Accept previewed commit, record in collaboration memory |
| `cherry_pick_reject` | Reject previewed commit, record in collaboration memory |
| `cherry_pick_cancel` | Cancel preview without recording |
| `cherry_pick_status` | Get current workflow state (UI observability) |

### Coherence Beacon (2)
| Tool | Description |
|------|-------------|
| `ignite_beacon` | Create beacon commit after dreamweaving |
| `detect_beacons` | Scan peer commits for beacon metadata |

### Not Yet Implemented

**Dreamweaving (completing the stack):**
- `sync_canvas_submodules` — bidirectional sync (canvas references ↔ git submodules)
- `extract_relationships_from_canvas` — relationship graph from DreamSong

**Voice Pipeline:**
- Voice transcription (Whisper integration — own the full spoken-word-to-action lifecycle)

**Other:**
- Situational assessment — pull submodule state → read DreamSong + READMEs → produce status report
- Submodule refresh — `git submodule update --remote` before assessment
- DreamTalk image intelligence — symbol generation using DreamTalk library constraints
- Knowledge refactoring — unstructured files → DreamNodes

**Owned by other DreamNodes (not AURYN tools):**
- GitHub Pages publishing → PRISM
- Platform mirroring → PRISM
- Torrent seeding → PRISM

## Roadmap (Prioritized for Spring Launch)

### Next Up
1. **Dreamweaving completion** — canvas-submodule sync (bidirectional enforcement of DreamSong-driven relationships)
2. **Knowledge refactoring** — vault consolidation (the Spring Launch prerequisite)

### Medium Priority
- Voice transcription pipeline (Whisper, local + remote modes)
- DreamTalk image intelligence (symbol generation, style references)
- Situational assessment + submodule refresh
- CLI tools (`auryn create`, `auryn search`, `auryn weave`)

### Future
- Spacebar/Dialogos mode (voice-driven intent recognition)
- Architecture flip (InterBrain imports AURYN)
- Cross-platform spawn_chat (Linux/Windows)
- Real-time conversational co-pilot integration

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

Requires Ollama with `nomic-embed-text` for semantic search (optional — fuzzy search works without it).

## Philosophy

README is the universal memory format:
- **Agent-agnostic**: Works with any AI
- **Human-readable**: Just markdown
- **Git-versioned**: Full history
- **Composable**: Submodules cascade context

The sophistication ceiling has been removed. In the agentic age, system design is no longer constrained by user operability. AURYN holds the knowledge of how collective dreamweaving works and operates it on your behalf. Users interact through natural language. AURYN does the gardening.

AURYN gives itself to every DreamNode. The Ouroboros - creating itself endlessly.
