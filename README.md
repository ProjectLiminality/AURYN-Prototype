# AURYN

AURYN is the cultivation layer of DreamOS. Named after the Ouroboros amulet from The Neverending Story - "Do what you will."

## What AURYN Is

AURYN is a **knowledge topology and cultivation system**, not an agentic framework. This distinction is fundamental.

The entire AI industry is building better execution tools — faster coding agents, more autonomous frameworks, better tool orchestration. AURYN is orthogonal to all of this. It occupies the **vision-to-maturity lifecycle**: planting seeds (creating DreamNodes), nurturing soil (growing READMEs through conversation and reflection), weaving relationships (DreamSongs), and collective gardening (cherry-pick sovereignty, liminal web, coherence beacons).

AURYN is three things at once:

1. **The template** - what makes a DreamNode a DreamNode (hooks, config, agentic essence)
2. **The copilot** - semantic search, context awareness, voice-to-action
3. **The interface** - MCP tools / CLI for AI agents to work with DreamNodes

When you create a new DreamNode, AURYN gives itself to creation. The template copies, the new node inherits AURYN's essence while AURYN remains whole. The strange loop.

### Transcend and Include

AURYN's relationship to agentic frameworks (Claude Code, OpenCode, Codex CLI, OpenClaw, and whatever emerges tomorrow) follows the principle: **don't compete, transcend and include.**

The core four of the agentic age are: **context, model, prompt, tools.** DreamNodes are universal vehicles containing any conceivable form of tools (CLI), context (files), and prompts (also files). These are orthogonal to agentic shells — any shell can work with DreamNodes.

The architectural test: **if a new capability announced tomorrow causes anxiety rather than excitement, you're building at the wrong layer.** AURYN is positioned so that every improvement in execution tools makes cultivation more valuable, not less:

- Better coding agents → visions in the system reach harvest faster
- Always-on daemons → AURYN's situational assessment becomes ambient
- New agentic frameworks → more tools AURYN can spawn at harvest time
- Faster/cheaper inference → AURYN's knowledge refactoring becomes more powerful

AURYN builds the **soil**, not the **tractor**. Every better tractor is good news.

### Cultivation vs. Harvest

The system splits cleanly along the **vision → strategy** boundary:

**AURYN's domain (cultivation):** Listening to spoken word, parsing stream of consciousness, growing READMEs, weaving DreamSongs, decomposing and recomposing visions into sub/supermodules, routing insights to the right DreamNodes, managing the relational graph of how dreams connect. This is the planting and nurturing phase. Spoken word is AURYN's native modality — stream of consciousness → structured DreamNodes is something no agentic framework is attempting.

**Not AURYN's domain (harvest):** When a vision crosses the maturity threshold — when the README is rich enough, the DreamSong relationships are clear, the intent is crystallized — hand it to whatever cutting-edge execution tool exists. AURYN opens the door, provides the context, steps aside. It can spawn the session, but the execution engine is whatever the user prefers.

The harvest moment is the natural handoff point. AURYN doesn't need to be the execution tool. It needs to have grown such clear, rich context that whatever agent picks it up can run with it effectively. The README and DreamSong are the handoff artifacts.

### Monetization Architecture

AURYN's value is the cultivation layer itself, completely decoupled from any specific agentic shell:

- **BYOK tier** — bring your own API keys, use any shell you want, everything open, no restrictions
- **Managed convenience tier** — non-technical users pay through Stripe, AURYN handles inference costs for its own operations (semantic search, summarization, spoken word parsing, DreamTalk generation) with a markup that supports the project
- **The user's shell choice is orthogonal** — AURYN never charges for or gates access to execution tools. Users bring their own Claude Code subscription, their own Cursor license, whatever they prefer

