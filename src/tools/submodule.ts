/**
 * Submodule MCP Tools - DreamNode relationship operations
 * Uses InterBrain's services via standalone-adapter
 */

import { SubmoduleService, DreamNodeService } from '../services/standalone-adapter.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs/promises';

const execAsync = promisify(exec);

/**
 * Tool: add_submodule
 * Import another DreamNode as a git submodule
 */
export async function addSubmodule(args: {
  parent_identifier: string;
  child_identifier: string;
  submodule_name?: string;
}): Promise<{
  success: boolean;
  parent?: { title: string; path: string };
  child?: { title: string; path: string };
  submodule_name?: string;
  error?: string;
}> {
  try {
    // Find parent DreamNode
    const parent = await DreamNodeService.getDreamNode(args.parent_identifier);
    if (!parent) {
      return {
        success: false,
        error: `Parent DreamNode not found: ${args.parent_identifier}`
      };
    }

    // Find child DreamNode
    const child = await DreamNodeService.getDreamNode(args.child_identifier);
    if (!child) {
      return {
        success: false,
        error: `Child DreamNode not found: ${args.child_identifier}`
      };
    }

    // Prevent self-reference
    if (parent.uuid === child.uuid) {
      return {
        success: false,
        error: 'Cannot add a DreamNode as a submodule of itself'
      };
    }

    // Add submodule
    const result = await SubmoduleService.addSubmodule(
      parent.path,
      child.path,
      args.submodule_name
    );

    if (!result.success) {
      return {
        success: false,
        error: result.error || 'Failed to add submodule'
      };
    }

    return {
      success: true,
      parent: { title: parent.title, path: parent.path },
      child: { title: child.title, path: child.path },
      submodule_name: args.submodule_name || child.title
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

/**
 * Tool: remove_submodule
 * Remove a submodule relationship from a DreamNode
 */
export async function removeSubmodule(args: {
  parent_identifier: string;
  submodule_name: string;
}): Promise<{
  success: boolean;
  parent?: { title: string; path: string };
  removed_submodule?: string;
  error?: string;
}> {
  try {
    // Find parent DreamNode
    const parent = await DreamNodeService.getDreamNode(args.parent_identifier);
    if (!parent) {
      return {
        success: false,
        error: `Parent DreamNode not found: ${args.parent_identifier}`
      };
    }

    // Verify submodule exists
    const submodules = await SubmoduleService.listSubmodules(parent.path);
    if (!submodules.includes(args.submodule_name)) {
      return {
        success: false,
        error: `Submodule not found: ${args.submodule_name}`
      };
    }

    // Remove submodule
    const result = await SubmoduleService.removeSubmodule(parent.path, args.submodule_name);

    if (!result.success) {
      return {
        success: false,
        error: result.error || 'Failed to remove submodule'
      };
    }

    return {
      success: true,
      parent: { title: parent.title, path: parent.path },
      removed_submodule: args.submodule_name
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

/**
 * Tool: list_submodules
 * List all submodules of a DreamNode
 */
export async function listSubmodules(args: {
  identifier: string;
}): Promise<{
  success: boolean;
  parent?: { title: string; path: string };
  submodules?: string[];
  error?: string;
}> {
  try {
    // Find DreamNode
    const node = await DreamNodeService.getDreamNode(args.identifier);
    if (!node) {
      return {
        success: false,
        error: `DreamNode not found: ${args.identifier}`
      };
    }

    // List submodules
    const submodules = await SubmoduleService.listSubmodules(node.path);

    return {
      success: true,
      parent: { title: node.title, path: node.path },
      submodules
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

/**
 * Tool: sync_context
 * Regenerate .claude/submodule-context.md with @imports for all submodule READMEs
 * This enables Claude Code to load context from the cascading holarchy of submodules
 */
export async function syncContext(args: {
  identifier: string;
}): Promise<{
  success: boolean;
  dreamnode?: { title: string; path: string };
  submodules_found?: string[];
  context_file?: string;
  error?: string;
}> {
  try {
    // Find DreamNode
    const node = await DreamNodeService.getDreamNode(args.identifier);
    if (!node) {
      return {
        success: false,
        error: `DreamNode not found: ${args.identifier}`
      };
    }

    const claudeDir = path.join(node.path, '.claude');
    const outputFile = path.join(claudeDir, 'submodule-context.md');

    // Ensure .claude directory exists
    await fs.mkdir(claudeDir, { recursive: true });

    // Get submodules
    const submodules = await SubmoduleService.listSubmodules(node.path);

    // Generate context file content
    let content = `# Submodule Context (Auto-Generated)

This file is auto-generated by the sync_context MCP tool.
Do not edit manually - it will be overwritten.

The following submodule READMEs are imported into context:

`;

    const foundSubmodules: string[] = [];

    for (const submoduleName of submodules) {
      const readmePath = path.join(node.path, submoduleName, 'README.md');
      try {
        await fs.access(readmePath);
        content += `## ${submoduleName}\n\n`;
        content += `@${submoduleName}/README.md\n\n`;
        foundSubmodules.push(submoduleName);
      } catch {
        // README doesn't exist, skip
      }
    }

    if (foundSubmodules.length === 0) {
      content += '*No submodules with READMEs found.*\n';
    }

    content += `\n---\n*Last synced: ${new Date().toISOString()}*\n`;

    // Write the file
    await fs.writeFile(outputFile, content, 'utf-8');

    return {
      success: true,
      dreamnode: { title: node.title, path: node.path },
      submodules_found: foundSubmodules,
      context_file: outputFile
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

/**
 * Export tool definitions for MCP registration
 */
export const submoduleTools = {
  add_submodule: {
    name: 'add_submodule',
    description: 'Import another DreamNode as a git submodule, establishing a hierarchical relationship',
    inputSchema: {
      type: 'object' as const,
      properties: {
        parent_identifier: {
          type: 'string',
          description: 'UUID or title of the parent DreamNode'
        },
        child_identifier: {
          type: 'string',
          description: 'UUID or title of the child DreamNode to import'
        },
        submodule_name: {
          type: 'string',
          description: 'Optional custom name for the submodule (defaults to child title)'
        }
      },
      required: ['parent_identifier', 'child_identifier']
    },
    handler: addSubmodule
  },

  remove_submodule: {
    name: 'remove_submodule',
    description: 'Remove a submodule relationship from a DreamNode',
    inputSchema: {
      type: 'object' as const,
      properties: {
        parent_identifier: {
          type: 'string',
          description: 'UUID or title of the parent DreamNode'
        },
        submodule_name: {
          type: 'string',
          description: 'Name of the submodule to remove'
        }
      },
      required: ['parent_identifier', 'submodule_name']
    },
    handler: removeSubmodule
  },

  list_submodules: {
    name: 'list_submodules',
    description: 'List all submodules of a DreamNode',
    inputSchema: {
      type: 'object' as const,
      properties: {
        identifier: {
          type: 'string',
          description: 'UUID or title of the DreamNode'
        }
      },
      required: ['identifier']
    },
    handler: listSubmodules
  },

  sync_context: {
    name: 'sync_context',
    description: 'Regenerate .claude/submodule-context.md with @imports for all submodule READMEs. Call this after importing submodules to update Claude Code context. The user will need to start a new chat or reload context to see changes.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        identifier: {
          type: 'string',
          description: 'UUID or title of the DreamNode to sync context for'
        }
      },
      required: ['identifier']
    },
    handler: syncContext
  }
};
