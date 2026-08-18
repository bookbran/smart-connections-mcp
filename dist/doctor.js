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
import { execFileSync } from 'child_process';
import { buildLinkGraph, integrityReport } from './link-graph.js';
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const json = process.argv.includes('--json');
const vaultPath = args[0] || process.env.SMART_VAULT_PATH;
if (!vaultPath) {
    console.error('Usage: npm run doctor -- /path/to/vault   (or set SMART_VAULT_PATH)');
    process.exit(1);
}
/**
 * What git can answer, reported beside what it cannot, so the two are never
 * confused. Git proves two machines agree on what is COMMITTED and is silent
 * about a note written outside the vault folder or never committed at all.
 */
function gitState(cwd) {
    const run = (a) => {
        try {
            return execFileSync('git', a, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        }
        catch {
            return null;
        }
    };
    run(['fetch', '--quiet', 'origin']);
    const dirty = run(['status', '--porcelain']);
    if (dirty === null)
        return null;
    const branch = run(['rev-parse', '--abbrev-ref', 'HEAD']) || 'main';
    const ahead = run(['rev-list', '--count', `origin/${branch}..HEAD`]);
    const behind = run(['rev-list', '--count', `HEAD..origin/${branch}`]);
    const lines = dirty.split('\n').filter(Boolean);
    return {
        branch,
        uncommitted: lines.length,
        untracked: lines.filter((l) => l.startsWith('??')).length,
        ahead: ahead === null ? null : Number(ahead),
        behind: behind === null ? null : Number(behind),
    };
}
const graph = buildLinkGraph(vaultPath);
const report = integrityReport(graph);
const git = gitState(vaultPath);
if (json) {
    console.log(JSON.stringify({ vaultPath, git, ...report }, null, 2));
    process.exit(0);
}
console.log(`\nVault: ${vaultPath}`);
console.log(`Notes: ${report.noteCount}\n`);
console.log('Sync state (what git CAN see)');
if (!git) {
    console.log('  not a git repo, so nothing here can speak to another machine at all');
}
else if (git.ahead === null) {
    console.log(`  on ${git.branch}, no reachable remote, so cross-machine state is unknown`);
}
else {
    console.log(`  ${git.ahead} ahead, ${git.behind} behind origin/${git.branch}`);
    console.log(`  ${git.uncommitted} uncommitted, ${git.untracked} untracked`);
    if (git.ahead === 0 && git.behind === 0 && git.uncommitted === 0) {
        console.log('  this machine matches origin exactly');
    }
    else if (git.ahead > 0 || git.uncommitted > 0) {
        console.log('  WORK HERE IS NOT ON YOUR OTHER MACHINES YET. Commit and push.');
    }
}
console.log('\nMissing link targets (what git CANNOT see)');
console.log(`  ${report.unresolvedCount} link target(s) resolve to no file.`);
if (report.loadBearing.length === 0) {
    console.log('  None referenced by 3+ notes, so nothing looks lost.');
}
else {
    console.log(`  ${report.loadBearing.length} referenced by 3+ notes, which is the real signal:\n`);
    for (const u of report.loadBearing.slice(0, 15)) {
        console.log(`   ${String(u.referencedBy.length).padStart(3)} notes  [[${u.target}]]`);
        for (const f of u.referencedBy.slice(0, 3))
            console.log(`             <- ${f}`);
        if (u.referencedBy.length > 3) {
            console.log(`             ... and ${u.referencedBy.length - 3} more`);
        }
    }
    console.log('\n  Each is one of: a concept the vault talks about but never gave a home\n' +
        '  note, a note written outside the vault folder, or a note that exists only\n' +
        '  on another machine. The first is common and worth fixing; the other two\n' +
        '  mean a brain is not whole.');
}
console.log('\nLimit worth stating: this sees THIS machine and its remote. Uncommitted work\n' +
    'or an out-of-directory vault on another computer is invisible from here, so\n' +
    'run it there too.\n');
//# sourceMappingURL=doctor.js.map