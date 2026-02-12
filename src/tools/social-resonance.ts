/**
 * Social Resonance MCP Tools - Radicle operations, peer sync, collaboration memory
 *
 * Handles the P2P layer: publishing/cloning DreamNodes via Radicle,
 * following peers, fetching new commits, and tracking acceptance/rejection
 * history in collaboration-memory.json (stored in Dreamer nodes).
 */

import {
  findDreamNode,
  DreamNodeService,
  UDDService,
  commitAllChanges,
  DEFAULT_VAULT_PATH,
  type DreamNodeInfo,
} from '../services/standalone-adapter.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';

const execAsync = promisify(exec);

// ============================================================================
// COLLABORATION MEMORY SERVICE
// Stored in Dreamer nodes as collaboration-memory.json
// Tracks which commits from which DreamNodes have been accepted/rejected
// ============================================================================

export interface CollaborationMemoryEntry {
  originalHash: string;
  appliedHash?: string;
  relayedBy: string[];
  subject: string;
  timestamp: number;
}

export interface CollaborationMemoryFile {
  version: 1;
  dreamNodes: Record<string, {
    accepted: CollaborationMemoryEntry[];
    rejected: CollaborationMemoryEntry[];
  }>;
}

export class CollaborationMemoryService {
  static read(dreamerPath: string): CollaborationMemoryFile {
    const filePath = path.join(dreamerPath, 'collaboration-memory.json');
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      return JSON.parse(content) as CollaborationMemoryFile;
    } catch {
      return { version: 1, dreamNodes: {} };
    }
  }

  static write(dreamerPath: string, data: CollaborationMemoryFile): void {
    const filePath = path.join(dreamerPath, 'collaboration-memory.json');
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
  }

  static recordAcceptance(dreamerPath: string, nodeUuid: string, entry: CollaborationMemoryEntry): void {
    const data = this.read(dreamerPath);
    if (!data.dreamNodes[nodeUuid]) {
      data.dreamNodes[nodeUuid] = { accepted: [], rejected: [] };
    }
    data.dreamNodes[nodeUuid].accepted.push(entry);
    this.write(dreamerPath, data);
  }

  static recordRejection(dreamerPath: string, nodeUuid: string, entry: CollaborationMemoryEntry): void {
    const data = this.read(dreamerPath);
    if (!data.dreamNodes[nodeUuid]) {
      data.dreamNodes[nodeUuid] = { accepted: [], rejected: [] };
    }
    data.dreamNodes[nodeUuid].rejected.push(entry);
    this.write(dreamerPath, data);
  }

  static isProcessed(dreamerPath: string, nodeUuid: string, commitHash: string): 'accepted' | 'rejected' | null {
    const data = this.read(dreamerPath);
    const nodeData = data.dreamNodes[nodeUuid];
    if (!nodeData) return null;

    if (nodeData.accepted.some(e => e.originalHash === commitHash)) return 'accepted';
    if (nodeData.rejected.some(e => e.originalHash === commitHash)) return 'rejected';
    return null;
  }
}

// ============================================================================
// HELPER: Check if rad CLI is available
// ============================================================================

async function isRadicleAvailable(): Promise<boolean> {
  try {
    await execAsync('which rad');
    return true;
  } catch {
    return false;
  }
}

// ============================================================================
// TOOL HANDLERS
// ============================================================================

/**
 * Tool: radicle_clone
 * Clone a DreamNode from Radicle network into the vault
 */
