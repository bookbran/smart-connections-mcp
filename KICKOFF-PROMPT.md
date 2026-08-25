# Kickoff prompt for the corpus-state build

Paste the block below into a fresh Claude Code session to work
[`BUILD-TRACKER.md`](BUILD-TRACKER.md) from the top.

**Launch it from the `Claude in the Vault` desktop shortcut, not from this
repo.** The vault's `CLAUDE.md` is the operating system and only auto-loads when
the session is rooted there. `C:\Users\danie\Projects` is in
`additionalDirectories`, so this repo is fully reachable from a vault-rooted
session.

Prefer `claude --continue` or `claude --resume` if the build's session still
exists; Claude Code persists sessions and resuming beats re-briefing. This file
is for a genuinely fresh start: new day, new machine, or a session that has
compacted hard enough that a clean read is better than a fuzzy one.

---

```markdown
Work the search-freshness tracker at `C:\Users\danie\Projects\smart-connections-mcp\BUILD-TRACKER.md`.
Read it top to bottom before doing anything. Phase 0 is done; start at Phase 1.1.

CONTEXT, in this order:
1. `BUILD-TRACKER.md` in that repo — the ordered work, and a "what we already
   know" block so you don't re-derive findings that cost real time to get.
2. `intelligence/research/2026-08-25-search-index-staleness.md` in this vault —
   the diagnosis.
3. `intelligence/decisions/2026-08-25-current-corpus-architecture.md` — Dan's
   ruling, which is what the tracker actually implements. Read this before
   disagreeing with any design choice; most objections are answered there.
4. Board: https://github.com/goggledefogger/apc-ai-course/issues/138

THE ONE-LINE VERSION: retrieval treats "Smart Connections has an entry for this
path" as a proxy for "this note's current contents are represented in
retrieval." Those differ for 509 of 525 notes on Dan's vault. Phase 1 builds the
one place that decides whether evidence is safe to use; every later phase is a
set operation against it.

WHERE TO WORK
- Repo: `C:\Users\danie\Projects\smart-connections-mcp` (NOT OneDrive; the
  repos moved 2026-08-24 and OneDrive paths are dead).
- Anchor every git command to the repo in the same command
  (`cd /c/Users/danie/Projects/smart-connections-mcp && git ...`), because the
  Bash cwd drifts back to the vault between calls.
- `git status` before editing. A dirty tree you did not make is someone else's
  work: stop and ask. Never `git stash` to get a clean tree.

HARD RULES (from the ruling; do not relitigate without saying so first)
- Freshness bias is asymmetric: a false stale costs one embedding, a false fresh
  is a confidently wrong answer. Bias toward false-stale, always.
- Freshness predicate precedence: hash > size+mtime > mtime. Never mtime alone,
  never a 1000ms slack.
- Stale vectors get dropped from ranking — whole-note AND block together.
  Filtering `pluginVectors()` without `getBlockVectors()` leaves the bug intact.
- The 3000-call embed budget stays. A backlog is a scheduling problem.
- Never write to `~/.claude` memory. Durable rules go in the vault.

VERIFICATION STANDARD, and this is the whole point
This bug shipped because a health check graded its own homework, and static
tests passed while the thing was broken in reality. So:
- "It compiles" and "the assertion passes" are not verification.
- Every phase needs at least one test that FAILS on a stale index by
  construction. If a test would pass against the current broken build, it is not
  testing the thing.
- Verify against a real vault or a real fixture, by running it. Three Windows
  bugs in the last session (npm.cmd vs PATHEXT, PowerShell 5.1 has no `&&`, cmd
  quoting silently dropping commands) were all invisible to static checks and
  obvious within seconds of actually executing.
- Dan's vault at `C:\Users\danie\Projects\JDH-Second-Brain` is the real-world
  case: 700 notes, 525 plugin sources, 7 fresh, 509 stale, 9 phantom. Use it
  read-only for measurement; use fixtures for tests.

AS YOU GO
- Check the box and append one dated line to the progress log the moment an item
  ships, not in a batch at the end.
- One commit per phase or per meaningful item, with the reasoning in the commit
  body. Depth belongs in commits and the tracker, never in chat.
- End commit messages with:
  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
- Push when a phase completes, and post a short state update to issue #138 when
  a phase lands, since Danny and Roy are watching it.
- If a phase changes a design decision from the ruling, write it back to
  `intelligence/decisions/2026-08-25-current-corpus-architecture.md` in the
  vault, in the same pass.

IN CHAT: one thing at a time, short. Report what shipped and what broke, not
what you are about to do. Dan has inattentive ADHD and a dumped list stalls him.

RUN IT ALL, IN ONE PASS, WITHOUT CHECKPOINTS
Dan's explicit instruction: do not come back to him with decisions. The tracker's
"Decisions already made" table answers every question this build previously held
open, including the two that used to say "bring it to Dan". Make the calls,
build it, verify it, ship it.
- Do NOT stop to confirm a design choice, a field name, a threshold, an ordering,
  or which of two reasonable options to take. Pick the better one and note why in
  the progress log.
- DO stop for real harm only: destroying a member's data, force-pushing over
  someone else's work, a dirty tree this build did not create, or anything a
  `git revert` cannot undo. That is ordinary care, not a checkpoint.
- If a decision in the tracker turns out wrong once it meets the code, change it,
  record the reason in the progress log, and keep going. A tracker decision is a
  starting position, not a cage. Stalling on it is the only wrong move.

THE STRATEGIC SITUATION, which should shape the tradeoffs
Almost nobody is running this system yet. The population that could ever
experience the broken version is tiny. So a fresh download can simply be
correct, and everything else is a small patch. When a tradeoff pits fresh-install
quality against backwards compatibility, fresh install wins.

THE BUILD IS NOT DONE WHEN THE ENGINE IS FIXED.
- Phase 9 is the fresh-download path: a brain that has never existed comes up
  with verified-current search and nobody types a command.
- Phase 10 is migration, where the backlog actually bites: a migrated vault
  arrives with hundreds of notes at once and often a stale `.smart-env` from an
  Obsidian install the member stopped opening. `MIGRATE.md` gets a real search
  step, and it is Kit material so its commit needs a KIT-CHANGELOG entry.
- Phase 11 rebuilds the zip, cuts and deploys the kit release, leaves Dan's own
  vault working, pushes all four repos, and reports to the board last.

Start by reading the tracker, then run `git log --oneline -5` in the repo to
confirm it matches what the tracker claims, then begin Phase 1.1.
```

