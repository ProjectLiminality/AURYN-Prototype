/**
 * Foundation MCP Tools - CRUD operations for DreamNodes
 */

import { DreamNodeService, UDDService } from '../services/standalone-adapter.js';
import { discoverObsidianVaults } from '../services/vault-discovery.js';

/**
 * Tool: list_dreamnodes
 * List all DreamNodes with optional filtering
 */
export async function listDreamnodes(args: {
  type_filter?: 'dream' | 'dreamer';
  name_pattern?: string;
}): Promise<{
  nodes: Array<{
    uuid: string;
    title: string;
    type: 'dream' | 'dreamer';
    path: string;
    vaultPath: string;
    radicleId?: string;
  }>;
  count: number;
}> {
  const nodes = DreamNodeService.listDreamNodes({
    typeFilter: args.type_filter,
    namePattern: args.name_pattern
  });

  return {
    nodes: nodes.map(node => ({
      uuid: node.uuid,
      title: node.title,
      type: node.type,
      path: node.path,
      vaultPath: node.vaultPath,
      radicleId: node.radicleId
    })),
    count: nodes.length
  };
}

/**
 * Tool: get_dreamnode
 * Get full metadata and README for a DreamNode
 */
export async function getDreamnode(args: {
  identifier: string;
}): Promise<{
  found: boolean;
  node?: {
    uuid: string;
    title: string;
    type: 'dream' | 'dreamer';
    path: string;
    vaultPath: string;
    radicleId?: string;
    submodules: string[];
    supermodules: Array<string | { radicleId: string; title: string }>;
    readme?: string;
  };
  error?: string;
}> {
  const node = DreamNodeService.getDreamNode(args.identifier);

  if (!node) {
    return {
      found: false,
      error: `DreamNode not found: ${args.identifier}`
    };
  }

  // Read README if it exists
  let readme: string | undefined;
  try {
    const fs = await import('fs');
    const path = await import('path');
    const readmePath = path.join(node.path, 'README.md');
    if (fs.existsSync(readmePath)) {
      readme = fs.readFileSync(readmePath, 'utf-8');
    }
  } catch {
    // README doesn't exist or can't be read
  }

  return {
    found: true,
    node: {
      uuid: node.uuid,
      title: node.title,
      type: node.type,
      path: node.path,
      vaultPath: node.vaultPath,
      radicleId: node.radicleId,
      submodules: node.submodules,
      supermodules: node.supermodules.map(s =>
        typeof s === 'string' ? s : { radicleId: s.radicleId, title: s.title }
      ),
      readme
    }
  };
}

/**
 * Tool: create_dreamnode
 * Create a new DreamNode with git initialization
 */