async function radicleClone(args: {
  rid: string;
  vault_path?: string;
}): Promise<{
  success: boolean;
  node?: { uuid: string; title: string; type: string; path: string; rid: string };
  error?: string;
}> {
  try {
    if (!(await isRadicleAvailable())) {
      return { success: false, error: 'Radicle CLI (rad) is not installed or not in PATH' };
    }

    const vaultPath = args.vault_path || DEFAULT_VAULT_PATH;

    // Clone from Radicle network
    const { stdout } = await execAsync(
      `RAD_PASSPHRASE="" rad clone ${args.rid} --scope all`,
      { cwd: vaultPath, timeout: 60000 }
    );

    // rad clone creates a directory named after the repo
    // Extract the directory name from stdout or find the newest directory
    const dirNameMatch = stdout.match(/Cloning into '([^']+)'/);
    let clonedDir: string;

    if (dirNameMatch) {
      clonedDir = path.join(vaultPath, dirNameMatch[1]);
    } else {
      // Fallback: find most recently created directory
      const entries = fs.readdirSync(vaultPath, { withFileTypes: true });
      let newest = '';
      let newestTime = 0;
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        const fullPath = path.join(vaultPath, entry.name);
        const stat = fs.statSync(fullPath);
        if (stat.mtimeMs > newestTime) {
          newestTime = stat.mtimeMs;
          newest = fullPath;
        }
      }
      clonedDir = newest;
    }

    if (!clonedDir || !fs.existsSync(clonedDir)) {
      return { success: false, error: 'Clone appeared to succeed but could not locate cloned directory' };
    }

    // Read .udd to get DreamNode info
    const uddPath = path.join(clonedDir, '.udd');
    if (!fs.existsSync(uddPath)) {
      return { success: false, error: `Cloned repo at ${clonedDir} is not a DreamNode (no .udd file)` };
    }

    const udd = await UDDService.readUDD(clonedDir);

    return {
      success: true,
      node: {
        uuid: udd.uuid,
        title: udd.title,
        type: udd.type,
        path: clonedDir,
        rid: args.rid,
      },
    };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
}

/**
 * Tool: radicle_publish
 * Publish a local DreamNode to the Radicle network
 */
