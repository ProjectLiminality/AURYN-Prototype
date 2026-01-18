#!/usr/bin/env node
/**
 * AURYN - InterBrain MCP Server
 *
 * Exposes the DreamNode system to AI agents and external tools via MCP.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { foundationTools } from './tools/foundation.js';
import { submoduleTools } from './tools/submodule.js';
import { contentTools } from './tools/content.js';
import { semanticTools } from './tools/semantic.js';
import { agentLoaderTools } from './tools/agent-loader.js';

// Combine all tools
const allTools = {
  ...foundationTools,
  ...submoduleTools,
  ...contentTools,
  ...semanticTools,
  ...agentLoaderTools
};

// Create MCP server
const server = new Server(
  {
    name: 'auryn',
    version: '0.1.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Handle tool listing
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: Object.values(allTools).map(tool => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema
    }))
  };
});

// Handle tool execution
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  const tool = allTools[name as keyof typeof allTools];
  if (!tool) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ error: `Unknown tool: ${name}` })
        }
      ],
      isError: true
    };
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (tool.handler as any)(args || {});
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2)
        }
      ]
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ error: errorMessage })
        }
      ],
      isError: true
    };
  }
});

// Start server
async function main() {
  console.error('AURYN MCP Server starting...');
  console.error('Available tools:', Object.keys(allTools).join(', '));

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error('AURYN MCP Server running on stdio');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
