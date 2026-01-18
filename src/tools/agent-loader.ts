/**
 * Agent Loader MCP Tools - Dynamic DreamNode sub-agent management
 *
 * Enables AURYN to load/unload DreamNodes as sub-agents at runtime.
 * Each DreamNode becomes a self-contained agent with its own context and tools.
 */

import { DreamNodeService } from '../services/standalone-adapter.js';
import * as path from 'path';
import * as fs from 'fs/promises';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// AURYN's agents directory
const AURYN_AGENTS_DIR = path.join(process.cwd(), '.claude', 'agents');

/**
 * Generate a safe filename from a DreamNode title
 */
function safeFilename(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Read a DreamNode's MCP configuration if it exists
 */
async function getDreamNodeMcpTools(dreamNodePath: string): Promise<string[]> {
  const mcpConfigPath = path.join(dreamNodePath, '.claude', 'mcp.json');
  try {
    const content = await fs.readFile(mcpConfigPath, 'utf-8');
    const config = JSON.parse(content);
    // Extract tool names from MCP server definitions
    const tools: string[] = [];
    if (config.mcpServers) {
      for (const serverName of Object.keys(config.mcpServers)) {
        // Convention: tools are prefixed with mcp__{servername}__
        tools.push(`mcp__${serverName}__*`);
      }
    }
    return tools;
  } catch {
    // No MCP config, return basic tools
    return ['Read', 'Glob', 'Grep'];
  }
}

/**
 * Get cascading README content from a DreamNode's holarchy
 */
async function getHolarchyContext(dreamNodePath: string): Promise<string> {
  let context = '';

  // Read the root README
  const rootReadme = path.join(dreamNodePath, 'README.md');
  try {
    const content = await fs.readFile(rootReadme, 'utf-8');
    context += content;
  } catch {
    context += '*No README found at root level.*\n';
  }

  // Get submodule READMEs recursively
  try {
    const { stdout } = await execAsync(
      "git submodule foreach --recursive --quiet 'echo $displaypath'",
      { cwd: dreamNodePath }
    );
    const submodulePaths = stdout.trim().split('\n').filter(p => p.length > 0);

    for (const submodulePath of submodulePaths) {
      const subReadme = path.join(dreamNodePath, submodulePath, 'README.md');
      try {
        const subContent = await fs.readFile(subReadme, 'utf-8');
        context += `\n\n---\n\n## Submodule: ${submodulePath}\n\n${subContent}`;
      } catch {
        // Skip submodules without READMEs
      }
    }
  } catch {
    // No submodules or git error
  }

  return context;
}

/**
 * Tool: load_dreamnode_agent
 * Load a DreamNode as a sub-agent in AURYN's context
 */
export async function loadDreamNodeAgent(args: {
  identifier: string;
  model?: string;
}): Promise<{
  success: boolean;
  agent_name?: string;
  agent_file?: string;
  description?: string;
  tools?: string[];
  message?: string;
  error?: string;
}> {
  try {
    // Find the DreamNode
    const node = await DreamNodeService.getDreamNode(args.identifier);
    if (!node) {
      return {
        success: false,
        error: `DreamNode not found: ${args.identifier}`
      };
    }

    // Generate agent name
    const agentName = safeFilename(node.title);
    const agentFile = path.join(AURYN_AGENTS_DIR, `${agentName}.md`);

    // Ensure agents directory exists
    await fs.mkdir(AURYN_AGENTS_DIR, { recursive: true });

    // Read the DreamNode's README for description
    const readmePath = path.join(node.path, 'README.md');
    let readme = '';
    let description = `Agent for ${node.title}`;
    try {
      readme = await fs.readFile(readmePath, 'utf-8');
      // Extract first paragraph as description (up to 200 chars)
      const firstPara = readme.split('\n\n')[0].replace(/^#.*\n/, '').trim();
      if (firstPara.length > 0) {
        description = firstPara.slice(0, 200) + (firstPara.length > 200 ? '...' : '');
      }
    } catch {
      readme = `# ${node.title}\n\n*No README available.*`;
    }

    // Get the DreamNode's MCP tools
    const tools = await getDreamNodeMcpTools(node.path);

    // Get full holarchy context
    const holarchyContext = await getHolarchyContext(node.path);

    // Generate agent file content
    const model = args.model || 'sonnet';
    const agentContent = `---
name: ${agentName}
description: ${description.replace(/\n/g, ' ')}
tools: ${tools.join(', ')}
model: ${model}
permissionMode: default
---

# ${node.title}

You are the agent for the "${node.title}" DreamNode. You have deep knowledge of this domain and can answer questions, perform tasks, and manage content within your context.

## Your Context

The following is your complete knowledge base, including any submodule context:

${holarchyContext}

## Your Capabilities

You can use the tools available to you to:
- Read and understand files in your domain
- Answer questions based on your context
- Perform domain-specific tasks

Always operate within your context. If asked about something outside your domain, say so clearly.
`;

    // Write the agent file
    await fs.writeFile(agentFile, agentContent, 'utf-8');

    return {
      success: true,
      agent_name: agentName,
      agent_file: agentFile,
      description,
      tools,
      message: `Agent "${agentName}" loaded. Run /resume to make it available in this session.`
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

/**
 * Tool: unload_dreamnode_agent
 * Remove a DreamNode sub-agent from AURYN's context
 */
export async function unloadDreamNodeAgent(args: {
  agent_name: string;
}): Promise<{
  success: boolean;
  removed_file?: string;
  message?: string;
  error?: string;
}> {
  try {
    const agentFile = path.join(AURYN_AGENTS_DIR, `${args.agent_name}.md`);

    // Check if file exists
    try {
      await fs.access(agentFile);
    } catch {
      return {
        success: false,
        error: `Agent not found: ${args.agent_name}`
      };
    }

    // Don't allow removing core AURYN agents
    const coreAgents = ['dreamwalk'];
    if (coreAgents.includes(args.agent_name)) {
      return {
        success: false,
        error: `Cannot unload core agent: ${args.agent_name}`
      };
    }

    // Remove the file
    await fs.unlink(agentFile);

    return {
      success: true,
      removed_file: agentFile,
      message: `Agent "${args.agent_name}" unloaded. Run /resume to update the session.`
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

/**
 * Tool: list_loaded_agents
 * List all currently loaded DreamNode sub-agents
 */
export async function listLoadedAgents(): Promise<{
  success: boolean;
  agents?: Array<{
    name: string;
    file: string;
    description: string;
  }>;
  error?: string;
}> {
  try {
    // Ensure directory exists
    await fs.mkdir(AURYN_AGENTS_DIR, { recursive: true });

    const files = await fs.readdir(AURYN_AGENTS_DIR);
    const agents: Array<{ name: string; file: string; description: string }> = [];

    for (const file of files) {
      if (!file.endsWith('.md')) continue;

      const filePath = path.join(AURYN_AGENTS_DIR, file);
      const content = await fs.readFile(filePath, 'utf-8');

      // Parse frontmatter to get description
      const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
      let description = '';
      if (frontmatterMatch) {
        const descMatch = frontmatterMatch[1].match(/description:\s*(.+)/);
        if (descMatch) {
          description = descMatch[1];
        }
      }

      agents.push({
        name: file.replace('.md', ''),
        file: filePath,
        description
      });
    }

    return {
      success: true,
      agents
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
export const agentLoaderTools = {
  load_dreamnode_agent: {
    name: 'load_dreamnode_agent',
    description: 'Load a DreamNode as a sub-agent. The agent will have the DreamNode\'s README as context and its MCP tools available. Requires /resume to take effect.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        identifier: {
          type: 'string',
          description: 'UUID or title of the DreamNode to load as an agent'
        },
        model: {
          type: 'string',
          description: 'Model to use for the agent (default: sonnet)',
          enum: ['sonnet', 'opus', 'haiku']
        }
      },
      required: ['identifier']
    },
    handler: loadDreamNodeAgent
  },

  unload_dreamnode_agent: {
    name: 'unload_dreamnode_agent',
    description: 'Unload a DreamNode sub-agent from AURYN. Removes the agent definition file. Requires /resume to take effect.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        agent_name: {
          type: 'string',
          description: 'Name of the agent to unload (filename without .md)'
        }
      },
      required: ['agent_name']
    },
    handler: unloadDreamNodeAgent
  },

  list_loaded_agents: {
    name: 'list_loaded_agents',
    description: 'List all currently loaded DreamNode sub-agents in AURYN',
    inputSchema: {
      type: 'object' as const,
      properties: {},
      required: []
    },
    handler: listLoadedAgents
  }
};
