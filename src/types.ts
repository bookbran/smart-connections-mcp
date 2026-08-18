/**
 * Type definitions for Smart Connections MCP Server
 */

export interface SmartSource {
  path: string;
  embeddings: {
    [modelKey: string]: {
      vec: number[];
      last_embed: {
        hash: string;
        tokens: number;
      };
    };
  };
  last_read: {
    hash: string;
    at: number;
  };
  class_name: string;
  last_import: {
    mtime: number;
    size: number;
    at: number;
    hash: string;
  };
  blocks: {
    [heading: string]: [number, number]; // [start_line, end_line]
  };
}

export interface SmartEnvConfig {
  is_obsidian_vault: boolean;
  smart_blocks: {
    embed_blocks: boolean;
    min_chars: number;
  };
  smart_sources: {
    single_file_data_path: string;
    min_chars: number;
    embed_model: {
      adapter: string;
      [key: string]: any;
    };
    excluded_headings: string;
    file_exclusions: string;
    folder_exclusions: string;
  };
  smart_chat_threads?: {
    chat_model: {
      adapter: string;
      [key: string]: any;
    };
    active_thread_key?: string;
  };
}

export interface SimilarNote {
  path: string;
  similarity: number;
  blocks?: string[];
  matchedContent?: string;
  /**
   * Which retriever surfaced this. `lexical` means the dense score was below
   * threshold and a literal term match rescued it, which is the case fusion
   * exists for and the one a caller most needs to be able to see.
   */
  matchedVia?: 'semantic' | 'lexical' | 'both';
}

export interface ConnectionNode {
  root: string;
  path: string;
  depth: number;
  connections: ConnectionNode[];
  similarity: number;
}

export interface ConnectionGraph {
  root: string;
  connections: Array<{
    path: string;
    depth: number;
    similarity: number;
  }>;
}

export interface NoteContent {
  path: string;
  content: string;
  blocks: string[];
}

/** Which engine actually answered a search. */
export type SearchMode = 'semantic' | 'keyword';

/**
 * How much of the vault a given search could actually see.
 *
 * A retrieval tool that returns an empty list when it is blind is worse than
 * one that throws, because empty looks like an answer. Every search response
 * carries this so "nothing matched" and "nothing was searched" stop being
 * indistinguishable.
 */
export interface SearchCoverage {
  /** Notes the query was compared against. */
  searched: number;
  /** Notes we know exist: the plugin's index plus anything found on disk. */
  vaultTotal: number;
  /** Of `searched`, how many came from the Smart Connections plugin index. */
  fromPlugin: number;
  /** Of `searched`, how many this server embedded itself because the plugin had not. */
  supplemental: number;
  /**
   * Heading-level sections searched alongside whole notes. Zero means every note
   * is represented only by its truncated opening, which is the state that made
   * most of a long note unfindable.
   */
  sections: number;
  /** Notes we know exist but could not search this run. */
  unsearchable: number;
}

export interface SearchResponse {
  mode: SearchMode;
  results: SimilarNote[];
  coverage: SearchCoverage;
  threshold: number;
  /** Present only when the answer should not be read at face value. */
  warning?: string;
}

/** One positive-control probe: ask for a note we know is there. */
export interface SearchHealthProbe {
  query: string;
  expectedPath: string;
  found: boolean;
  /** 1-based position in the results, or null when it never came back. */
  rank: number | null;
  similarity: number | null;
}

export interface SearchHealthReport {
  /** False means treat every empty result from this server as untrustworthy. */
  alive: boolean;
  mode: SearchMode;
  coverage: SearchCoverage;
  modelKey: string;
  probes: SearchHealthProbe[];
  probesPassed: number;
  probesRun: number;
  /** Plain-language answer, written to be read aloud at session start. */
  verdict: string;
}