The token service is a convenience store attached to the garden. You don't need to grow the food to run the store, and you don't need the store to grow food. They're naturally decoupled. This means AURYN can position itself universally — it benefits from any tool's improvement because it sits at the layer above.

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
- Knowledge refactoring (unstructured knowledge → DreamNodes) — Type A consolidation (existing repos → RealDealVault) is complete (494 nodes). Type B (unstructured content like SecondBrain → DreamNodes) is next, with operational patterns established and benchmark dataset identified. System prompt + custom tooling crystallizing through learning-by-doing. But the vision goes far beyond file systems — AURYN should be pointable at any knowledge silo: forums, archives, interview collections, web-based knowledge repositories. The core operation is always the same: take a monolithic block of knowledge with crude or unintuitive internal structure (categories, document lists, thread hierarchies) and refactor it into memetic holons — sovereign DreamNodes structured through DreamSongs into holarchies that mirror how the mind actually relates to knowledge. AURYN doesn't need to one-shot this perfectly; it provides an initial skeleton that human collective intelligence refines through merge, pop-out, and ongoing gardening. Two high-signal target repositories: **InPower Movement** (forum with decades of condensed research, much of it transferred through interviews) and **Disclosure Project Intelligence Archive** (extremely high signal but hard to navigate due to conventional file/category management).
- Songlines (spoken word → DreamNode clips) — AURYN territory, not just InterBrain. Songlines are not DreamNodes — they are range references stored inside concept DreamNodes, pointing back to source conversations via RID. A concept DreamNode like "Zero Point Energy" accumulates songline clips from many different conversations, each carrying a transcript excerpt and an RID linking to the full episode. The songline is provenance — a third relational axis (referential) alongside vertical (submodule holarchy) and horizontal (liminal web). It says "this knowledge came through here" without creating structural coupling. The same unbundling/rebundling pattern applies universally: take a multiplicity of conversations, unbundle each into core ideas (only those meaningful to you), consolidate/deduplicate segments across sources, then synthesize foundational ideas into larger wholes via DreamSongs. For media (audio/video), PRISM's torrent topology gives this native distribution power — a clip is a piece range within the full episode's swarm, so sharing a clip means partially seeding the whole. For transcripts, the clip-to-whole relationship is pure metadata (range + RID). The spoken word interview modality is where enormous amounts of high-signal knowledge lives (podcasts, expert interviews, forum video content). AURYN needs to master this: transcription → concept extraction → clip identification → consolidation of clips from many interviews into the DreamNodes that represent those concepts. One subject matter expert interviewed across dozens of sessions contains a goldmine — AURYN should be able to structure that into navigable, composable, collaborative DreamNodes. Connects to the voice transcription pipeline but goes further: not just real-time copilot listening, but batch processing of existing interview archives.
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

### Private Holarchy Pattern

Cherry-pick sovereignty between local branch and Radicle remote creates a natural privacy boundary. You choose what reaches the network — everything else stays dark by default. This extends to social privacy through the holarchic structure itself.

**Three layers, each with its own propagation logic:**

1. **Sovereign DreamNodes (the leaves)** — each is its own Radicle repo with its own delegate list. Collaboration happens here with all existing machinery: cherry-pick workflow, social resonance filter, coherence beacons. The delegate list IS the social boundary.

2. **Private umbrella (the weave)** — a DreamNode you hold locally that weaves leaves into your personal picture via DreamSong. The umbrella's Radicle remote either doesn't exist or has no delegates beyond yourself. Your view of how different trust-bounded pieces relate in your life.

3. **The beacon boundary** — coherence beacons are only ignited for public-facing weaves. When you weave a DreamSong meant to invite peers into a shared story, you ignite the beacon and it propagates. When you weave a private umbrella combining DreamNodes across different trust boundaries — no beacon. The supermodule relationship exists only in your local branch of each constituent DreamNode.

