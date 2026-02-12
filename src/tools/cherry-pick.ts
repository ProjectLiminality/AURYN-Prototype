/**
 * Cherry-Pick Workflow MCP Tools - State machine for P2P commit collaboration
 *
 * Implements the full cherry-pick preview/accept/reject/cancel workflow.
 * State is persisted in .cherry-pick-state.json inside each DreamNode
 * so the workflow survives process restarts and the InterBrain UI can
 * render current state at any time.
 *
 * State Machine:
 *   IDLE → fetch_peer_commits → PENDING (commits available)
 *   PENDING → cherry_pick_preview → PREVIEWING (stash, cherry-pick --no-commit)
 *   PREVIEWING → cherry_pick_accept → IDLE (commit, record, unstash)
 *   PREVIEWING → cherry_pick_reject → IDLE (reset, record, unstash)
 *   PREVIEWING → cherry_pick_cancel → IDLE (reset, unstash, no record)
 *   PREVIEWING → [conflict] → CONFLICT (files listed)
 *   CONFLICT → [manual resolve + git add] → PREVIEWING
 */

import {
  findDreamNode,
} from '../services/standalone-adapter.js';
import { CollaborationMemoryService, type PendingCommit } from './social-resonance.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';

const execAsync = promisify(exec);

// ============================================================================
// CHERRY-PICK STATE SERVICE
// Stored in DreamNode dir as .cherry-pick-state.json
// ============================================================================

export interface CherryPickState {
  status: 'idle' | 'pending' | 'previewing' | 'conflict';
  pendingCommits?: PendingCommit[];
  activeCommit?: PendingCommit;
  stashRef?: string;
  conflictFiles?: string[];
  previewDiff?: string;
  startedAt?: string;
}

export class CherryPickStateService {
  static read(nodePath: string): CherryPickState {
    const filePath = path.join(nodePath, '.cherry-pick-state.json');
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      return JSON.parse(content) as CherryPickState;
    } catch {
      return { status: 'idle' };
    }
  }

  static write(nodePath: string, state: CherryPickState): void {
    const filePath = path.join(nodePath, '.cherry-pick-state.json');
    fs.writeFileSync(filePath, JSON.stringify(state, null, 2), 'utf-8');
  }

  static clear(nodePath: string): void {
    const filePath = path.join(nodePath, '.cherry-pick-state.json');
    try {
      fs.unlinkSync(filePath);
    } catch {
      // Already gone
    }
  }
}

// ============================================================================
// HELPERS
// ============================================================================

async function isWorkingTreeDirty(repoPath: string): Promise<boolean> {
  const { stdout } = await execAsync('git status --porcelain', { cwd: repoPath });
  return stdout.trim() !== '';
}

async function stashIfDirty(repoPath: string): Promise<string | undefined> {
  if (!(await isWorkingTreeDirty(repoPath))) return undefined;

  // Get stash list count before
  let countBefore = 0;
  try {
    const { stdout } = await execAsync('git stash list', { cwd: repoPath });
    countBefore = stdout.trim().split('\n').filter(l => l.length > 0).length;
  } catch { /* empty */ }

  await execAsync('git stash push -m "auryn-cherry-pick-preview"', { cwd: repoPath });

  // Get stash ref
  let countAfter = 0;
  try {
    const { stdout } = await execAsync('git stash list', { cwd: repoPath });
    countAfter = stdout.trim().split('\n').filter(l => l.length > 0).length;
  } catch { /* empty */ }

  if (countAfter > countBefore) {
    return 'stash@{0}';
  }
  return undefined;
}

async function unstash(repoPath: string, stashRef: string | undefined): Promise<{ restored: boolean; warning?: string }> {
  if (!stashRef) return { restored: false };

  try {
    await execAsync('git stash pop', { cwd: repoPath });
    return { restored: true };
  } catch (error) {
    // Stash pop can fail due to conflicts — warn but don't fail the operation
    return {
      restored: false,
      warning: `Stash pop had conflicts. Your stashed changes are still in the stash. Run 'git stash pop' manually to resolve. Error: ${error instanceof Error ? error.message : 'Unknown'}`,
    };
  }
}

// ============================================================================
// TOOL HANDLERS
// ============================================================================

/**
 * Tool: cherry_pick_preview
 * Enter preview state: stash local changes, cherry-pick commit, show diff
 */
