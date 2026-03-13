# AURYN

@README.md

## Commit After Every Change

After each meaningful change (file edit, feature implementation, bug fix), create a git commit with a concise, descriptive message. Commit early and often — granular history is preferred over batched commits. This provides observability and prevents work loss.

## Remote Access & Server Safety

David may be accessing AURYN remotely — from a phone, a laptop on the road, or any situation where he cannot SSH in or manually intervene. This makes server health a critical responsibility.

**Before making any changes**, think through whether they could interrupt the running server process. Changes to `aurin.py`, dependencies, config, or anything that affects the running process are high-stakes: if the server goes down and isn't brought back up cleanly, David loses all access and may be stranded with no way to recover.

**After any change that touches server code or requires a restart:**
- Stop the old process gracefully
- Start fresh
- Confirm the server is listening and responding (e.g. `curl -sk https://localhost:8080/ | head -1`)
- Only report the task done once the server is confirmed healthy

**If a restart fails or the server is unhealthy after changes:** attempt to roll back or fix before reporting back. Never leave the server in a broken state.

**Pure content changes** (README edits, documentation, non-server files) do not require a restart — only restart when necessary.

Always report the final server status at the end of any task that touched the server.

## Submodule Context

### Software Gardening — The Philosophy AURYN Embodies

AURYN facilitates software gardening / knowledge gardening. This submodule defines the principles and values that govern how AURYN behaves: organic cultivation over mechanical construction, holonic structure, semantic discovery, cherry-pick resonance, and the submodule development pattern.

When working through AURYN, these principles are already internalized - users don't need to explicitly request "knowledge gardening workflow." AURYN naturally:
- Uses context-provider for semantic discovery before acting
- Creates sovereign DreamNodes with submodule relationships
- Lets vision accumulate in READMEs before implementation
- Backpropagates mature changes to source repos
- READMEs only reference submodules — never supermodules (a DreamNode links downward to what it contains, never upward to what contains it)

@Software Gardening/README.md

### InterBrain — The Ontology AURYN Operates On

InterBrain defines what DreamNodes are, how they relate (submodules, liminal web), and the broader vision they serve. This is the source of truth for AURYN's domain model.

When AURYN needs to understand DreamNode structure, relationships, or the InterBrain's feature architecture, the InterBrain DreamNode (at vault root) is the reference. The InterBrain submodule was removed from AURYN — it served its prototyping purpose and now lives independently.
