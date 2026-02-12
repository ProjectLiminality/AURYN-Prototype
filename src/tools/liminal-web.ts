/**
 * Liminal Web MCP Tools - Horizontal Dream-to-Dreamer relationships
 *
 * Manages liminal-web.json files inside Dreamer nodes.
 * Links are bidirectional: only Dreamers hold the data, but querying
 * a Dream returns all Dreamers connected to it.
 */

import { DreamNodeService, LiminalWebService } from '../services/standalone-adapter.js';

/**
 * Tool: add_liminal_link
 * Add a relationship between a Dreamer and another DreamNode
 */
export async function addLiminalLink(args: {
  dreamer_identifier: string;
  target_identifier: string;
}): Promise<{
  success: boolean;
  dreamer?: { title: string; uuid: string };
  target?: { title: string; uuid: string };
  error?: string;
}> {
  try {
    const dreamer = await DreamNodeService.getDreamNode(args.dreamer_identifier);
    if (!dreamer) {
      return { success: false, error: `Dreamer not found: ${args.dreamer_identifier}` };
    }
    if (dreamer.type !== 'dreamer') {
      return { success: false, error: `${dreamer.title} is a ${dreamer.type}, not a dreamer. Only Dreamers hold liminal web data.` };
    }

    const target = await DreamNodeService.getDreamNode(args.target_identifier);
    if (!target) {
      return { success: false, error: `Target DreamNode not found: ${args.target_identifier}` };
    }

    if (dreamer.uuid === target.uuid) {
      return { success: false, error: 'Cannot link a Dreamer to itself' };
    }

    const added = await LiminalWebService.addLink(dreamer.path, target.uuid);
    if (!added) {
      return {
        success: true,
        dreamer: { title: dreamer.title, uuid: dreamer.uuid },
        target: { title: target.title, uuid: target.uuid },
        error: 'Link already exists'
      };
    }

    return {
      success: true,
      dreamer: { title: dreamer.title, uuid: dreamer.uuid },
      target: { title: target.title, uuid: target.uuid }
    };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
}

/**
 * Tool: remove_liminal_link
 * Remove a relationship between a Dreamer and another DreamNode
 */
export async function removeLiminalLink(args: {
  dreamer_identifier: string;
  target_identifier: string;
}): Promise<{
  success: boolean;
  dreamer?: { title: string; uuid: string };
  target?: { title: string; uuid: string };
  error?: string;
}> {
  try {
    const dreamer = await DreamNodeService.getDreamNode(args.dreamer_identifier);
    if (!dreamer) {
      return { success: false, error: `Dreamer not found: ${args.dreamer_identifier}` };
    }
    if (dreamer.type !== 'dreamer') {
      return { success: false, error: `${dreamer.title} is a ${dreamer.type}, not a dreamer` };
    }

    const target = await DreamNodeService.getDreamNode(args.target_identifier);
    if (!target) {
      return { success: false, error: `Target DreamNode not found: ${args.target_identifier}` };
    }

    const removed = await LiminalWebService.removeLink(dreamer.path, target.uuid);
    if (!removed) {
      return { success: false, error: `No link exists between ${dreamer.title} and ${target.title}` };
    }

    return {
      success: true,
      dreamer: { title: dreamer.title, uuid: dreamer.uuid },
      target: { title: target.title, uuid: target.uuid }
    };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
}

/**
 * Tool: list_liminal_links
 * List all liminal web connections for a DreamNode.
 * For a Dreamer: reads their liminal-web.json directly.
 * For a Dream: scans all Dreamers to find who links to it.
 */
export async function listLiminalLinks(args: {
  identifier: string;
}): Promise<{
  success: boolean;
  node?: { title: string; uuid: string; type: string };
  links?: Array<{ title: string; uuid: string; type: string }>;
  error?: string;
}> {
  try {
    const node = await DreamNodeService.getDreamNode(args.identifier);
    if (!node) {
      return { success: false, error: `DreamNode not found: ${args.identifier}` };
    }

    if (node.type === 'dreamer') {
      // Dreamer: read their liminal-web.json and resolve UUIDs
      const uuids = await LiminalWebService.readLinks(node.path);
      const links: Array<{ title: string; uuid: string; type: string }> = [];

      for (const uuid of uuids) {
        const linked = await DreamNodeService.getDreamNode(uuid);
        if (linked) {
          links.push({ title: linked.title, uuid: linked.uuid, type: linked.type });
        } else {
          links.push({ title: '(unknown)', uuid, type: 'unknown' });
        }
      }

      return {
        success: true,
        node: { title: node.title, uuid: node.uuid, type: node.type },
        links
      };
    } else {
      // Dream: scan all Dreamers to find who links to this Dream
      const allDreamers = await DreamNodeService.listDreamNodes({ typeFilter: 'dreamer' });
      const links: Array<{ title: string; uuid: string; type: string }> = [];

      for (const dreamer of allDreamers) {
        const uuids = await LiminalWebService.readLinks(dreamer.path);
        if (uuids.includes(node.uuid)) {
          links.push({ title: dreamer.title, uuid: dreamer.uuid, type: dreamer.type });
        }
      }

      return {
        success: true,
        node: { title: node.title, uuid: node.uuid, type: node.type },
        links
      };
    }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
}

/**
 * Export tool definitions for MCP registration
 */
export const liminalWebTools = {
  add_liminal_link: {
    name: 'add_liminal_link',
    description: 'Add a liminal web link between a Dreamer and another DreamNode. The link is stored in the Dreamer\'s liminal-web.json and interpreted as bidirectional.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        dreamer_identifier: {
          type: 'string',
          description: 'UUID or title of the Dreamer node (must be type "dreamer")'
        },
        target_identifier: {
          type: 'string',
          description: 'UUID or title of the DreamNode to link to (dream or dreamer)'
        }
      },
      required: ['dreamer_identifier', 'target_identifier']
    },
    handler: addLiminalLink
  },

  remove_liminal_link: {
    name: 'remove_liminal_link',
    description: 'Remove a liminal web link between a Dreamer and another DreamNode.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        dreamer_identifier: {
          type: 'string',
          description: 'UUID or title of the Dreamer node'
        },
        target_identifier: {
          type: 'string',
          description: 'UUID or title of the DreamNode to unlink'
        }
      },
      required: ['dreamer_identifier', 'target_identifier']
    },
    handler: removeLiminalLink
  },

  list_liminal_links: {
    name: 'list_liminal_links',
    description: 'List all liminal web connections for a DreamNode. For Dreamers: reads their links directly. For Dreams: scans all Dreamers to find who is connected.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        identifier: {
          type: 'string',
          description: 'UUID or title of the DreamNode to list links for'
        }
      },
      required: ['identifier']
    },
    handler: listLiminalLinks
  }
};