async function cherryPickPreview(args: {
  identifier: string;
  commit_hash: string;
}): Promise<{
  success: boolean;
  status?: 'previewing' | 'conflict';
  diff?: string;
  conflict_files?: string[];
  commit?: { hash: string; subject: string };
  error?: string;
}> {
  try {
    const node = await findDreamNode(args.identifier);
    if (!node) {
      return { success: false, error: `DreamNode not found: ${args.identifier}` };
    }

    // Check current state — must be idle
    const currentState = CherryPickStateService.read(node.path);
    if (currentState.status !== 'idle') {
      return {
        success: false,
        error: `Cherry-pick workflow is already active (status: ${currentState.status}). Cancel or complete the current preview first.`,
      };
    }

    // Get commit info
    let subject = '';
    let author = '';
    let date = '';
    try {
      const { stdout } = await execAsync(
        `git log -1 --format="%s|%an|%aI" ${args.commit_hash}`,
        { cwd: node.path }
      );
      const parts = stdout.trim().split('|');
      subject = parts[0] || '';
      author = parts[1] || '';
      date = parts[2] || '';
    } catch {
      return { success: false, error: `Commit not found: ${args.commit_hash}. Run fetch_peer_commits first.` };
    }

    // Stash local changes if dirty
    const stashRef = await stashIfDirty(node.path);

    // Cherry-pick --no-commit
    let hasConflict = false;
    try {
      await execAsync(`git cherry-pick ${args.commit_hash} --no-commit`, { cwd: node.path });
    } catch {
      hasConflict = true;
    }

    const activeCommit: PendingCommit = {
      hash: args.commit_hash,
      subject,
      author,
      date,
      offeredBy: [],
      remoteName: '',
    };

    if (hasConflict) {
      // Detect conflict files
      let conflictFiles: string[] = [];
      try {
        const { stdout } = await execAsync('git diff --name-only --diff-filter=U', { cwd: node.path });
        conflictFiles = stdout.trim().split('\n').filter(f => f.length > 0);
      } catch { /* empty */ }

      const state: CherryPickState = {
        status: 'conflict',
        activeCommit,
        stashRef,
        conflictFiles,
        startedAt: new Date().toISOString(),
      };
      CherryPickStateService.write(node.path, state);

      return {
        success: true,
        status: 'conflict',
        conflict_files: conflictFiles,
        commit: { hash: args.commit_hash, subject },
      };
    }

    // Get diff preview
    let diff = '';
    try {
      const { stdout } = await execAsync('git diff --cached --stat', { cwd: node.path });
      diff = stdout.trim();
    } catch { /* empty */ }

    const state: CherryPickState = {
      status: 'previewing',
      activeCommit,
      stashRef,
      previewDiff: diff,
      startedAt: new Date().toISOString(),
    };
    CherryPickStateService.write(node.path, state);

    return {
      success: true,
      status: 'previewing',
      diff,
      commit: { hash: args.commit_hash, subject },
    };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
}

/**
 * Tool: cherry_pick_accept
 * Accept the previewed commit: finalize, record in collaboration memory, unstash
 */
async function cherryPickAccept(args: {
  identifier: string;
  dreamer_identifier: string;
}): Promise<{
  success: boolean;
  applied_hash?: string;
  original_hash?: string;
  stash_warning?: string;
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
      return { success: false, error: `${dreamer.title} is a ${dreamer.type}, not a dreamer` };
    }

    const state = CherryPickStateService.read(node.path);
    if (state.status !== 'previewing') {
      return { success: false, error: `Cannot accept: workflow status is '${state.status}', expected 'previewing'. Resolve conflicts first if in conflict state.` };
    }

    if (!state.activeCommit) {
      return { success: false, error: 'No active commit in preview state' };
    }

    // Commit with original message + cherry-pick trailer
    const commitMsg = `${state.activeCommit.subject}\n\n(cherry picked from commit ${state.activeCommit.hash})`;
    await execAsync(
      `git commit -m "${commitMsg.replace(/"/g, '\\"')}"`,
      { cwd: node.path }
    );

    // Get applied hash
    const { stdout: headHash } = await execAsync('git rev-parse HEAD', { cwd: node.path });
    const appliedHash = headHash.trim();

    // Record in collaboration memory
    CollaborationMemoryService.recordAcceptance(dreamer.path, node.uuid, {
      originalHash: state.activeCommit.hash,
      appliedHash,
      relayedBy: state.activeCommit.offeredBy,
      subject: state.activeCommit.subject,
      timestamp: Date.now(),
    });

    // Unstash
    const unstashResult = await unstash(node.path, state.stashRef);

    // Clear state
    CherryPickStateService.clear(node.path);

    return {
      success: true,
      applied_hash: appliedHash,
      original_hash: state.activeCommit.hash,
      stash_warning: unstashResult.warning,
    };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
}

/**
 * Tool: cherry_pick_reject
 * Reject the previewed commit: reset, record rejection, unstash
 */
async function cherryPickReject(args: {
  identifier: string;
  dreamer_identifier: string;
  reason?: string;
}): Promise<{
  success: boolean;
  rejected_hash?: string;
  stash_warning?: string;
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
      return { success: false, error: `${dreamer.title} is a ${dreamer.type}, not a dreamer` };
    }

    const state = CherryPickStateService.read(node.path);
    if (state.status !== 'previewing' && state.status !== 'conflict') {
      return { success: false, error: `Cannot reject: workflow status is '${state.status}', expected 'previewing' or 'conflict'` };
    }

    if (!state.activeCommit) {
      return { success: false, error: 'No active commit in state' };
    }

    // Abort cherry-pick / reset
    try {
      await execAsync('git cherry-pick --abort', { cwd: node.path });
    } catch {
      // If cherry-pick --abort fails, try hard reset
      try {
        await execAsync('git reset --hard HEAD', { cwd: node.path });
      } catch { /* last resort */ }
    }

    // Record rejection
    CollaborationMemoryService.recordRejection(dreamer.path, node.uuid, {
      originalHash: state.activeCommit.hash,
      relayedBy: state.activeCommit.offeredBy,
      subject: state.activeCommit.subject,
      timestamp: Date.now(),
    });

    // Unstash
    const unstashResult = await unstash(node.path, state.stashRef);

    // Clear state
    CherryPickStateService.clear(node.path);

    return {
      success: true,
      rejected_hash: state.activeCommit.hash,
      stash_warning: unstashResult.warning,
    };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
}