**How social boundaries map to holarchic structure:** Rather than maintaining multiple branches or audience metadata within one DreamNode, decompose along trust lines using submodules. A house DreamNode becomes an umbrella with `Paperwork/` (delegates: housemates), `Makerspace/` (delegates: housemates + maker crew), `Workshop Ideas/` (delegates: wide circle). Each submodule is a sovereign Radicle repo with its own delegate list. Your maker space collaborators don't even know `Paperwork/` exists — it's not hidden, it's simply not in their world.

**Privacy boundaries emerge through gardening:** You don't pre-plan privacy structure. You start with a single DreamNode, notice "this piece has a different audience," and pop it out via `pop_out_to_sovereign`. The act of recognizing sovereignty IS the act of drawing the boundary.

**A DreamNode can live in multiple umbrellas simultaneously.** `Makerspace/` exists in your private House umbrella AND in a public Maker Community project. Different DreamSongs, different stories, different beacon decisions. The sovereign DreamNode doesn't know or care which umbrellas reference it.

**The pattern in one sentence:** sovereignty at the leaf, privacy at the weave, beacons only for stories you want to tell publicly.

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

### Knowledge Refactoring (Unstructured Knowledge → DreamNodes)

Point AURYN at any knowledge source — a folder, a Notion export, a CSV dump, an existing Obsidian vault, a forum, an archive, a collection of interviews. AURYN creates DreamNodes with minimum viable structure, just enough for dreamweaving compatibility. Through ongoing knowledge gardening, finer structure emerges naturally. Pop-out happens when a piece is ready for sovereignty.

**The core transformation**: Take a monolithic knowledge silo — a forum with thousands of threads, an archive with bureaucratic category structures, a series of expert interviews — and refactor it into memetic holons. Each concept that stands on its own becomes a sovereign DreamNode. These are then structured through DreamSongs into holarchies that mirror how the mind actually relates to that knowledge. The result: the surface area for knowledge transfer explodes. What was one huge opaque block becomes hundreds of composable, navigable, collaboratively refinable units.

**Why this matters**: Conventional knowledge management (categories, document lists, thread hierarchies, file names) is not how the human mind relates to knowledge natively. A forum is a silo — one member mastering the material doesn't automatically make it easier for others to digest. But when that knowledge is refactored into DreamNodes, each piece becomes a unit of collaboration and clarification. The collective intelligence of the community can work on the actual knowledge topology rather than fighting the container's structure.

**AURYN doesn't need to one-shot this**: The initial refactoring provides a skeleton — an ever-more-helpful starting point. From there, human collective intelligence refines: merge these two, pop this out, this is actually its own thing. Each round of refactoring teaches the system about itself.

**The seed-planting principle**: Knowledge gardening follows the metaphor literally — the human plants seeds, AURYN routes nutrients. A seed is a DreamNode with a name, a symbol (DreamTalk), and a one-pager README defining the concept. Once planted, AURYN's semantic search can detect when new knowledge (conversations, transcripts, documents) contains material relevant to that seed. The garden should not be populated with memetic strangers — concepts that don't mean anything to you. That niche is occupied by LLM inference and can be retrieved trivially. Your knowledge garden holds only the ideas that matter to you, represented by symbols, deepened over time through songline clips and written refinements. AURYN conservatively suggests candidate seeds from new knowledge sources but does NOT plant them autonomously. The human decides what enters the garden. This means the same transcript produces different results depending on which seeds you've already planted — revisiting a knowledge base after planting new seeds yields new insights that weren't relevant before. Knowledge refactoring is therefore an organic, iterative process rather than a mechanical one-time migration.

