/**
 * Content MCP Tools - README read/write operations
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
    const node = DreamNodeService.getDreamNode(args.identifier);
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
 * Tool: append_to_readme
 * Append validated, high-signal content to a DreamNode's README
 *
 * Conservative Signal Philosophy applies:
 * - Content should be concise (single sentence or short paragraph)
 * - Only append if the content is truly valuable signal
 * - Does NOT overwrite existing content
 */
export async function appendToReadme(args: {
  identifier: string;
  content: string;
  section?: string;
}): Promise<{
  success: boolean;
  node?: { title: string; path: string };
  appended_content?: string;
  error?: string;
}> {
  try {
    // Find DreamNode
    const node = DreamNodeService.getDreamNode(args.identifier);
    if (!node) {
      return {
        success: false,
        error: `DreamNode not found: ${args.identifier}`
      };
    }

    // Validate content is not empty
    const trimmedContent = args.content.trim();
    if (!trimmedContent) {
      return {
        success: false,
        error: 'Content cannot be empty'
      };
    }

    // Conservative signal check: warn if content seems excessive
    const wordCount = trimmedContent.split(/\s+/).length;
    if (wordCount > 100) {
      return {
        success: false,
        error: `Content too long (${wordCount} words). Conservative Signal Philosophy: prefer concise, high-signal content. Consider distilling to key insight.`
      };
    }

    const readmePath = path.join(node.path, 'README.md');

    // Read existing content or create default
    let existingContent = '';
    if (fs.existsSync(readmePath)) {
      existingContent = fs.readFileSync(readmePath, 'utf-8');
    } else {
      existingContent = `# ${node.title}\n\n`;
    }

    // Format the new content
    let formattedContent: string;
    if (args.section) {
      // Add under a specific section
      const sectionHeader = `\n## ${args.section}\n\n`;
      if (existingContent.includes(`## ${args.section}`)) {
        // Append to existing section
        const sectionIndex = existingContent.indexOf(`## ${args.section}`);
        const nextSectionMatch = existingContent.slice(sectionIndex + 1).match(/\n## /);
        const insertPoint = nextSectionMatch
          ? sectionIndex + 1 + nextSectionMatch.index!
          : existingContent.length;

        formattedContent =
          existingContent.slice(0, insertPoint).trimEnd() +
          '\n\n' + trimmedContent + '\n' +
          existingContent.slice(insertPoint);
      } else {
        // Create new section
        formattedContent = existingContent.trimEnd() + sectionHeader + trimmedContent + '\n';
      }
    } else {
      // Append to end
      formattedContent = existingContent.trimEnd() + '\n\n' + trimmedContent + '\n';
    }

    // Write back
    fs.writeFileSync(readmePath, formattedContent, 'utf-8');

    return {
      success: true,
      node: { title: node.title, path: node.path },
      appended_content: trimmedContent
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

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
    const node = DreamNodeService.getDreamNode(args.identifier);
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

  append_to_readme: {
    name: 'append_to_readme',
    description: 'Append validated, high-signal content to a DreamNode README. Conservative Signal Philosophy: only add truly valuable insights, prefer concise sentences over paragraphs.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        identifier: {
          type: 'string',
          description: 'UUID or title of the DreamNode'
        },
        content: {
          type: 'string',
          description: 'Content to append (prefer concise, high-signal content)'
        },
        section: {
          type: 'string',
          description: 'Optional section header to append under (e.g., "Notes", "Insights")'
        }
      },
      required: ['identifier', 'content']
    },
    handler: appendToReadme
  },

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
