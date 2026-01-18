/**
 * Content MCP Tools - README read/write operations
 * Uses InterBrain's services via standalone-adapter
 *
 * Follows the Conservative Signal Philosophy:
 * - Only append validated, high-signal content
 * - Surgical precision - single sentences preferred
 * - Ambiguity means NO
 */

import * as fs from 'fs';
import * as path from 'path';
import { DreamNodeService } from '../services/standalone-adapter.js';

/**
 * Tool: read_readme
 * Read the README content for a DreamNode
 */
export async function readReadme(args: {
  identifier: string;
}): Promise<{
  success: boolean;
  node?: { title: string; path: string };
  content?: string;
  exists?: boolean;
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

    const readmePath = path.join(node.path, 'README.md');

    if (!fs.existsSync(readmePath)) {
      return {
        success: true,
        node: { title: node.title, path: node.path },
        exists: false,
        content: ''
      };
    }

    const content = fs.readFileSync(readmePath, 'utf-8');

    return {
      success: true,
      node: { title: node.title, path: node.path },
      exists: true,
      content
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

// append_to_readme REMOVED
// Reason: Constrains intelligence by forcing "tweet-threading" instead of holistic editing.
// Use Claude Code's built-in Edit tool with read_readme to understand context,
// then make intelligent edits. Full README → intelligent edit beats append-only.

/**
 * Tool: write_readme
 * Write/overwrite the README for a DreamNode
 * Use with caution - prefer append_to_readme for incremental updates
 */
export async function writeReadme(args: {
  identifier: string;
  content: string;
  confirm_overwrite?: boolean;
}): Promise<{
  success: boolean;
  node?: { title: string; path: string };
  warning?: string;
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

    const readmePath = path.join(node.path, 'README.md');

    // Check if overwriting existing content
    if (fs.existsSync(readmePath) && !args.confirm_overwrite) {
      const existingContent = fs.readFileSync(readmePath, 'utf-8');
      if (existingContent.trim()) {
        return {
          success: false,
          error: 'README already exists with content. Set confirm_overwrite: true to overwrite, or use append_to_readme instead.',
          warning: 'Consider using append_to_readme for incremental updates (Conservative Signal Philosophy)'
        };
      }
    }

    // Ensure content starts with title if not present
    let content = args.content.trim();
    if (!content.startsWith('#')) {
      content = `# ${node.title}\n\n${content}`;
    }

    fs.writeFileSync(readmePath, content + '\n', 'utf-8');

    return {
      success: true,
      node: { title: node.title, path: node.path },
      warning: args.confirm_overwrite ? 'Existing content was overwritten' : undefined
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
export const contentTools = {
  read_readme: {
    name: 'read_readme',
    description: 'Read the README content for a DreamNode',
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
    handler: readReadme
  },

  // append_to_readme REMOVED - use Edit tool with read_readme instead

  write_readme: {
    name: 'write_readme',
    description: 'Write/overwrite the README for a DreamNode. Use append_to_readme for incremental updates instead.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        identifier: {
          type: 'string',
          description: 'UUID or title of the DreamNode'
        },
        content: {
          type: 'string',
          description: 'Full README content to write'
        },
        confirm_overwrite: {
          type: 'boolean',
          description: 'Must be true to overwrite existing content'
        }
      },
      required: ['identifier', 'content']
    },
    handler: writeReadme
  }
};