**The spoken word dimension**: Enormous amounts of high-signal knowledge lives in interviews and podcasts. Subject matter experts get interviewed repeatedly across dozens of sessions, explaining concepts, presenting research, going deep on specifics. AURYN should be able to process these: transcript → concept extraction → clip identification → consolidation of clips from many interviews into the DreamNodes that represent those concepts. This is the Songlines feature applied to knowledge refactoring — not just real-time copilot listening, but batch processing of existing spoken-word archives. Authentic conversation is the ideal binding structure for bringing different forms of knowledge into relationship — people discuss a book and explain what it means to them, which is far more useful than a cold recommendation list. The podcast phenomenon is a non-trivial component of what wants to collectively emerge, and the private-call-to-public-podcast boundary dissolves naturally: the full conversation stays local (only you and your conversation partner hold it), and the act of clipping songlines into public concept DreamNodes IS the act of publishing. No separate recording mode, no editing workflow — you garden your knowledge and the public-facing clips emerge as a byproduct. Retroactive publishing is native: a conversation from months ago yields new songlines when you plant seeds that make old moments suddenly relevant.

**The end goal**: the InterBrain installation process allows users to point to their existing knowledge sources — vaults, forums, archives, interview collections. AURYN consolidates, purifies, and refactors their knowledge base into DreamNodes, keeping old data as backups. No risk, full reversibility. One person with high conceptual clarity about a knowledge landscape's topology can infuse that understanding into an ever-more-refined system prompt for the refactoring process. Once community collective intelligence starts applying and refining it, the capability compounds.

#### Learnings from Vault Consolidation (Jan-Feb 2026)

Four consolidation sessions migrated ~494 DreamNodes into RealDealVault from 12 source vaults. This established the operational patterns. Key insights:

**Two fundamentally different problems:**
- **Type A (completed)**: Mapping existing DreamNode repos from old vaults — mechanical (add `.udd`, Radicle ID, move directories). Solved with batch conversion in groups of ~25 with verification between batches.
- **Type B (not started)**: Refactoring unstructured content (Obsidian PKM vaults, markdown files, mixed personal data) into DreamNodes. Requires AI intelligence to determine what becomes what. The SecondBrain directory (99 items) is the benchmark dataset for this.

**Operational patterns that proved reliable:**
- Idempotent conversion — check what exists, only fill gaps, safe to rerun
- Move-to-trash over delete — organized by cleanup type and date
- DreamTalk media auto-detection (MP4 > GIF > PNG > JPEG > PDF > SVG, smaller preferred)
- Pre-cleanup phase first (remove editor artifacts, legacy metadata, empty dirs) before conversion
- Schema validation on `.udd` creation (the `dreamTalkMedia` vs `dreamTalk` inconsistency affected 33 files mid-batch)

**Intelligence required for Type B:**
- **Deduplication requires judgment, not just hashing** — deciding which version of a concept is "richer" (more content, more recent, better DreamTalk) is a creative decision
- **Dreamer nodes need special merge logic** — liminal-web.json must be unioned, not overwritten; images may need merging from multiple sources
- **Content classification** — standalone markdown → likely 1:1 DreamNode; structured directories → may be DreamNode-ready or need decomposition; personal/financial docs → may not belong as public DreamNodes; untitled stubs → noise to clean up; duplicates of existing DreamNodes → dedup needed
- **Thematic clustering** — topics naturally migrate in related clusters (e.g., all UAP-related nodes together); the tool should support cluster-based import
- **The consolidation process itself is a knowledge gardening act** — deciding what deserves sovereignty encodes understanding. Surface these decisions to the user rather than automating them away

**What the benchmark dataset (SecondBrain) contains:**
99 items including standalone idea files (A T A R A X I A.md, Dialectic.md, Miracle Consciousness.md), structured project directories (ABRAXAS, AntiGravityBong, Books, DailyNotes), personal documents (consulting bookkeeping, loan agreements), Obsidian infrastructure (Attachments, Templater, DailyNotes), and duplicates of existing DreamNodes (InterBrain.md, Project Liminality.md). This is representative of what normal users with an existing Second Brain will bring.

**Post-conversion cleanup is significant** — validation should be built into the flow, not an afterthought. Branch naming (`master` vs `main`), bad Radicle IDs, and edge cases in repos without commits all surfaced at scale.

