#!/usr/bin/env npx tsx
/**
 * Migration Script: Clean up boilerplate README noise from DreamNodes
 *
 * This script identifies DreamNode READMEs that contain the old template
 * boilerplate and replaces them with a minimal placeholder, while preserving
 * any meaningful content that may have been appended below the boilerplate.
 *
 * Usage:
 *   npx tsx scripts/cleanup-template-readmes.ts --dry-run  # Preview changes
 *   npx tsx scripts/cleanup-template-readmes.ts            # Apply changes
 */

import * as fs from 'fs';
import * as path from 'path';
import { discoverAllDreamNodes } from '../src/services/standalone-adapter.js';

// The boilerplate signature - if a README contains this, it has the old template
const BOILERPLATE_SIGNATURE = 'This is a DreamNode - a git repository representing a thought-form or person in the **InterBrain** knowledge management system.';

// The old boilerplate content (lines 2-51 of the template, after the title)
const BOILERPLATE_CONTENT = `
This is a DreamNode - a git repository representing a thought-form or person in the **InterBrain** knowledge management system.

## Universal Dream Description (UDD)

The \`udd.json\` file contains the essential metadata for this DreamNode:

\`\`\`json
{
  "uuid": "Unique identifier (constant)",
  "title": "Display name/title",
  "type": "dream or dreamer",
  "dreamTalk": "Path to symbolic representation",
  "liminalWebRelationships": ["Connected DreamNode UUIDs"],
  "submodules": ["Child DreamNode UUIDs"],
  "supermodules": ["Parent DreamNode UUIDs"]
}
\`\`\`

## Relationships

### Liminal Web (Horizontal)
- **Dreams** connect to **Dreamers** who hold them
- **Dreamers** connect to **Dreams** they carry
- Forms the social fabric of shared knowledge

### Holonic Structure (Vertical)
- **Submodules**: Ideas that are part of this idea
- **Supermodules**: Larger ideas this idea participates in
- Enables fractal knowledge organization

## Coherence Beacons

This DreamNode includes git hooks that maintain relationship coherence:

- **pre-commit**: Integrates external references as submodules
- **post-commit**: Updates bidirectional relationship tracking

Changes propagate through the peer-to-peer network via **Radicle**.

## License

This DreamNode is shared under the **GNU Affero General Public License v3.0** - a strong copyleft license ensuring this knowledge remains free and open for all.

## InterBrain

Part of the **InterBrain** project: transcending personal knowledge management toward collective knowledge gardening.

- **Repository**: https://github.com/ProjectLiminality/InterBrain
- **Vision**: Building DreamOS - a decentralized operating system for collective sensemaking`;

interface CleanupResult {
  path: string;
  title: string;
  action: 'cleaned' | 'preserved' | 'skipped';
  hadExtraContent: boolean;
  extraContent?: string;
}

/**
 * Extract the title from a DreamNode README
 */
function extractTitle(content: string): string | null {
  // Match "# DreamNode: Title" or "# Title"
  const dreamNodeMatch = content.match(/^#\s+DreamNode:\s*(.+)/m);
  if (dreamNodeMatch) {
    return dreamNodeMatch[1].trim();
  }

  const simpleMatch = content.match(/^#\s+(.+)/m);
  if (simpleMatch) {
    return simpleMatch[1].trim();
  }

  return null;
}

/**
 * Check if README contains the boilerplate template
 */
function hasBoilerplate(content: string): boolean {
  return content.includes(BOILERPLATE_SIGNATURE);
}

/**
 * Extract any content that appears after the boilerplate
 */
function extractExtraContent(content: string): string | null {
  // The boilerplate ends with the DreamOS sensemaking line
  const endMarker = '- **Vision**: Building DreamOS - a decentralized operating system for collective sensemaking';
  const endIndex = content.indexOf(endMarker);

  if (endIndex === -1) {
    return null;
  }

  const afterBoilerplate = content.slice(endIndex + endMarker.length).trim();

  // If there's meaningful content after the boilerplate, return it
  if (afterBoilerplate.length > 0) {
    return afterBoilerplate;
  }

  return null;
}

/**
 * Generate the new minimal README content
 */
function generateMinimalReadme(title: string, extraContent: string | null): string {
  let content = `# ${title}\n\n*Describe this idea here.*\n`;

  if (extraContent) {
    content += `\n${extraContent}\n`;
  }

  return content;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const verbose = args.includes('--verbose') || args.includes('-v');

  console.log('🧹 DreamNode README Cleanup Migration');
  console.log('=====================================');
  console.log(`Mode: ${dryRun ? 'DRY RUN (no changes will be made)' : 'APPLY CHANGES'}`);
  console.log('');

  // Discover all DreamNodes
  console.log('Discovering DreamNodes...');
  const dreamNodes = await discoverAllDreamNodes();
  console.log(`Found ${dreamNodes.length} DreamNodes\n`);

  const results: CleanupResult[] = [];
  let cleaned = 0;
  let preserved = 0;
  let skipped = 0;
  let withExtraContent = 0;

  for (const node of dreamNodes) {
    const readmePath = path.join(node.path, 'README.md');

    // Skip if no README exists
    if (!fs.existsSync(readmePath)) {
      if (verbose) {
        console.log(`⏭️  ${node.title}: No README.md found`);
      }
      skipped++;
      results.push({
        path: node.path,
        title: node.title,
        action: 'skipped',
        hadExtraContent: false
      });
      continue;
    }

    const content = fs.readFileSync(readmePath, 'utf-8');

    // Skip if no boilerplate
    if (!hasBoilerplate(content)) {
      if (verbose) {
        console.log(`✨ ${node.title}: Already clean (no boilerplate)`);
      }
      preserved++;
      results.push({
        path: node.path,
        title: node.title,
        action: 'preserved',
        hadExtraContent: false
      });
      continue;
    }

    // Has boilerplate - extract title and any extra content
    const title = extractTitle(content) || node.title;
    const extraContent = extractExtraContent(content);

    if (extraContent) {
      withExtraContent++;
      console.log(`📝 ${node.title}: Has boilerplate + extra content`);
      if (verbose) {
        console.log(`   Extra content preview: ${extraContent.slice(0, 100)}...`);
      }
    } else {
      console.log(`🧹 ${node.title}: Pure boilerplate, will clean`);
    }

    // Generate new content
    const newContent = generateMinimalReadme(title, extraContent);

    // Apply changes if not dry run
    if (!dryRun) {
      fs.writeFileSync(readmePath, newContent, 'utf-8');
    }

    cleaned++;
    results.push({
      path: node.path,
      title: node.title,
      action: 'cleaned',
      hadExtraContent: !!extraContent,
      extraContent: extraContent || undefined
    });
  }

  // Summary
  console.log('\n=====================================');
  console.log('Summary:');
  console.log(`  Total DreamNodes: ${dreamNodes.length}`);
  console.log(`  Cleaned: ${cleaned}`);
  console.log(`  Preserved (already clean): ${preserved}`);
  console.log(`  Skipped (no README): ${skipped}`);
  console.log(`  Had extra content preserved: ${withExtraContent}`);

  if (dryRun) {
    console.log('\n⚠️  DRY RUN - No changes were made');
    console.log('Run without --dry-run to apply changes');
  } else {
    console.log('\n✅ Changes applied successfully');
  }

  // Write detailed report
  const reportPath = path.join(process.cwd(), 'cleanup-report.json');
  fs.writeFileSync(reportPath, JSON.stringify(results, null, 2));
  console.log(`\nDetailed report written to: ${reportPath}`);
}

main().catch(console.error);
