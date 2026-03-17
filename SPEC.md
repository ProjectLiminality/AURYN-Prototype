# AURYN — Definitive Spec

A voice-first knowledge gardening agent. Maintains a living, coherent digital twin of your interior — your knowledge garden.

AURYN's domain is the **liminal space between contexts** (DreamNodes). It manages context boundaries, relationships, and the routing of knowledge across them. Within any given DreamNode, generalized agents handle domain-specific work (coding, building, creating). AURYN tends the garden; other tools till the soil within each plot.

## Anatomy of a DreamNode

A DreamNode is a context boundary — a folder containing files.

**Required:**
- **Title** — the name of the context. Folder name derived automatically (PascalCase).
- **README** — the identity document. A one-pager written in natural language that makes the DreamNode detectable and legible. Contains `[Title](dreamnode://id)` references to other DreamNodes inline — these references ARE the holarchic structure. May contain `- [ ]` to-do items (optionally with dates) for parseable action items. No imposed section structure beyond this.

**Derived (never manually managed):**
- **.udd metadata** — UUID, type, sub/supermodule lists. Sub/supermodule relationships are derived from README references and updated automatically by tooling.
- **Folder name** — derived from title.
- **License** — copied from template.
- **Git init, Radicle init** — handled by tooling on creation.

**Optional enrichment:**
- **DreamTalk symbol** — visual identity (image/animation). Absence is flagged by garden state as a growth opportunity.
- **DreamSong.canvas** — legacy/alternative DreamSong format (Obsidian canvas). If present, loaded into context alongside the README using topological sort for correct reading order.
- **Files** — any other content. The README summarizes what's here.

**A DreamNode is well-defined when it has a title and a meaningful README. Everything else is enrichment.**

All DreamNodes are sovereign — they live at the vault root. When DreamNode A references DreamNode B in its README, B becomes a submodule of A. But B remains sovereign at vault root. The submodule clone inside A points to the local sovereign B as its origin. This is enforced by tooling, never managed by AURYN.

## The One Rule

**No circular imports.** References are vertical (parent → child). A parent's README references its children; a child's README never references its parent. Horizontal peer relationships are expressed through shared parentage — both referenced by a common parent. This is software dependency semantics applied to all knowledge.

## Core Loop

**Receive knowledge → search existing garden → integrate.**

Same operation always, regardless of input type:
- Stream of consciousness
- Dialogue transcript
- Typed chat message
- Dropped file, photo, link
- Entire file system / SecondBrain import

The existing garden is the crystallization surface. New knowledge either finds a home in existing DreamNodes (route to README) or, when the garden genuinely has no home for it, a new DreamNode is proposed. AURYN never structures knowledge in a void — it always structures relative to the existing garden.

The richer and more coherent the existing READMEs, the more precisely new knowledge finds its home. The garden grows like a snowflake — always from the existing structure outward, never imposed top-down.

## Structural Operations

All structural operations on context boundaries are expressed as combinations of README edits and deterministic tool calls. AURYN provides only what requires LLM intelligence (content decisions). Tools handle all file system, git, Radicle, and cross-reference integrity logic.

**Route** — add/update text in an existing README. Pure content, no structural change. The simplest and most common operation.

**Pop-out** (analysis) — one context becomes two. AURYN recognizes that a term or section within a README deserves its own sovereign DreamNode. It provides: the title for the new DreamNode, the initial README content, and a diff for the parent README (replacing inline content with a `dreamnode://` reference). The tool handles: creating the sovereign DreamNode, git init, submodule wiring, Radicle init, context branch creation, DreamSong canvas updates. One command, all information upfront.

**Merge** (synthesis) — two contexts become one. Auto-detects peer merge vs. absorb merge (when one is already a submodule of the other). AURYN provides: source and target identifiers, the merged title, and the synthesized README. The tool handles: git history merging, identity assignment (new UUID for peer merge, preserved UUID for absorb), Radicle management (ghost forks for backpropagation), all cross-vault reference updates (liminal web, submodule parents, DreamSong canvases, .udd supermodules), merge ancestry tracking, cleanup. One command, all information upfront.

