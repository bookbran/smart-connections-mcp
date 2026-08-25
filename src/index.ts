#!/usr/bin/env node

/**
 * Smart Connections MCP Server
 *
 * Provides semantic search and knowledge graph capabilities for Obsidian Smart Connections
 * via the Model Context Protocol (MCP).
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { SmartConnectionsLoader } from './smart-connections-loader.js';
import { SearchEngine } from './search-engine.js';
import { buildLinkGraph, resolveLink, integrityReport, type LinkGraph } from './link-graph.js';

// Environment variable for vault path
const VAULT_PATH = process.env.SMART_VAULT_PATH;

if (!VAULT_PATH) {
  console.error('Error: SMART_VAULT_PATH environment variable is required');
  console.error('Please set it to your Obsidian vault path, e.g.:');
  console.error('  export SMART_VAULT_PATH="/Users/username/My Vault"');
  process.exit(1);
}

// Initialize loader
const loader = new SmartConnectionsLoader(VAULT_PATH);
await loader.initialize();

// Create search engine after loader is initialized
const searchEngine = new SearchEngine(loader);

// Built on first use rather than at boot: it is a full vault read, and a session
// that never asks a link question should not pay for it. Cached for the process
// lifetime, same as the supplemental embedding index.
let linkGraph: LinkGraph | null = null;
function getLinkGraph(): LinkGraph {
  if (!linkGraph) linkGraph = buildLinkGraph(VAULT_PATH!);
  return linkGraph;
}

console.error('Smart Connections MCP Server initialized successfully');
console.error(`Vault: ${VAULT_PATH}`);
// Deliberately NOT "loaded N notes". This is the size of the Smart Connections
// index, which is not the size of the vault and not how many notes are
// searchable. Printing it as a note count is the same substitution this whole
// build exists to remove, in a log line.
console.error(
  `Smart Connections index: ${loader.getSourceCount()} entries ` +
    '(each one checked against disk before it is trusted)'
);

// Create MCP server
const server = new Server(
  {
    name: 'smart-connections-mcp',
    version: '1.1.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Define tool schemas
const GetSimilarNotesSchema = z.object({
  note_path: z.string().describe('Path to the note (e.g., "Note.md" or "Folder/Note.md")'),
  threshold: z.number().min(0).max(1).default(0.5).describe('Similarity threshold (0-1)'),
  limit: z.number().int().positive().default(10).describe('Maximum number of results'),
});

const GetConnectionGraphSchema = z.object({
  note_path: z.string().describe('Path to the note to start from'),
  depth: z.number().int().positive().default(2).describe('Depth of the connection graph'),
  threshold: z.number().min(0).max(1).default(0.6).describe('Similarity threshold (0-1)'),
  max_per_level: z.number().int().positive().default(5).describe('Max connections per level'),
});

const SearchNotesSchema = z.object({
  query: z.string().describe('Search query text'),
  limit: z.number().int().positive().default(10).describe('Maximum number of results'),
  threshold: z.number().min(0).max(1).default(0.4).describe('Similarity threshold (0-1)'),
});

const GetEmbeddingNeighborsSchema = z.object({
  embedding_vector: z.array(z.number()).describe('384-dimensional embedding vector'),
  k: z.number().int().positive().default(10).describe('Number of neighbors to return'),
  threshold: z.number().min(0).max(1).default(0.5).describe('Similarity threshold (0-1)'),
});

const GetNoteContentSchema = z.object({
  note_path: z.string().describe('Path to the note'),
});

const GetStatsSchema = z.object({});

const ResolveLinkSchema = z.object({
  link: z.string(),
});

const GetBacklinksSchema = z.object({
  note_path: z.string(),
  include_outbound: z.boolean().optional(),
});

const CheckVaultIntegritySchema = z.object({
  min_references: z.number().min(1).optional(),
});

const CheckSearchHealthSchema = z.object({
  canary_path: z.string().optional(),
});

const RefreshSearchIndexSchema = z.object({
  budget: z.number().int().positive().optional(),
});

// Define available tools
const tools: Tool[] = [
  {
    name: 'get_similar_notes',
    description: 'Find notes semantically similar to a given note using embeddings. Returns paths, similarity scores, and available blocks.',
    inputSchema: {
      type: 'object',
      properties: {
        note_path: {
          type: 'string',
          description: 'Path to the note (e.g., "Note.md" or "Folder/Note.md")',
        },
        threshold: {
          type: 'number',
          description: 'Similarity threshold (0-1), default 0.5',
          minimum: 0,
          maximum: 1,
          default: 0.5,
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results, default 10',
          minimum: 1,
          default: 10,
        },
      },
      required: ['note_path'],
    },
  },
  {
    name: 'get_connection_graph',
    description: 'Build a multi-level connection graph starting from a note, showing how notes are semantically connected.',
    inputSchema: {
      type: 'object',
      properties: {
        note_path: {
          type: 'string',
          description: 'Path to the note to start from',
        },
        depth: {
          type: 'number',
          description: 'Depth of the connection graph (levels), default 2',
          minimum: 1,
          default: 2,
        },
        threshold: {
          type: 'number',
          description: 'Similarity threshold (0-1), default 0.6',
          minimum: 0,
          maximum: 1,
          default: 0.6,
        },
        max_per_level: {
          type: 'number',
          description: 'Max connections per level, default 5',
          minimum: 1,
          default: 5,
        },
      },
      required: ['note_path'],
    },
  },
  {
    name: 'search_notes',
    description: 'Semantic search over the vault, fused with literal keyword matching. Returns an envelope, not a bare array. READ `negativeResultsTrustworthy` FIRST: when it is true, an empty `results` means the vault genuinely has nothing closer; when it is false, an empty result proves nothing and you must say "not found in the verified searchable index" rather than "absent from the vault," and confirm with grep or a file read if absence actually matters. `mode` names the engine that answered ("keyword" means the embedding model never loaded). `coverage` separates three different questions: `semantic` (notes with a vector built from their CURRENT text), `lexical` (every readable note, which is why a distinctive phrase finds a note the moment it is written), and `plugin` (how much of Obsidian Smart Connections could be reused, and how much was dropped as stale). `coverage.freshnessVerified` says whether the corpus could be checked at all; `coverage.coverageComplete` says whether every eligible note has a current vector. Each result carries `matchedVia`: "lexical" means a literal term match surfaced it below the semantic threshold, which is usually the right answer to a query that was itself a literal string. Typical relevant matches score ~0.4-0.75; use 0.3 for open questions.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query text',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results, default 10',
          minimum: 1,
          default: 10,
        },
        threshold: {
          type: 'number',
          description: 'Similarity threshold (0-1), default 0.4',
          minimum: 0,
          maximum: 1,
          default: 0.4,
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'resolve_link',
    description: 'Turn a wikilink into a real file path, the way Obsidian would. Accepts bare text ("Throughline"), full link syntax ("[[Throughline|the CRM tracker]]"), or a path, and honors `aliases:` frontmatter, so a tracker filed as 2026-06-23-throughline-workstream.md resolves from its codename. Use this whenever you read a [[link]] in a note and need the actual file, instead of guessing at the filename or falling back to semantic search, which finds notes that are SIMILAR rather than the one that was actually referenced. Returns null when nothing resolves, which means the note genuinely does not exist in this vault.',
    inputSchema: {
      type: 'object',
      properties: {
        link: { type: 'string', description: 'Wikilink text, with or without the surrounding brackets.' },
      },
      required: ['link'],
    },
  },
  {
    name: 'get_backlinks',
    description: 'Which notes explicitly link TO this one. This answers a different question from semantic search: backlinks are edges the author wrote by hand, so they show what the vault has decided this note is load-bearing for, regardless of whether the prose is similar. Use it to judge how important a note is, to find every place a decision is cited before changing it, and to trace how a concept actually gets used. Set include_outbound to also get what this note links to.',
    inputSchema: {
      type: 'object',
      properties: {
        note_path: { type: 'string', description: 'Vault-relative path, e.g. context/revenue-engine.md' },
        include_outbound: { type: 'boolean', description: 'Also return the notes this one links to. Default false.' },
      },
      required: ['note_path'],
    },
  },
  {
    name: 'check_vault_integrity',
    description: 'Find wikilinks that point at notes which do not exist. Git proves two machines agree on what is COMMITTED; it is silent about a note written outside the vault folder or written on another machine and never committed, and both fail the same silent way, as a link that resolves to nothing. Results are ranked by how many DISTINCT notes reference each missing target, because one note pointing at an unwritten note is an ordinary forward reference while six pointing at the same target means the vault treats it as real and it is either a concept that never got a home note or a note this machine cannot see. Run at session start alongside check_search_health.',
    inputSchema: {
      type: 'object',
      properties: {
        min_references: { type: 'number', description: 'How many distinct referencing notes before a missing target counts as load-bearing. Default 3.', minimum: 1 },
      },
    },
  },
  {
    name: 'check_search_health',
    description: 'Whether this vault can be trusted to say a topic is absent. Call it at session start, before reporting any empty search result as an absence, and any time a vault has been quiet or moved between machines. It reports four separate facts rather than one blurred one: `semanticReady` (the machinery loaded), `retrievalProbePassed` (notes it holds vectors for do come back when asked by name), `freshnessVerified` (the corpus was reconciled against disk with no unaccounted read, hash or classification failure), and `coverageComplete` (every eligible note on disk has a vector built from its CURRENT text). `negativeResultsTrustworthy` is the AND of all four and is the one field to read: only when it is true does an empty search result mean the vault has nothing. `verdict` is a plain-language line written to be read aloud. `verifiedAt` and `corpusGeneration` date the answer, because a boolean you cannot date is worth much less. Note that probes alone can never establish freshness: they draw their expected notes from the index itself, so they pass happily on a corpus embedded months ago, which is exactly how this went unnoticed for a month.',
    inputSchema: {
      type: 'object',
      properties: {
        canary_path: {
          type: 'string',
          description: 'Optional vault-relative path to a known note to probe for specifically, in addition to the automatic sample.',
        },
      },
    },
  },
  {
    name: 'refresh_search_index',
    description: 'Embed every note that does not yet have a verified-current vector, deliberately, rather than waiting for it to trickle in across the first ten queries a member asks. Resumable and idempotent: it recomputes what is pending from disk on every call, so an interruption, a reboot, a failed embedding or a second invocation all reduce to the same thing. Anything already current is skipped without an embed call. Call this after a migration, after importing a vault, after a long gap, or any time check_search_health reports coverageComplete: false and you want it finished now instead of eventually. Returns attempted, refreshed, alreadyCurrent, failed, remaining, raced and coverageComplete; when remaining is above zero, call it again. Note that keyword matching covers the whole vault throughout, so pending notes are findable by a distinctive phrase the entire time.',
    inputSchema: {
      type: 'object',
      properties: {
        budget: {
          type: 'number',
          description: 'Maximum embedding calls to spend in this run. Defaults to SMART_INDEX_EMBED_BUDGET or 3000. A note costs one call plus one per heading section, so this is not a note count.',
          minimum: 1,
        },
      },
    },
  },
  {
    name: 'get_embedding_neighbors',
    description: 'Find nearest neighbors for a given embedding vector. Useful for custom similarity searches.',
    inputSchema: {
      type: 'object',
      properties: {
        embedding_vector: {
          type: 'array',
          items: { type: 'number' },
          description: '384-dimensional embedding vector',
        },
        k: {
          type: 'number',
          description: 'Number of neighbors to return, default 10',
          minimum: 1,
          default: 10,
        },
        threshold: {
          type: 'number',
          description: 'Similarity threshold (0-1), default 0.5',
          minimum: 0,
          maximum: 1,
          default: 0.5,
        },
      },
      required: ['embedding_vector'],
    },
  },
  {
    name: 'get_note_content',
    description: 'The full current text of a note, read from disk, plus the headings it currently has. `blocks` comes from the live markdown unless the note has a verified-current plugin index entry, because heading-to-line-range mappings recorded at import time are exactly as suspect as the vectors built from them once a file changes.',
    inputSchema: {
      type: 'object',
      properties: {
        note_path: {
          type: 'string',
          description: 'Path to the note',
        },
      },
      required: ['note_path'],
    },
  },
  {
    name: 'get_stats',
    description: 'Get statistics about the Smart Connections knowledge base (total notes, blocks, embedding model, etc.).',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
];

// Handle tool list requests
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools };
});

// Handle tool execution requests
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case 'get_similar_notes': {
        const { note_path, threshold, limit } = GetSimilarNotesSchema.parse(args);
        const results = await searchEngine.getSimilarNotes(note_path, threshold, limit);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(results, null, 2),
            },
          ],
        };
      }

      case 'get_connection_graph': {
        const { note_path, depth, threshold, max_per_level } = GetConnectionGraphSchema.parse(args);
        const graph = await searchEngine.getConnectionGraph(note_path, depth, threshold, max_per_level);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(graph, null, 2),
            },
          ],
        };
      }

      case 'search_notes': {
        const { query, limit, threshold } = SearchNotesSchema.parse(args);
        const response = await searchEngine.searchByQuery(query, limit, threshold);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(response, null, 2),
            },
          ],
        };
      }

      case 'resolve_link': {
        const { link } = ResolveLinkSchema.parse(args);
        const graph = getLinkGraph();
        const hit = resolveLink(graph, link);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                hit
                  ? { resolved: true, ...hit }
                  : {
                      resolved: false,
                      link,
                      note: 'No note in this vault answers to that name, path, or alias. Treat it as a missing note, not a missing answer: it may have been written outside the vault folder or on another machine. check_vault_integrity shows how many notes reference it.',
                    },
                null,
                2
              ),
            },
          ],
        };
      }

      case 'get_backlinks': {
        const { note_path, include_outbound } = GetBacklinksSchema.parse(args);
        const graph = getLinkGraph();
        const inbound = [...(graph.backlinks.get(note_path) || [])].sort();
        const payload: Record<string, unknown> = {
          note_path,
          backlinks: inbound,
          backlinkCount: inbound.length,
        };
        if (include_outbound) {
          payload.linksTo = [...(graph.edges.get(note_path) || [])].sort();
        }
        if (!graph.index.has(note_path.toLowerCase())) {
          payload.warning =
            'That path is not a note in this vault, so an empty result here says nothing about the note you meant. Resolve the name with resolve_link first.';
        }
        return {
          content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
        };
      }

      case 'check_vault_integrity': {
        const { min_references } = CheckVaultIntegritySchema.parse(args);
        const graph = getLinkGraph();
        const report = integrityReport(graph, min_references ?? 3);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  noteCount: report.noteCount,
                  unresolvedCount: report.unresolvedCount,
                  loadBearing: report.loadBearing,
                  note: 'loadBearing is the signal. Each entry is a concept the vault never gave a home note, or a note that exists only on another machine. This check sees only THIS machine, so it cannot speak for uncommitted work elsewhere.',
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case 'check_search_health': {
        const { canary_path } = CheckSearchHealthSchema.parse(args);
        const report = await searchEngine.checkSearchHealth(canary_path);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(report, null, 2),
            },
          ],
        };
      }

      case 'refresh_search_index': {
        const { budget } = RefreshSearchIndexSchema.parse(args);
        const report = await searchEngine.refreshSearchIndex(budget);
        return {
          content: [{ type: 'text', text: JSON.stringify(report, null, 2) }],
        };
      }

      case 'get_embedding_neighbors': {
        const { embedding_vector, k, threshold } = GetEmbeddingNeighborsSchema.parse(args);
        const results = await searchEngine.getEmbeddingNeighbors(embedding_vector, k, threshold);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(results, null, 2),
            },
          ],
        };
      }

      case 'get_note_content': {
        const { note_path } = GetNoteContentSchema.parse(args);
        const result = await searchEngine.getNoteWithContext(note_path);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'get_stats': {
        GetStatsSchema.parse(args);
        const stats = await searchEngine.getStats();
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(stats, null, 2),
            },
          ],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ error: errorMessage }, null, 2),
        },
      ],
      isError: true,
    };
  }
});

// Start the server
const transport = new StdioServerTransport();
await server.connect(transport);

console.error('Smart Connections MCP Server running on stdio');
