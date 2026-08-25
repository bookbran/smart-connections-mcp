/**
 * Loader for Smart Connections data from .smart-env directory
 */
import type { SmartSource, SmartEnvConfig } from './types.js';
export declare class SmartConnectionsLoader {
    private vaultPath;
    private smartEnvPath;
    private config;
    private sources;
    private blocks;
    private pluginIndexAvailable;
    private initError;
    constructor(vaultPath: string);
    /**
     * Initialize and load all Smart Connections data
     */
    /**
     * Start up, with or without Smart Connections.
     *
     * This used to throw when `.smart-env` was missing, which killed the whole
     * server and made the Obsidian plugin a hard prerequisite for any semantic
     * search. `.smart-env` is gitignored so it never travels with the vault, which
     * means every machine either builds its own index or has none, and "has none"
     * was fatal. Since the server can embed notes itself now, the plugin is an
     * optimisation: where it has run we use its per-block work, where it has not we
     * start empty and the supplemental indexer covers the vault.
     */
    initialize(): Promise<void>;
    /** False when Smart Connections has never indexed this vault on this machine. */
    hasPluginIndex(): boolean;
    getInitError(): string | null;
    /**
     * Load smart_env.json configuration
     */
    private loadConfig;
    /**
     * Load all .ajson files from the multi directory
     */
    private loadSources;
    /**
     * Get all sources
     */
    /** Per-section embeddings from the plugin, keyed by note path. */
    getBlockVectors(): Map<string, Array<{
        heading: string;
        vec: number[];
    }>>;
    getSources(): Map<string, SmartSource>;
    /**
     * How many entries the plugin index holds. A COUNT, never evidence about a
     * note.
     *
     * It exists so reporting code does not have to reach for `getSources()`, which
     * `test/no-raw-corpus-access.test.mjs` forbids in retrieval modules. Note what
     * this number is not: it is not the size of the vault, and it is not how many
     * notes are searchable. The boot line used to print it as "Loaded N notes",
     * which on this vault said 525 for a 702-note vault and was the first place
     * the index quietly stood in for the world.
     */
    getSourceCount(): number;
    /**
     * Get a specific source by path
     */
    getSource(notePath: string): SmartSource | undefined;
    /**
     * Get configuration
     */
    getConfig(): SmartEnvConfig | null;
    /**
     * Get the embedding model key from config
     */
    getEmbeddingModelKey(): string;
    /**
     * Get vault path
     */
    getVaultPath(): string;
    /**
     * Read the actual markdown content of a note
     */
    readNoteContent(notePath: string): string;
    /**
     * Extract content for specific blocks/sections
     */
    extractBlockContent(notePath: string, blockHeading: string): string;
}
//# sourceMappingURL=smart-connections-loader.d.ts.map