export async function createDreamnode(args: {
  name: string;
  type: 'dream' | 'dreamer';
  vault_path?: string;
}): Promise<{
  success: boolean;
  node?: {
    uuid: string;
    title: string;
    type: 'dream' | 'dreamer';
    path: string;
  };
  error?: string;
}> {
  try {
    // Determine parent path
    let parentPath = args.vault_path;

    if (!parentPath) {
      // Use first discovered vault
      const vaults = discoverObsidianVaults();
      if (vaults.length === 0) {
        return {
          success: false,
          error: 'No Obsidian vaults found. Please specify vault_path.'
        };
      }
      parentPath = vaults[0].path;
    }

    const node = await DreamNodeService.createDreamNode(
      parentPath,
      args.name,
      args.type
    );

    return {
      success: true,
      node: {
        uuid: node.uuid,
        title: node.title,
        type: node.type,
        path: node.path
      }
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

/**
 * Tool: update_dreamnode
 * Update metadata for an existing DreamNode
 */
export async function updateDreamnode(args: {
  identifier: string;
  title?: string;
  type?: 'dream' | 'dreamer';
}): Promise<{
  success: boolean;
  node?: {
    uuid: string;
    title: string;
    type: 'dream' | 'dreamer';
    path: string;
  };
  error?: string;
}> {
  try {
    const updates: { title?: string; type?: 'dream' | 'dreamer' } = {};
    if (args.title !== undefined) updates.title = args.title;
    if (args.type !== undefined) updates.type = args.type;

    if (Object.keys(updates).length === 0) {
      return {
        success: false,
        error: 'No updates provided. Specify title or type to update.'
      };
    }

    const updated = DreamNodeService.updateDreamNode(args.identifier, updates);

    if (!updated) {
      return {
        success: false,
        error: `DreamNode not found: ${args.identifier}`
      };
    }

    return {
      success: true,
      node: {
        uuid: updated.uuid,
        title: updated.title,
        type: updated.type,
        path: updated.path
      }
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

/**
 * Tool: delete_dreamnode
 * Delete a DreamNode (requires confirmation)
 */
export async function deleteDreamnode(args: {
  identifier: string;
  confirm: boolean;
}): Promise<{
  success: boolean;
  deleted_path?: string;
  error?: string;
}> {
  if (!args.confirm) {
    return {
      success: false,
      error: 'Deletion requires confirmation. Set confirm: true to proceed.'
    };
  }

  try {
    const node = DreamNodeService.getDreamNode(args.identifier);
    if (!node) {
      return {
        success: false,
        error: `DreamNode not found: ${args.identifier}`
      };
    }

    await DreamNodeService.deleteDreamNode(node.path);

    return {
      success: true,
      deleted_path: node.path
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
export const foundationTools = {
  list_dreamnodes: {
    name: 'list_dreamnodes',
    description: 'List all DreamNodes across configured Obsidian vaults with optional filtering',
    inputSchema: {
      type: 'object' as const,
      properties: {
        type_filter: {
          type: 'string',
          enum: ['dream', 'dreamer'],
          description: 'Filter by DreamNode type'
        },
        name_pattern: {
          type: 'string',
          description: 'Filter by name pattern (case-insensitive substring match)'
        }
      }
    },
    handler: listDreamnodes
  },

  get_dreamnode: {
    name: 'get_dreamnode',
    description: 'Get full metadata and README content for a DreamNode by UUID or title',
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
    handler: getDreamnode
  },

  create_dreamnode: {
    name: 'create_dreamnode',
    description: 'Create a new DreamNode with git repository initialization',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: {
          type: 'string',
          description: 'Name/title for the new DreamNode'
        },
        type: {
          type: 'string',
          enum: ['dream', 'dreamer'],
          description: 'Type of DreamNode (dream = idea, dreamer = person)'
        },
        vault_path: {
          type: 'string',
          description: 'Optional path to the vault where the DreamNode should be created'
        }
      },
      required: ['name', 'type']
    },
    handler: createDreamnode
  },

  update_dreamnode: {
    name: 'update_dreamnode',
    description: 'Update metadata (title, type) for an existing DreamNode',
    inputSchema: {
      type: 'object' as const,
      properties: {
        identifier: {
          type: 'string',
          description: 'UUID or title of the DreamNode to update'
        },
        title: {
          type: 'string',
          description: 'New title for the DreamNode'
        },
        type: {
          type: 'string',
          enum: ['dream', 'dreamer'],
          description: 'New type for the DreamNode'
        }
      },
      required: ['identifier']
    },
    handler: updateDreamnode
  },

  delete_dreamnode: {
    name: 'delete_dreamnode',
    description: 'Delete a DreamNode and its contents (requires confirmation)',
    inputSchema: {
      type: 'object' as const,
      properties: {
        identifier: {
          type: 'string',
          description: 'UUID or title of the DreamNode to delete'
        },
        confirm: {
          type: 'boolean',
          description: 'Must be true to confirm deletion'
        }
      },
      required: ['identifier', 'confirm']
    },
    handler: deleteDreamnode
  }
};
