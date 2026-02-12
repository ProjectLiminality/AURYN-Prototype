/**
 * Coherence Beacon MCP Tools - Beacon signaling after dreamweaving
 *
 * When a Dreamer weaves DreamNodes into a DreamSong, the Coherence Beacon
 * creates a special commit with structured metadata. Peers scanning for
 * beacons can discover what was woven and decide whether to accept the
 * higher-order DreamNode.
 *
 * Beacon metadata is embedded in commit messages as a structured trailer:
 *   COHERENCE_BEACON: {"weavedNodes":["<rid1>","<rid2>"],"weavedAt":"<iso>","weaver":"<did>"}
 */

import {
  findDreamNode,
  commitAllChanges,
} from '../services/standalone-adapter.js';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// ============================================================================
// HELPERS
// ============================================================================

async function getLocalDID(): Promise<string | null> {
  try {
    const { stdout } = await execAsync('RAD_PASSPHRASE="" rad inspect --identity');
    const didMatch = stdout.match(/did:key:[a-zA-Z0-9]+/);
    return didMatch ? didMatch[0] : null;
  } catch {
    return null;
  }
}

// ============================================================================
// TOOL HANDLERS
// ============================================================================

/**
 * Tool: ignite_beacon
 * Create beacon commits in a DreamNode after weaving a DreamSong
 */
async function igniteBeacon(args: {
  identifier: string;
  weaved_node_rids: string[];
}): Promise<{
  success: boolean;
  commit_hash?: string;
  beacon_data?: Record<string, unknown>;
  synced?: boolean;
  error?: string;
}> {
  try {
    const node = await findDreamNode(args.identifier);
    if (!node) {
      return { success: false, error: `DreamNode not found: ${args.identifier}` };
    }

    if (!args.weaved_node_rids || args.weaved_node_rids.length === 0) {
      return { success: false, error: 'At least one weaved node RID is required' };
    }

    // Get local DID for weaver identity
    const weaver = await getLocalDID();

    // Construct beacon metadata
    const beaconData = {
      weavedNodes: args.weaved_node_rids,
      weavedAt: new Date().toISOString(),
      weaver: weaver || 'unknown',
    };

    const beaconJson = JSON.stringify(beaconData);

    // Create beacon commit
    const commitMsg = `Weave DreamSong: ${node.title}\n\nCOHERENCE_BEACON: ${beaconJson}`;
    try {
      await commitAllChanges(node.path, commitMsg);
    } catch {
      // If nothing to commit, create an empty commit
      await execAsync(
        `git commit --allow-empty -m "${commitMsg.replace(/"/g, '\\"')}"`,
        { cwd: node.path }
      );
    }

    // Get commit hash
    const { stdout: hashOut } = await execAsync('git rev-parse HEAD', { cwd: node.path });
    const commitHash = hashOut.trim();

    // Sync to Radicle network (non-fatal)
    let synced = false;
    try {
      await execAsync('RAD_PASSPHRASE="" rad sync --announce', { cwd: node.path, timeout: 15000 });
      synced = true;
    } catch {
      // Non-fatal: node may not be on Radicle network
    }

    return {
      success: true,
      commit_hash: commitHash,
      beacon_data: beaconData,
      synced,
    };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
}

/**
 * Tool: detect_beacons
 * Scan incoming peer commits for beacon metadata
 */
async function detectBeacons(args: {
  identifier: string;
}): Promise<{
  success: boolean;
  node?: { title: string; uuid: string };
  beacons?: Array<{
    commit_hash: string;
    subject: string;
    author: string;
    date: string;
    beacon_data: Record<string, unknown>;
    remote_branch: string;
  }>;
  error?: string;
}> {
  try {
    const node = await findDreamNode(args.identifier);
    if (!node) {
      return { success: false, error: `DreamNode not found: ${args.identifier}` };
    }

    // Fetch latest from all remotes (non-fatal)
    try {
      await execAsync('git fetch --all', { cwd: node.path, timeout: 30000 });
    } catch {
      // Non-fatal
    }

    // Search for beacon commits in all remote branches not on local branches
    const beacons: Array<{
      commit_hash: string;
      subject: string;
      author: string;
      date: string;
      beacon_data: Record<string, unknown>;
      remote_branch: string;
    }> = [];

    try {
      // Find all commits with COHERENCE_BEACON that are on remote branches but not local
      const { stdout } = await execAsync(
        'git log --all --grep="COHERENCE_BEACON" --not --branches --format="%H|%s|%an|%aI|%D"',
        { cwd: node.path }
      );

      const lines = stdout.trim().split('\n').filter(l => l.length > 0);

      for (const line of lines) {
        const parts = line.split('|');
        const commitHash = parts[0];
        const subject = parts[1] || '';
        const author = parts[2] || '';
        const date = parts[3] || '';
        const refs = parts[4] || '';

        if (!commitHash) continue;

        // Extract beacon data from full commit message
        try {
          const { stdout: fullMsg } = await execAsync(
            `git log -1 --format="%B" ${commitHash}`,
            { cwd: node.path }
          );

          const beaconMatch = fullMsg.match(/COHERENCE_BEACON:\s*(\{.*\})/);
          if (beaconMatch) {
            const beaconData = JSON.parse(beaconMatch[1]);

            // Determine remote branch
            let remoteBranch = 'unknown';
            const refMatch = refs.match(/([^,\s]+\/[^,\s]+)/);
            if (refMatch) {
              remoteBranch = refMatch[1];
            }

            beacons.push({
              commit_hash: commitHash,
              subject,
              author,
              date,
              beacon_data: beaconData,
              remote_branch: remoteBranch,
            });
          }
        } catch {
          // Skip commits with unparseable beacon data
        }
      }
    } catch {
      // No matching commits found — not an error
    }

    return {
      success: true,
      node: { title: node.title, uuid: node.uuid },
      beacons,
    };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
}

// ============================================================================
// TOOL EXPORTS
// ============================================================================

export const coherenceBeaconTools = {
  ignite_beacon: {
    name: 'ignite_beacon',
    description: 'Create a coherence beacon commit after weaving a DreamSong. Embeds structured metadata about which DreamNodes were woven, then announces to the Radicle network. Peers scanning for beacons will discover the weave.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        identifier: {
          type: 'string',
          description: 'UUID or title of the DreamNode that was woven (the one containing the DreamSong)',
        },
        weaved_node_rids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Radicle IDs of the DreamNodes that were woven together in the DreamSong',
        },
      },
      required: ['identifier', 'weaved_node_rids'],
    },
    handler: igniteBeacon,
  },

  detect_beacons: {
    name: 'detect_beacons',
    description: 'Scan incoming peer commits for coherence beacon metadata. Fetches from all remotes and finds beacon commits not yet on local branches. Returns beacon data including which DreamNodes were woven and by whom.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        identifier: {
          type: 'string',
          description: 'UUID or title of the DreamNode to scan for beacons',
        },
      },
      required: ['identifier'],
    },
    handler: detectBeacons,
  },
};