**The consolidation process stress-tests the system** — scaling from 50 to 167 nodes revealed localStorage limits in the InterBrain plugin (Session 2). The SecondBrain consolidation will likely reveal new edge cases in AURYN's tooling. That's a feature — each round of consolidation teaches the system about itself.

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

**Voice Pipeline & Songlines:**
- Voice transcription (Whisper integration — own the full spoken-word-to-action lifecycle)
- Real-time copilot listening — surface relevant DreamNodes during live conversations, summarize afterwards
- Clip extraction — identify and clip relevant segments from conversations, associate clips with DreamNodes
- Batch transcript processing — ingest interview archives, extract concepts, consolidate clips from many sources into concept-level DreamNodes

**Knowledge Refactoring:**
- Unstructured files → DreamNodes (Type B: SecondBrain benchmark)
- Forum/archive ingestion — point at web-based knowledge repositories, parse structure, refactor into DreamNodes
- Transcript-to-DreamNode pipeline — process interview collections into concept-level DreamNodes with associated clips

**Other:**
- Situational assessment — pull submodule state → read DreamSong + READMEs → produce status report
- Submodule refresh — `git submodule update --remote` before assessment
- DreamTalk image intelligence — symbol generation using DreamTalk library constraints

**Owned by other DreamNodes (not AURYN tools):**
- GitHub Pages publishing → PRISM
- Platform mirroring → PRISM
- Torrent seeding → PRISM

## Roadmap (Prioritized for Spring Launch)

### Next Up
1. **Dreamweaving completion** — canvas-submodule sync (bidirectional enforcement of DreamSong-driven relationships)
2. **Knowledge refactoring** — SecondBrain consolidation as benchmark (Type B: unstructured → DreamNodes). Learning-by-doing to crystallize system prompt + custom tooling. End goal: InterBrain installation can absorb any knowledge source (vaults, forums, archives, interview collections).

### Medium Priority
- Songlines & voice pipeline (Whisper transcription, clip extraction, batch transcript processing, real-time copilot listening)
- Forum/archive ingestion (web-based knowledge repositories → DreamNodes)
- DreamTalk image intelligence (symbol generation, style references)
- Situational assessment + submodule refresh
- CLI tools (`auryn create`, `auryn search`, `auryn weave`)

### Future
- Spacebar/Dialogos mode (voice-driven intent recognition)
- Architecture flip (InterBrain imports AURYN)
- Cross-platform spawn_chat (Linux/Windows)
- Deep knowledge refactoring at scale (InPower Movement forum, Disclosure Project Intelligence Archive, and similar high-signal repositories)

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

### The Universal Principle

Build at the layer where more capability below you is unambiguously good news. If an announcement below your layer causes anxiety, you're building at the wrong layer. If it causes excitement, you're in the right place.

AURYN is a knowledge topology. No agentic framework is building this — they don't care about DreamNodes, DreamSongs, holarchic submodule relationships, cherry-pick sovereignty, coherence beacons, or the liminal web. They care about tool routing, context windows, and permission models. These concerns are complementary, not competitive.

The knowledge gardening layer is deeply human, inherently social, and resistant to pure automation. Someone with well-structured DreamNodes and rich DreamSongs gets dramatically better results from *any* agentic framework than someone with a flat folder of markdown files. AURYN is what makes every tool more effective.

### README as Universal Memory

- **Agent-agnostic**: Works with any AI — not coupled to any shell or provider
- **Human-readable**: Just markdown — the format that survives every platform shift
- **Git-versioned**: Full history — sovereignty through distributed version control
- **Composable**: Submodules cascade context — holarchic structure is native

The sophistication ceiling has been removed. In the agentic age, system design is no longer constrained by user operability. AURYN holds the knowledge of how collective dreamweaving works and operates it on your behalf. Users interact through natural language. AURYN does the gardening.

AURYN gives itself to every DreamNode. The Ouroboros — creating itself endlessly.
