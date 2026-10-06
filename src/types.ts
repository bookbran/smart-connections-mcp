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
 * How much of the vault a given search could actually see (tracker 4.2).
 *
 * The old shape had a single `searched` and `vaultTotal` pair, and `unsearchable`
 * was their difference. Both sides were built from the same two indexes, so the
 * subtraction could not produce a nonzero answer no matter how stale the index
 * was. It read `unsearchable: 0` on a vault where 509 of 525 indexed notes were
 * embedded from months-old text.
 *
 * The replacement separates three genuinely different questions, computed by SET
 * OPERATIONS against the disk inventory rather than by adding counts. That makes
 * three bug classes structurally impossible: duplicate paths inflating what was
 * searched, phantoms inflating anything, and plugin/supplemental overlap making
 * the searched count exceed the vault.
 */
export interface SemanticCoverage {
  /** Notes with a verified-current vector that also exist on disk. */
  searchable: number;
  /** Eligible notes with no verified-current vector yet. */
  pending: number;
  /** Of `searchable`, how many were vouched for by the plugin's own fingerprint. */
  fromPluginFresh: number;
  /** Of `searchable`, how many carry a fingerprint this server produced. */
  fromSupplemental: number;
  /**
   * Heading-level sections ranked alongside whole notes. Zero means every note
   * is represented only by its truncated opening, which is the state that made
   * most of a long note unfindable.
   */
  sections: number;
}

export interface LexicalCoverage {
  /** Notes the literal scorer read. Every readable markdown file in the vault. */
  searchable: number;
}

export interface PluginCoverage {
  sources: number;
  /** Sources whose vector provably matches current disk content. */
  fresh: number;
  /** Sources present on disk whose vector does not. Dropped from ranking. */
  stale: number;
  /** Sources with no file behind them any more. */
  phantom: number;
  /** Sources whose file exists and could not be read to check. */
  unreadable: number;
}

/** Corpus problems, surfaced rather than smoothed away. */
export interface CoverageErrors {
  inventory: number;
  read: number;
  hash: number;
  embed: number;
  /** Files that exist and could not be read. Neither absent nor covered. */
  unreadable: number;
}

export interface SearchCoverage {
  /** Markdown files on disk. Existence, established by the disk and nothing else. */
  vaultNotes: number;
  /** On-disk notes long enough to be worth embedding. */
  eligible: number;
  /** On-disk notes deliberately never embedded, so they never count as a gap. */
  ineligible: number;
  semantic: SemanticCoverage;
  lexical: LexicalCoverage;
  plugin: PluginCoverage;
  errors: CoverageErrors;
  /** Which snapshot these numbers came from, and when it was verified. */
  corpusGeneration: number;
  verifiedAt: string;
  /**
   * The snapshot reconciled with no unhandled read, hash or classification
   * failure. False means the numbers beside it are the best we could do, not the
   * truth.
   */
  freshnessVerified: boolean;
  /** Every eligible on-disk note has a verified-current semantic vector. */
  coverageComplete: boolean;
}

export interface SearchResponse {
  mode: SearchMode;
  results: SimilarNote[];
  coverage: SearchCoverage;
  threshold: number;
  /**
   * The single field that answers "can I treat this empty result as an absence."
   * Same name and same meaning as on the health report, so an agent learns one
   * thing rather than reconstructing a predicate from four numbers.
   */
  negativeResultsTrustworthy: boolean;
  /**
   * What deliberately meaningless text scores against this vault, measured per
   * corpus generation with fixed gibberish anchors. A result at or below it is
   * unrelated text wearing a score. Present only in semantic mode when the
   * measurement succeeded; compare `results[].similarity` against it before
   * treating a thin match as a finding.
   */
  noiseCeiling?: number;
  /** Present only when the answer should not be read at face value. */
  warning?: string;
}

/** One retrieval probe: ask for a note we know is there. */
export interface SearchHealthProbe {
  query: string;
  expectedPath: string;
  found: boolean;
  /** 1-based position in the results, or null when it never came back. */
  rank: number | null;
  similarity: number | null;
}

/**
 * The verdict, split into the questions it was conflating (tracker 6.1).
 *
 * A single `alive` boolean was answering four different questions at once, and
 * the one it was worst at is the one that matters: whether an empty result means
 * the vault has nothing. It could not answer that, because the probes draw their
 * expected notes FROM the live index, so they test reachability of whatever the
 * index happens to hold and pass happily on a corpus embedded months ago.
 */
export interface SearchHealthReport {
  /** Embedding and search machinery initialized and usable. */
  semanticReady: boolean;
  /** Independent retrieval probes came back. Tests machinery, not currency. */
  retrievalProbePassed: boolean;
  /** The current snapshot reconciled cleanly, with no unhandled failures. */
  freshnessVerified: boolean;
  /** Every eligible on-disk note has a verified-current semantic vector. */
  coverageComplete: boolean;
  /**
   * semanticReady && retrievalProbePassed && freshnessVerified && coverageComplete.
   *
   * This is the field to read, and the only one that licenses "the vault has
   * nothing on this."
   */
  negativeResultsTrustworthy: boolean;

  /** When the corpus behind this verdict was verified, and which snapshot it was. */
  verifiedAt: string;
  corpusGeneration: number;

  /**
   * Derived, and kept so nothing reading it today breaks. It now means
   * `negativeResultsTrustworthy`, which is stricter than it used to be: it once
   * meant "probes came back," which a completely stale index satisfies.
   */
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

/** What `refresh_search_index` reports back (tracker 7.3). */
export interface RefreshReport {
  attempted: number;
  refreshed: number;
  alreadyCurrent: number;
  failed: number;
  remaining: number;
  /** Notes edited WHILE being embedded. They stay pending, by design. */
  raced: number;
  embedCalls: number;
  budget: number;
  corpusGeneration: number;
  verifiedAt: string;
  coverageComplete: boolean;
  failures: Array<{ path: string; message: string }>;
  /** Plain-language line, because a member reads this after a migration. */
  summary: string;
}
