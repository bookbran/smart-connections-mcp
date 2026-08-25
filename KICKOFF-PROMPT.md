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

TWO THINGS TO CONFIRM WITH DAN BEFORE BUILDING ON THEM
- Phase 1.3: whether the Smart Connections hash is reproducible from file
  contents decides the whole freshness predicate. Investigate first, report the
  finding, then build. Do not guess and proceed.
- Phase 6: the health field names are a surface agents will code against.
  Show the proposed shape before implementing it.

THE BUILD IS NOT DONE WHEN THE ENGINE IS FIXED. Phase 9 rebuilds the Astrolabe
zip, cuts a kit release, deploys it, and reports results to the board. A fix that
only runs on Dan's machine has not helped the person the kit was built for.

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

**Phase 9 is not optional and is not cleanup.** It rebuilds the Astrolabe zip,
cuts and deploys a kit release, and reports to the board. Everything before it
only fixes the engine on the machine it was built on; Phase 9 is what reaches a
member who downloads the zip. Note the thing it opens with: the zip contains the
installer, not the bridge, so a merge to `main` reaches every new brain and no
existing one. Verify that rather than assuming it.

## If the hash turns out not to be reproducible

Phase 1.3 is the one genuine unknown. The fallback is `size` equality plus a
tight mtime epsilon, which is already known to catch both documented cases (the
stale entry records `size: 2121` against 6418 bytes on disk). That is a smaller
result, not a blocked one, so report it and keep going rather than stalling the
phase.
