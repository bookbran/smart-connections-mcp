/**
 * Fixture vaults, built on disk and run for real.
 *
 * Every Windows bug this repo has shipped was invisible to a static check and
 * obvious within seconds of executing something: npm.cmd versus PATHEXT,
 * PowerShell 5.1 having no `&&`, cmd quoting dropping half a command. So the
 * tests build actual directories, write actual files, and call the actual
 * loader. A mock of the filesystem would agree with whatever we believed while
 * writing it, which is the failure mode under repair.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';

/** Reproduces the plugin hash so fixtures can plant a genuinely-fresh entry. */
export { smartConnectionsHash } from '../dist/smart-connections-hash.js';

export function makeVault(prefix = 'sc-mcp-test-') {
  const root = mkdtempSync(join(tmpdir(), prefix));
  return {
    root,
    write(rel, content) {
      const abs = join(root, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content, 'utf-8');
      return abs;
    },
    /**
     * Write a file and then put its timestamps back where they were.
     *
     * This is the interesting fixture, not a curiosity: a same-size edit with a
     * preserved timestamp is exactly what defeats an mtime-and-size cache, and a
     * copy tool or `touch -r` produces it without anyone trying.
     */
    writePreservingTime(rel, content, seconds) {
      const abs = this.write(rel, content);
      utimesSync(abs, seconds, seconds);
      return abs;
    },
    cleanup() {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        // A Windows lock on a temp directory is not a test failure.
      }
    },
  };
}

/**
 * Write a `.smart-env` that looks exactly like the plugin's, so the loader parses
 * it through its real code path rather than a shape we invented.
 *
 * `sources` entries: { path, vec, hash, blocks?: [{heading, vec}] }. Passing a
 * `hash` that matches the file's raw content produces a genuinely fresh source;
 * passing anything else produces a stale one, which is the case most of these
 * tests are about.
 */
export function writeSmartEnv(root, sources, modelKey = 'TaylorAI/bge-micro-v2') {
  const dir = join(root, '.smart-env');
  mkdirSync(join(dir, 'multi'), { recursive: true });
  writeFileSync(
    join(dir, 'smart_env.json'),
    JSON.stringify({
      is_obsidian_vault: true,
      smart_blocks: { embed_blocks: true, min_chars: 10 },
      smart_sources: {
        single_file_data_path: '',
        min_chars: 10,
        embed_model: { adapter: 'transformers', transformers: { model_key: modelKey } },
        excluded_headings: '',
        file_exclusions: '',
        folder_exclusions: '',
      },
    }),
    'utf-8'
  );

  for (const src of sources) {
    const lines = [];
    const record = {
      path: src.path,
      class_name: 'SmartSource',
      last_read: { hash: src.hash, at: 1 },
      last_import: { mtime: 1, size: 1, at: 1, hash: src.importHash ?? src.hash },
      blocks: src.blockRanges ?? {},
      embeddings: {
        [modelKey]: {
          vec: src.vec,
          last_embed: { tokens: 10, hash: src.embedHash ?? src.hash },
        },
      },
    };
    lines.push(`"smart_sources:${src.path}": ${JSON.stringify(record)},`);
    for (const block of src.blocks ?? []) {
      const key = `smart_blocks:${src.path}#${block.heading}`;
      lines.push(
        `${JSON.stringify(key)}: ${JSON.stringify({
          path: null,
          class_name: 'SmartBlock',
          last_read: { hash: block.hash ?? 'blockhash', at: 1 },
          lines: block.lines ?? [1, 2],
          embeddings: {
            [modelKey]: { vec: block.vec, last_embed: { tokens: 5, hash: block.hash ?? 'blockhash' } },
          },
        })},`
      );
    }
    // The plugin names its files after the path with separators flattened.
    const file = src.path.replace(/[\\/]/g, '_').replace(/\./g, '_') + '.ajson';
    writeFileSync(join(dir, 'multi', file), lines.join('\n') + '\n', 'utf-8');
  }
}

/** A deterministic unit vector, so similarity comparisons in tests are stable. */
export function fakeVec(seed, dim = 384) {
  const out = new Array(dim);
  let x = seed || 1;
  let norm = 0;
  for (let i = 0; i < dim; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    out[i] = (x / 0x7fffffff) * 2 - 1;
    norm += out[i] * out[i];
  }
  norm = Math.sqrt(norm);
  for (let i = 0; i < dim; i++) out[i] /= norm;
  return out;
}
