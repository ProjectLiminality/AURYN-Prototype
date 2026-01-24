/**
 * Spawn Chat MCP Tool - Open Claude Code in another DreamNode
 * Enables holarchy traversal by spawning new sessions in subcontexts
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { DreamNodeService } from '../services/standalone-adapter.js';

const execAsync = promisify(exec);

/**
 * Tool: spawn_chat
 * Open Claude Code in a new terminal tab for a specific DreamNode
 */
export async function spawnChat(args: {
  identifier: string;
  prompt?: string;
}): Promise<{
  success: boolean;
  dreamnode_path?: string;
  dreamnode_title?: string;
  error?: string;
}> {
  try {
    // Resolve DreamNode
    const node = await DreamNodeService.getDreamNode(args.identifier);

    if (!node) {
      return {
        success: false,
        error: `DreamNode not found: ${args.identifier}`
      };
    }

    // Build the claude command
    let claudeCmd = 'claude';
    if (args.prompt) {
      // Escape the prompt for shell
      const escapedPrompt = args.prompt.replace(/'/g, "'\\''");
      claudeCmd = `claude '${escapedPrompt}'`;
    }

    // macOS: Use osascript to open new Terminal tab and run command
    const script = `
      tell application "Terminal"
        activate
        tell application "System Events" to keystroke "t" using command down
        delay 0.3
        do script "cd '${node.path}' && ${claudeCmd}" in front window
      end tell
    `;

    await execAsync(`osascript -e '${script.replace(/'/g, "'\"'\"'")}'`);

    return {
      success: true,
      dreamnode_path: node.path,
      dreamnode_title: node.title
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
export const spawnChatTools = {
  spawn_chat: {
    name: 'spawn_chat',
    description: 'Open Claude Code in a new terminal tab for a specific DreamNode. Enables holarchy traversal - spawn sessions in subcontexts to delegate work.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        identifier: {
          type: 'string',
          description: 'UUID or title of the DreamNode to open Claude Code in'
        },
        prompt: {
          type: 'string',
          description: 'Optional initial prompt to send to Claude Code'
        }
      },
      required: ['identifier']
    },
    handler: spawnChat
  }
};