/**
 * Tool: cherry_pick_cancel
 * Cancel preview without recording anything: reset, unstash
 */
async function cherryPickCancel(args: {
  identifier: string;
}): Promise<{
  success: boolean;
  stash_warning?: string;
  error?: string;
}> {
  try {
    const node = await findDreamNode(args.identifier);
    if (!node) {
      return { success: false, error: `DreamNode not found: ${args.identifier}` };
    }

    const state = CherryPickStateService.read(node.path);
    if (state.status !== 'previewing' && state.status !== 'conflict') {
      return { success: false, error: `Cannot cancel: workflow status is '${state.status}', expected 'previewing' or 'conflict'` };
    }

    // Abort cherry-pick / reset
    try {
      await execAsync('git cherry-pick --abort', { cwd: node.path });
    } catch {
      try {
        await execAsync('git reset --hard HEAD', { cwd: node.path });
      } catch { /* last resort */ }
    }

    // Unstash
    const unstashResult = await unstash(node.path, state.stashRef);

    // Clear state — no memory record
    CherryPickStateService.clear(node.path);

    return {
      success: true,
      stash_warning: unstashResult.warning,
    };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
}

/**
 * Tool: cherry_pick_status
 * Get current state of the cherry-pick workflow for a DreamNode
 * Key observability tool — InterBrain UI polls this to render state
 */
async function cherryPickStatus(args: {
  identifier: string;
}): Promise<{
  success: boolean;
  node?: { title: string; uuid: string };
  state?: CherryPickState;
  error?: string;
}> {
  try {
    const node = await findDreamNode(args.identifier);
    if (!node) {
      return { success: false, error: `DreamNode not found: ${args.identifier}` };
    }

    const state = CherryPickStateService.read(node.path);

    return {
      success: true,
      node: { title: node.title, uuid: node.uuid },
      state,
    };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
}

// ============================================================================
// TOOL EXPORTS
// ============================================================================

export const cherryPickTools = {
  cherry_pick_preview: {
    name: 'cherry_pick_preview',
    description: 'Enter cherry-pick preview: stash local changes, apply commit without committing, show diff. Must be in idle state. Transitions to previewing or conflict.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        identifier: {
          type: 'string',
          description: 'UUID or title of the DreamNode to preview the commit in',
        },
        commit_hash: {
          type: 'string',
          description: 'Git commit hash to cherry-pick (from fetch_peer_commits or list_pending_commits)',
        },
      },
      required: ['identifier', 'commit_hash'],
    },
    handler: cherryPickPreview,
  },

  cherry_pick_accept: {
    name: 'cherry_pick_accept',
    description: 'Accept the currently previewed cherry-pick: finalize the commit, record acceptance in the Dreamer\'s collaboration memory, and restore stashed changes.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        identifier: {
          type: 'string',
          description: 'UUID or title of the DreamNode being previewed',
        },
        dreamer_identifier: {
          type: 'string',
          description: 'UUID or title of the Dreamer whose collaboration memory to record in',
        },
      },
      required: ['identifier', 'dreamer_identifier'],
    },
    handler: cherryPickAccept,
  },

  cherry_pick_reject: {
    name: 'cherry_pick_reject',
    description: 'Reject the currently previewed cherry-pick: abort the cherry-pick, record rejection in the Dreamer\'s collaboration memory, and restore stashed changes.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        identifier: {
          type: 'string',
          description: 'UUID or title of the DreamNode being previewed',
        },
        dreamer_identifier: {
          type: 'string',
          description: 'UUID or title of the Dreamer whose collaboration memory to record in',
        },
        reason: {
          type: 'string',
          description: 'Optional reason for rejection',
        },
      },
      required: ['identifier', 'dreamer_identifier'],
    },
    handler: cherryPickReject,
  },

  cherry_pick_cancel: {
    name: 'cherry_pick_cancel',
    description: 'Cancel the current cherry-pick preview without recording anything in collaboration memory. Resets the working tree and restores stashed changes.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        identifier: {
          type: 'string',
          description: 'UUID or title of the DreamNode to cancel preview for',
        },
      },
      required: ['identifier'],
    },
    handler: cherryPickCancel,
  },

  cherry_pick_status: {
    name: 'cherry_pick_status',
    description: 'Get the current cherry-pick workflow state for a DreamNode. Returns idle, pending, previewing, or conflict status with full context. This is the key observability tool for the InterBrain UI.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        identifier: {
          type: 'string',
          description: 'UUID or title of the DreamNode to check',
        },
      },
      required: ['identifier'],
    },
    handler: cherryPickStatus,
  },
};