---

## Splitting it across sittings

Phases 1 through 4 are the correctness fix and belong together: they build the
inventory, classify freshness, make supplemental indexing consume "needs a
current vector," fix the lexical corpus, and make coverage honest. Stopping
partway through those leaves the engine in a state where some paths trust
freshness and others do not, which is the condition this whole build exists to
remove.

Phases 5 through 8 are propagation and hardening. They are safe to start a
separate sitting on, and the tracker's own resume section covers picking them up.

**Phases 9 through 11 are the point, not cleanup.** Everything before them fixes
the engine on the machine it was built on. Phase 9 is what reaches someone who
downloads the zip, Phase 10 is what reaches someone bringing an existing vault
in, and Phase 11 puts it on the kit site.

Note the thing Phase 9 opens with: the zip contains the installer, not the
bridge, so a merge to `main` reaches every new brain and no existing one. That
asymmetry is why Phase 9.2 exists, and it is a claim to verify rather than
assume.

## It runs unattended

There are no checkpoints. The tracker's "Decisions already made" table settles
every open question, including the freshness fallback and the health field names,
which previously said "ask Dan". The build makes its own calls, records them in
the progress log, and runs to completion. The only stop condition is real,
irreversible harm.

## If the hash turns out not to be reproducible

Phase 1.3 is the one genuine unknown, and it is not a blocker. The fallback is
decided and written into the tracker: `size` exact match AND
`last_import.mtime >= file.mtimeMs - 2`. Two milliseconds covers JSON round-trip
precision loss and nothing else, and a size mismatch is stale regardless of any
timestamp. Both documented cases are already caught by size alone (the stale
entry records `size: 2121` against 6418 bytes on disk).

So: investigate the hash because it is strictly better if it works, take the
fallback if it does not, note which one you used in the progress log, and keep
moving. Do not stall the phase on it and do not come back to ask.
