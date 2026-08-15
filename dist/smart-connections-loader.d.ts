/**
 * Loader for Smart Connections data from .smart-env directory
 */
import type { SmartSource, SmartEnvConfig } from './types.js';
export declare class SmartConnectionsLoader {
    private vaultPath;
    private smartEnvPath;
    private config;
    private sources;
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
    getSources(): Map<string, SmartSource>;
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