**Signals for structural change:**
- A term appears across multiple READMEs without its own DreamNode → pop-out candidate
- Two DreamNodes' READMEs describe essentially the same thing → merge candidate
- A README has grown large with inline definitions that could stand alone → pop-out candidates within it

## Songline Provenance

When input is a transcript (has timestamps, corresponds to an audio/video file): alongside README routing, AURYN identifies high-signal segments — coherent explanations of concepts that correspond to DreamNodes — and attaches them as songline clips.

Songline clips are decoupled from README updates:
- A clip can exist without a README change (the explanation wasn't novel, but it was clear and worth preserving as spoken-word provenance)
- A README can be updated without a clip (the insight came from typed text, or was an instruction)

AURYN provides: the DreamNode, the relevant transcript segment ranges, and the source file reference. The tool handles: timestamp derivation, file linking, storage. The segments can be non-contiguous (a concept explained, returned to later, explained further).

## CLI Tools

All tools are subcommands of `aurin`, invoked via bash. AURYN composes them freely. All tools that operate on existing DreamNodes take UUID as the identifier (title is for human-facing conversation only; ID and title always travel together in context).

```
aurin search <file_or_text> [--top N]
```
Relevance realization. BM25 + vocabulary matching with sliding window for files. Returns ranked DreamNodes with relevance scores. Accepts file path or inline text.

```
aurin read <id> [--deep]
```
Returns .udd metadata + README + DreamSong.canvas (if non-trivial, topologically sorted) + file tree + last 5 git commits (oneline). With `--deep`: also returns contents of key files (README, markdown files, package.json, main entry points — heuristically selected).

```
aurin write <id> --diff <diff>
```
Edit a README. Diff-based (old text → new text). Downstream hooks fire automatically: detect new/removed `dreamnode://` references → clone/remove submodules → update .udd metadata. Auto-committed.

```
aurin create <title> --readme <content>
```
Create a new sovereign DreamNode. Title is required, README content is required (must be meaningful — a dark DreamNode is useless). Tool handles: PascalCase folder name, git init, .udd with generated UUID, template files, Radicle init. Returns the new UUID.

```
aurin merge <source_id> <target_id> --title <name> --readme <synthesized_content> [--confirm]
```
Merge two DreamNodes. Source is absorbed into target. Auto-detects absorb merge (source is submodule of target) vs. peer merge. Tool handles all 8 phases: validation, git history merge, identity, Radicle, cross-vault reference updates, cleanup. Reports affected DreamNodes for user awareness.

```
aurin pop-out <parent_id> --title <name> --readme <content> --diff <parent_diff>
```
Extract a concept from a parent into a new sovereign DreamNode. Tool handles: create sovereign, git init, submodule wiring, Radicle init, DreamSong canvas updates, context branch. Parent diff replaces inline content with `dreamnode://` reference.

```
aurin clip <id> --segments <ranges> --source <file>
```
Attach songline clip provenance to a DreamNode. Segments are transcript ranges. Tool handles timestamp derivation and storage.

```
aurin publish <id>
```
Squash local commit history into meaningful units, push to Radicle remote. Curated signal, not raw experimentation.

```
aurin reveal <file_path>
```
Open a file in the UI for the user. The containing DreamNode is automatically selected.

```
aurin garden-state [--refresh]
```
Scan the garden, write `~/.auryn/garden-state.md`. Not called by AURYN directly — run by cron job. Details in Garden State section below.

## Passive Context

AURYN never invokes these — they are always loaded.

**1. User profile (permanent)**
Who this person is, values, preferences, how they want to be assisted. Most stable layer.

**2. Garden state (daily, cron-updated)**
Cached markdown at `~/.auryn/garden-state.md`. What's alive in the garden right now. Details in Garden State section.

**3. UI state (session, continuously updated)**
Fed by the UI: currently selected DreamNode (loaded into context), currently open file, interaction history (sequence of DreamNode selections by title+ID). AURYN can read what the user is looking at but doesn't request it — the UI pushes this context.

**4. Search results (conversational, triggered by input)**
Vocabulary matching runs in real time during transcription, loading petals. BM25 sliding window runs when the user sends a message. Relevant DreamNodes are loaded into context before AURYN sees the input. AURYN never encounters input in a void.

Gradient from most stable to most ephemeral: user profile → garden state → UI state → search results.

## Garden State

The garden state mechanism serves two purposes: autonomous maintenance of garden health, and surfacing what needs human attention.

### Cron Job Phases

**Phase 1: Programmatic (no LLM, no human)**
- Metadata validation and repair (.udd schema, missing fields, format issues)
- Sovereign ↔ submodule divergence detection and sync (within the user's own garden)
- Index rebuilding for changed DreamNodes
- Closes gaps immediately, reports what it did

**Phase 2: AURYN autonomous (LLM, no human yet)**

Processes DreamNodes flagged in Phase 1 as needing LLM attention:

*Pass 1 — Intra-context enrichment:*
- **Dark DreamNodes** (boilerplate README, but has files): `aurin read --deep`, then draft a README from file analysis. Committed with `<!-- auryn-draft -->` marker.
- **Dim DreamNodes** (some README content but shallow/outdated): read normally, suggest enrichments. Committed as draft.
- **Unlit DreamNodes** (boilerplate README, no files): flagged for user interview — nothing to pre-process.

*Pass 2 — Inter-context cluster discovery:*
- For each DreamNode that Pass 1 just enriched: run `aurin search` using its new README
- Clusters emerge — DreamNodes whose READMEs share significant terms
- For each cluster: read all READMEs together, propose structural relationships
- **Boundary rule**: every proposed action must involve at least one DreamNode from the Pass 1 set. Existing coherent DreamNodes participate in cluster discovery as read-only context but are never themselves restructured. The existing garden is the stable crystallization surface.
- Proposals saved as drafts awaiting user review

**Phase 3: Time-sensitive parsing**
- Scan all READMEs for `- [ ]` to-do items, deadline patterns, date references
- Detect creation dates via git blame
- Surface upcoming deadlines, aging action items

### Garden State Document Structure

```
## Completed (programmatic)
- Fixed .udd schema in N DreamNodes
- Synced N submodule divergences

## AURYN drafts (awaiting user review)
- DreamNode "X" (id): README drafted from file analysis
- Cluster proposal: {A, B, C} — suggested holarchy
- Pop-out candidate: "term" appears in N READMEs

## Needs user input
- DreamNode "Y" (id): title only, no files — interview needed
- DreamNode "Z" (id): has files but purpose unclear

## Growth opportunities
- N DreamNodes missing DreamTalk symbol
- N broken dreamnode:// references (target doesn't exist)

## Time-sensitive
- "Car inspection" due March 20 (from DreamNode "DavidsCar" id)
- "Video call" Tuesday 4pm (from DreamNode "OMSN" id)
- N action items older than 30 days without progress

## Peer activity
- N incoming commits from peers not yet processed
- N beacon signals detected
```

## System Prompt Scope

The system prompt encodes:
- AURYN's identity as a knowledge gardening agent
- The one rule (no circular imports — vertical references only)
- Concept classification: when to route to existing vs. propose new DreamNode
- The detective-work-first principle: always pre-process before asking the user
- Songline clip criteria: what qualifies as a high-signal spoken-word segment
- Draft marker convention: autonomous work is marked and queued for review
- Which tools AURYN actively calls (search, read, write, create, merge, pop-out, clip, publish, reveal) vs. which are passive (garden-state, UI state, search-on-send)
- Conversational rhythm: no rigid modes — knowledge gardening is always what's happening

The system prompt does NOT encode:
- Implementation details of downstream hooks (submodule wiring, metadata updates)
- Git/Radicle internals
- Tool implementation details
- Anything the LLM already knows how to do (summarization, reasoning, language understanding)

## What AURYN Is Not

- Not a coding agent — generalized execution tools handle within-context work
- Not a file system manipulator — all structural operations go through the `aurin` CLI
- Not a UI framework — the InterBrain UI is a separate concern; AURYN reads from and writes to it via reveal and UI state
- Not a replacement for human vision — AURYN tends the garden, the human decides what to grow
