/**
 * Foundation MCP Tools - CRUD operations for DreamNodes
 * Uses InterBrain's services via standalone-adapter
 */

import { DreamNodeService, UDDService, discoverAllDreamNodes, DEFAULT_VAULT_PATH } from '../services/standalone-adapter.js';

// list_dreamnodes REMOVED
// Reason: Dumps all nodes, pollutes context. Use semantic search via context-provider agent instead.

/**
 * Tool: read_dreamnode
 * Read full metadata and README for a DreamNode by UUID
 *
 * IMPORTANT: This tool requires a UUID, not a title.
 * UUIDs are obtained from context-provider agent's semantic search.
 * This ensures relevance is determined before reading.
 */
export async function readDreamnode(args: {
  uuid: string;
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
  const node = await DreamNodeService.getDreamNode(args.uuid);

  if (!node) {
    return {
      found: false,
      error: `DreamNode not found with UUID: ${args.uuid}`
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
 * Create a new DreamNode with git and Radicle initialization
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
    radicleId?: string;
  };
  error?: string;
}> {
  try {
    // Use provided vault_path or default to RealDealVault
    const parentPath = args.vault_path || DEFAULT_VAULT_PATH;

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
        path: node.path,
        radicleId: node.radicleId
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

    const updated = await DreamNodeService.updateDreamNode(args.identifier, updates);

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
  cleaned_references?: string[];
  error?: string;
}> {
  if (!args.confirm) {
    return {
      success: false,
      error: 'Deletion requires confirmation. Set confirm: true to proceed.'
    };
  }

  try {
    const node = await DreamNodeService.getDreamNode(args.identifier);
    if (!node) {
      return {
        success: false,
        error: `DreamNode not found: ${args.identifier}`
      };
    }

    const deletedUuid = node.uuid;
    await DreamNodeService.deleteDreamNode(node.path);

    // Clean up references to deleted node in all other DreamNodes' .udd files
    const cleanedReferences: string[] = [];
    try {
      const allNodes = await discoverAllDreamNodes();

      for (const otherNode of allNodes) {
        let modified = false;
        let udd;
        try {
          udd = await UDDService.readUDD(otherNode.path);
        } catch {
          continue; // Skip nodes with unreadable .udd
        }

        // Remove from submodules array
        const subIdx = udd.submodules.indexOf(deletedUuid);
        if (subIdx !== -1) {
          udd.submodules.splice(subIdx, 1);
          modified = true;
        }

        // Remove from supermodules array (handles both string UUIDs and SupermoduleEntry objects)
        const origLen = udd.supermodules.length;
        udd.supermodules = udd.supermodules.filter(s => {
          if (typeof s === 'string') return s !== deletedUuid;
          if ('uuid' in s && (s as Record<string, unknown>).uuid === deletedUuid) return false;
          if ('radicleId' in s && node.radicleId && s.radicleId === node.radicleId) return false;
          return true;
        });
        if (udd.supermodules.length !== origLen) {
          modified = true;
        }

        if (modified) {
          await UDDService.writeUDD(otherNode.path, udd);
          cleanedReferences.push(otherNode.title);
        }
      }
    } catch {
      // Reference cleanup is best-effort; deletion itself succeeded
    }

    return {
      success: true,
      deleted_path: node.path,
      cleaned_references: cleanedReferences.length > 0 ? cleanedReferences : undefined
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
  // list_dreamnodes REMOVED - use context-provider agent with semantic search

  read_dreamnode: {
    name: 'read_dreamnode',
    description: 'Read full metadata and README content for a DreamNode by UUID. UUIDs are obtained from context-provider agent semantic search - do not call this directly with titles.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        uuid: {
          type: 'string',
          description: 'UUID of the DreamNode (obtained from context-provider semantic search)'
        }
      },
      required: ['uuid']
    },
    handler: readDreamnode
  },

  create_dreamnode: {
    name: 'create_dreamnode',
    description: 'Create a new DreamNode with git repository and Radicle initialization. Returns UUID and Radicle ID for relationship tracking.',
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
          description: 'Path to vault where DreamNode should be created. Defaults to /Users/davidrug/RealDealVault'
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
