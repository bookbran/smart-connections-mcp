#!/usr/bin/env node
/**
 * Vault doctor: the integrity check git cannot do, as a CLI.
 *
 * Same logic the `check_vault_integrity` MCP tool exposes, so an agent and a
 * human get identical answers. This exists as a command because some questions
 * are asked while staring at a terminal on a machine you just sat down at, and
 * because a member with no agent session running still deserves an answer.
 *
 * WHY IT LIVES HERE rather than in a personal tooling repo: it was written in one
 * first, which put the only copy of the scan behind a private repo one person
 * could read, and duplicated the logic already in `link-graph.ts`. Two
 * implementations of one scan is how the answers drift apart. One copy, public,
 * in the repo the kit already installs.
 *
 * Usage:
 *   npm run doctor -- /path/to/vault
 *   SMART_VAULT_PATH=/path/to/vault npm run doctor
 *   npm run doctor -- /path/to/vault --json
 */
export {};
//# sourceMappingURL=doctor.d.ts.map