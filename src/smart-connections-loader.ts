/**
 * Loader for Smart Connections data from .smart-env directory
 */

import * as fs from 'fs';
import * as path from 'path';
import type { SmartSource, SmartEnvConfig } from './types.js';

export class SmartConnectionsLoader {
  private vaultPath: string;
  private smartEnvPath: string;
  private config: SmartEnvConfig | null = null;
  private sources: Map<string, SmartSource> = new Map();
  private blocks: Map<string, Array<{ heading: string; vec: number[] }>> = new Map();
  private pluginIndexAvailable = false;
  private initError: string | null = null;

  constructor(vaultPath: string) {
    this.vaultPath = vaultPath;
    this.smartEnvPath = path.join(vaultPath, '.smart-env');
  }

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
  async initialize(): Promise<void> {
    if (!fs.existsSync(this.smartEnvPath)) {
      this.pluginIndexAvailable = false;
      return;
    }
    try {
      await this.loadConfig();
      await this.loadSources();
      this.pluginIndexAvailable = this.sources.size > 0;
    } catch (e) {
      // A half-written or older-format .smart-env should degrade, not detonate.
      this.pluginIndexAvailable = false;
      this.initError = e instanceof Error ? e.message : String(e);
    }
  }

  /** False when Smart Connections has never indexed this vault on this machine. */
  hasPluginIndex(): boolean {
    return this.pluginIndexAvailable;
  }

  getInitError(): string | null {
    return this.initError;
  }

  /**
   * Load smart_env.json configuration
   */
  private async loadConfig(): Promise<void> {
    const configPath = path.join(this.smartEnvPath, 'smart_env.json');

    if (!fs.existsSync(configPath)) {
      throw new Error(`Configuration file not found at: ${configPath}`);
    }

    const configData = fs.readFileSync(configPath, 'utf-8');
    this.config = JSON.parse(configData);
  }

  /**
   * Load all .ajson files from the multi directory
   */
  private async loadSources(): Promise<void> {
    // Resolved once: loadConfig() has already run, and doing this per line would
    // re-read the config thousands of times on a vault of any size.
    const modelKey = this.getEmbeddingModelKey();
    const multiPath = path.join(this.smartEnvPath, 'multi');

    if (!fs.existsSync(multiPath)) {
      throw new Error(`Multi directory not found at: ${multiPath}`);
    }

    const files = fs.readdirSync(multiPath);
    const ajsonFiles = files.filter(f => f.endsWith('.ajson'));

    console.error(`Loading ${ajsonFiles.length} source files...`);

    for (const file of ajsonFiles) {
      try {
        const filePath = path.join(multiPath, file);
        const content = fs.readFileSync(filePath, 'utf-8');

        // Parse the AJSON format (JSONL - one JSON object per line)
        // Each line is a single object like: "key": {...}
        const lines = content.trim().split('\n');

        for (const line of lines) {
          if (!line.trim()) continue;

          try {
            // Each line is formatted as: "key1": {...}, "key2": {...}, "key3": {...},
            // Remove trailing comma and wrap with curly braces to make valid JSON
            const cleanedLine = line.replace(/,\s*$/, '');
            const obj = JSON.parse(`{${cleanedLine}}`);

            // Process all key-value pairs in the object
            for (const key of Object.keys(obj)) {
              if (key.startsWith('smart_sources:')) {
                const sourceData: SmartSource = obj[key];
                // Skip entries with null/undefined paths
                if (sourceData && sourceData.path) {
                  this.sources.set(sourceData.path, sourceData);
                }
              } else if (key.startsWith('smart_blocks:')) {
                // Smart Connections embeds every heading-delimited section as
                // well as the whole note, and these were being dropped on the
                // floor. They are the reason the plugin exists: a note vector is
                // truncated to the model's window, so on a vault of ordinary
                // 5k-character notes it represents the opening and nothing else.
                // Block vectors are what make the body of a long note findable.
                const blockData = obj[key];
                const vec = blockData?.embeddings?.[modelKey]?.vec;
                if (!vec || !vec.length) continue;
                // Block keys look like `smart_blocks:path/to/note.md#H1#H2`, and
                // the entry's own `path` field is null, so the note path has to
                // come from the key.
                const raw = key.slice('smart_blocks:'.length);
                const hashAt = raw.indexOf('#');
                const notePath = hashAt >= 0 ? raw.slice(0, hashAt) : raw;
                const heading = hashAt >= 0 ? raw.slice(hashAt + 1) : '';
                if (!notePath) continue;
                let list = this.blocks.get(notePath);
                if (!list) {
                  list = [];
                  this.blocks.set(notePath, list);
                }
                list.push({ heading, vec });
              }
            }
          } catch (parseError) {
            // Skip lines that can't be parsed
            console.error(`Parse error in ${file}:`, parseError);
          }
        }
      } catch (error) {
        console.error(`Error loading ${file}:`, error);
      }
    }

    let blockCount = 0;
    for (const list of this.blocks.values()) blockCount += list.length;
    console.error(
      `Loaded ${this.sources.size} sources and ${blockCount} block embeddings successfully`
    );
  }

  /**
   * Get all sources
   */
  /** Per-section embeddings from the plugin, keyed by note path. */
  getBlockVectors(): Map<string, Array<{ heading: string; vec: number[] }>> {
    return this.blocks;
  }

  getSources(): Map<string, SmartSource> {
    return this.sources;
  }

  /**
   * Get a specific source by path
   */
  getSource(notePath: string): SmartSource | undefined {
    return this.sources.get(notePath);
  }

  /**
   * Get configuration
   */
  getConfig(): SmartEnvConfig | null {
    return this.config;
  }

  /**
   * Get the embedding model key from config
   */
  getEmbeddingModelKey(): string {
    // No plugin index means no config, which is a supported state now. Nothing
    // reads stored vectors then, so the key is only a label.
    if (!this.config) {
      return 'TaylorAI/bge-micro-v2';
    }

    // Extract the model key from the embed_model configuration
    const embedModel = this.config.smart_sources.embed_model;
    const adapter = embedModel.adapter;

    // The actual model key is nested in the adapter configuration
    // e.g., embed_model.transformers.model_key = "TaylorAI/bge-micro-v2"
    if (adapter && embedModel[adapter] && typeof embedModel[adapter] === 'object') {
      const adapterConfig = embedModel[adapter] as any;
      if (adapterConfig.model_key) {
        return adapterConfig.model_key;
      }
    }

    // Fallback: find first object key that's not 'adapter'
    const modelKeys = Object.keys(embedModel).filter(k => k !== 'adapter' && typeof embedModel[k] === 'object');

    if (modelKeys.length === 0) {
      throw new Error('No embedding model found in configuration');
    }

    return modelKeys[0];
  }

  /**
   * Get vault path
   */
  getVaultPath(): string {
    return this.vaultPath;
  }

  /**
   * Read the actual markdown content of a note
   */
  readNoteContent(notePath: string): string {
    const fullPath = path.join(this.vaultPath, notePath);

    if (!fs.existsSync(fullPath)) {
      throw new Error(`Note not found at: ${fullPath}`);
    }

    return fs.readFileSync(fullPath, 'utf-8');
  }

  /**
   * Extract content for specific blocks/sections
   */
  extractBlockContent(notePath: string, blockHeading: string): string {
    const content = this.readNoteContent(notePath);
    const source = this.getSource(notePath);

    if (!source || !source.blocks[blockHeading]) {
      return '';
    }

    const [startLine, endLine] = source.blocks[blockHeading];
    const lines = content.split('\n');

    return lines.slice(startLine - 1, endLine).join('\n');
  }
}