async function radiclePublish(args: {
  identifier: string;
}): Promise<{
  success: boolean;
  node?: { title: string; uuid: string; rid?: string };
  error?: string;
}> {
  try {
    if (!(await isRadicleAvailable())) {
      return { success: false, error: 'Radicle CLI (rad) is not installed or not in PATH' };
    }

    const node = await findDreamNode(args.identifier);
    if (!node) {
      return { success: false, error: `DreamNode not found: ${args.identifier}` };
    }

    // Publish to Radicle network (makes the repo publicly available)
    await execAsync('RAD_PASSPHRASE="" rad publish', { cwd: node.path, timeout: 30000 });

    // Sync and announce to seeders
    try {
      await execAsync('RAD_PASSPHRASE="" rad sync --announce', { cwd: node.path, timeout: 30000 });
    } catch {
      // Non-fatal: publish succeeded even if announce fails
    }

    return {
      success: true,
      node: { title: node.title, uuid: node.uuid, rid: node.radicleId },
    };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
}

/**
 * Tool: radicle_follow_peer
 * Follow a peer's DID and optionally add them as delegate to a DreamNode
 */
async function radicleFollowPeer(args: {
  did: string;
  node_identifier?: string;
  add_delegate?: boolean;
}): Promise<{
  success: boolean;
  followed: boolean;
  delegated?: boolean;
  error?: string;
}> {
  try {
    if (!(await isRadicleAvailable())) {
      return { success: false, followed: false, error: 'Radicle CLI (rad) is not installed or not in PATH' };
    }

    // Follow the peer
    await execAsync(`RAD_PASSPHRASE="" rad follow ${args.did}`, { timeout: 15000 });

    let delegated = false;

    // Optionally add as delegate to a specific DreamNode
    if (args.node_identifier && args.add_delegate) {
      const node = await findDreamNode(args.node_identifier);
      if (!node) {
        return { success: true, followed: true, delegated: false, error: `Followed peer, but DreamNode not found: ${args.node_identifier}` };
      }

      try {
        await execAsync(
          `RAD_PASSPHRASE="" rad id update --delegate ${args.did} --threshold 1`,
          { cwd: node.path, timeout: 15000 }
        );
        delegated = true;
      } catch (error) {
        return { success: true, followed: true, delegated: false, error: `Followed peer, but failed to add as delegate: ${error instanceof Error ? error.message : 'Unknown'}` };
      }
    }

    return { success: true, followed: true, delegated };
  } catch (error) {
    return { success: false, followed: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
}

/**
 * Tool: fetch_peer_commits
 * Fetch new commits from all peer remotes for a DreamNode
 */
export interface PendingCommit {
  hash: string;
  subject: string;
  author: string;
  date: string;
  offeredBy: string[];
  remoteName: string;
  beaconData?: Record<string, unknown>;
}

async function fetchPeerCommits(args: {
  identifier: string;
}): Promise<{
  success: boolean;
  node?: { title: string; uuid: string };
  pending_commits?: PendingCommit[];
  error?: string;
}> {
  try {
    const node = await findDreamNode(args.identifier);
    if (!node) {
      return { success: false, error: `DreamNode not found: ${args.identifier}` };
    }

    // Sync from Radicle network first (non-fatal)
    try {
      await execAsync('RAD_PASSPHRASE="" rad sync --inventory', { cwd: node.path, timeout: 30000 });
    } catch {
      // Non-fatal: may not be a Radicle repo or network unavailable
    }

    // Fetch from all remotes
    try {
      await execAsync('git fetch --all', { cwd: node.path, timeout: 30000 });
    } catch {
      // Non-fatal: may have no remotes
    }

    // Find commits on remote branches not on local main
    const pending: PendingCommit[] = [];
    const seenHashes = new Set<string>();

    // List all remote branches
    let remoteBranches: string[] = [];
    try {
      const { stdout } = await execAsync('git branch -r --format="%(refname:short)"', { cwd: node.path });
      remoteBranches = stdout.trim().split('\n').filter(b => b.length > 0 && !b.includes('HEAD'));
    } catch {
      // No remotes
    }

    for (const remoteBranch of remoteBranches) {
      try {
        // Find commits on this remote branch not on local main
        const { stdout } = await execAsync(
          `git log main..${remoteBranch} --format="%H|%s|%an|%aI" --no-merges`,
          { cwd: node.path }
        );

        const lines = stdout.trim().split('\n').filter(l => l.length > 0);
        const remoteName = remoteBranch.split('/')[0] || remoteBranch;

        for (const line of lines) {
          const [hash, subject, author, date] = line.split('|');
          if (!hash || seenHashes.has(hash)) continue;
          seenHashes.add(hash);

          // Check for beacon data in commit message
          let beaconData: Record<string, unknown> | undefined;
          try {
            const { stdout: fullMsg } = await execAsync(
              `git log -1 --format="%B" ${hash}`,
              { cwd: node.path }
            );
            const beaconMatch = fullMsg.match(/COHERENCE_BEACON:\s*(\{.*\})/);
            if (beaconMatch) {
              beaconData = JSON.parse(beaconMatch[1]);
            }
          } catch {
            // Non-fatal
          }

          pending.push({
            hash,
            subject: subject || '',
            author: author || '',
            date: date || '',
            offeredBy: [remoteName],
            remoteName,
            beaconData,
          });
        }
      } catch {
        // Skip branches that can't be compared
      }
    }

    // Merge offeredBy for duplicate hashes (shouldn't happen due to seenHashes, but defensive)
    return {
      success: true,
      node: { title: node.title, uuid: node.uuid },
      pending_commits: pending,
    };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
}

/**
 * Tool: list_pending_commits
 * List commits offered by peers that haven't been accepted or rejected yet
 */
async function listPendingCommits(args: {
  identifier: string;
  dreamer_identifier: string;
}): Promise<{
  success: boolean;
  node?: { title: string; uuid: string };
  pending_commits?: PendingCommit[];
  error?: string;
}> {
  try {
    const node = await findDreamNode(args.identifier);
    if (!node) {
      return { success: false, error: `DreamNode not found: ${args.identifier}` };
    }

    const dreamer = await findDreamNode(args.dreamer_identifier);
    if (!dreamer) {
      return { success: false, error: `Dreamer not found: ${args.dreamer_identifier}` };
    }
    if (dreamer.type !== 'dreamer') {
      return { success: false, error: `${dreamer.title} is a ${dreamer.type}, not a dreamer. Collaboration memory lives in Dreamer nodes.` };
    }

    // Fetch peer commits first
    const fetchResult = await fetchPeerCommits({ identifier: args.identifier });
    if (!fetchResult.success || !fetchResult.pending_commits) {
      return { success: false, error: fetchResult.error || 'Failed to fetch peer commits' };
    }

    // Filter out already-processed commits
    const unprocessed = fetchResult.pending_commits.filter(commit => {
      const status = CollaborationMemoryService.isProcessed(dreamer.path, node.uuid, commit.hash);
      return status === null;
    });

    return {
      success: true,
      node: { title: node.title, uuid: node.uuid },
      pending_commits: unprocessed,
    };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
}

/**
 * Tool: read_collaboration_memory
 * Read the full collaboration history for a Dreamer
 */
async function readCollaborationMemory(args: {
  dreamer_identifier: string;
  node_filter?: string;
}): Promise<{
  success: boolean;
  dreamer?: { title: string; uuid: string };
  memory?: CollaborationMemoryFile;
  filtered_node?: { title: string; uuid: string };
  error?: string;
}> {
  try {
    const dreamer = await findDreamNode(args.dreamer_identifier);
    if (!dreamer) {
      return { success: false, error: `Dreamer not found: ${args.dreamer_identifier}` };
    }
    if (dreamer.type !== 'dreamer') {
      return { success: false, error: `${dreamer.title} is a ${dreamer.type}, not a dreamer. Collaboration memory lives in Dreamer nodes.` };
    }

    const memory = CollaborationMemoryService.read(dreamer.path);

    // Optionally filter by a specific DreamNode
    if (args.node_filter) {
      const filterNode = await findDreamNode(args.node_filter);
      if (!filterNode) {
        return { success: false, error: `Filter node not found: ${args.node_filter}` };
      }

      const filtered: CollaborationMemoryFile = {
        version: 1,
        dreamNodes: {},
      };
      if (memory.dreamNodes[filterNode.uuid]) {
        filtered.dreamNodes[filterNode.uuid] = memory.dreamNodes[filterNode.uuid];
      }

      return {
        success: true,
        dreamer: { title: dreamer.title, uuid: dreamer.uuid },
        memory: filtered,
        filtered_node: { title: filterNode.title, uuid: filterNode.uuid },
      };
    }

    return {
      success: true,
      dreamer: { title: dreamer.title, uuid: dreamer.uuid },
      memory,
    };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
}

// ============================================================================
// TOOL EXPORTS
// ============================================================================

export const socialResonanceTools = {
  radicle_clone: {
    name: 'radicle_clone',
    description: 'Clone a DreamNode from the Radicle network into the vault by its Radicle ID (RID). Returns the cloned node\'s metadata.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        rid: {
          type: 'string',
          description: 'Radicle ID of the DreamNode to clone (e.g., "rad:z...")',
        },
        vault_path: {
          type: 'string',
          description: 'Path to vault where the clone should be placed (defaults to primary vault)',
        },
      },
      required: ['rid'],
    },
    handler: radicleClone,
  },

  radicle_publish: {
    name: 'radicle_publish',
    description: 'Publish a local DreamNode to the Radicle network, making it shareable with peers. Also announces to seeders.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        identifier: {
          type: 'string',
          description: 'UUID or title of the DreamNode to publish',
        },
      },
      required: ['identifier'],
    },
    handler: radiclePublish,
  },

  radicle_follow_peer: {
    name: 'radicle_follow_peer',
    description: 'Follow a peer\'s DID on the Radicle network. Optionally add them as a delegate to a specific DreamNode, allowing them to push changes.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        did: {
          type: 'string',
          description: 'The peer\'s DID (Decentralized Identifier) to follow',
        },
        node_identifier: {
          type: 'string',
          description: 'UUID or title of a DreamNode to add the peer as delegate (optional)',
        },
        add_delegate: {
          type: 'boolean',
          description: 'Whether to add the peer as a delegate to the specified DreamNode (default: false)',
        },
      },
      required: ['did'],
    },
    handler: radicleFollowPeer,
  },

  fetch_peer_commits: {
    name: 'fetch_peer_commits',
    description: 'Fetch new commits from all peer remotes for a DreamNode. Syncs from Radicle network, fetches all remotes, and returns commits not yet on local main.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        identifier: {
          type: 'string',
          description: 'UUID or title of the DreamNode to fetch commits for',
        },
      },
      required: ['identifier'],
    },
    handler: fetchPeerCommits,
  },

  list_pending_commits: {
    name: 'list_pending_commits',
    description: 'List peer commits that haven\'t been accepted or rejected yet. Filters fetch_peer_commits results through the Dreamer\'s collaboration memory.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        identifier: {
          type: 'string',
          description: 'UUID or title of the DreamNode to check',
        },
        dreamer_identifier: {
          type: 'string',
          description: 'UUID or title of the Dreamer whose collaboration memory to check against',
        },
      },
      required: ['identifier', 'dreamer_identifier'],
    },
    handler: listPendingCommits,
  },

  read_collaboration_memory: {
    name: 'read_collaboration_memory',
    description: 'Read the full collaboration history (accepted/rejected commits) for a Dreamer. Optionally filter by a specific DreamNode.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        dreamer_identifier: {
          type: 'string',
          description: 'UUID or title of the Dreamer whose collaboration memory to read',
        },
        node_filter: {
          type: 'string',
          description: 'UUID or title of a DreamNode to filter by (optional)',
        },
      },
      required: ['dreamer_identifier'],
    },
    handler: readCollaborationMemory,
  },
};
