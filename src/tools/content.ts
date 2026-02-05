/**
 * Content MCP Tools - README read operations
 * Uses InterBrain's services via standalone-adapter
 *
 * write_readme REMOVED - use Claude Code's built-in Read/Edit/Write tools instead.
 * They're more capable (diff-based editing, full file awareness) and don't
 * duplicate functionality that the host agent already has.
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
  }
};
