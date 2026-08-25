# Kickoff prompt for the corpus-state build

Paste the block below into a fresh Claude Code session to work
[`BUILD-TRACKER.md`](BUILD-TRACKER.md).

**Launch it from the `Claude in the Vault` desktop shortcut, not from this
repo.** The vault's `CLAUDE.md` is the operating system and only auto-loads when
the session is rooted there. `C:\Users\danie\Projects` is in
`additionalDirectories`, so this repo is fully reachable from a vault-rooted
session.

Prefer `claude --continue` or `claude --resume` if the build's session still
exists; Claude Code persists sessions and resuming beats re-briefing. This file
is for a genuinely fresh start: new day, new machine, or a session that has
compacted hard enough that a clean read is better than a fuzzy one.

**This prompt deliberately names no phase number.** It gets stale the moment the
first item ships, and a prompt that confidently points at the wrong phase is the
same class of problem this whole build is about. The tracker is the state; this
is only the briefing.

---

```markdown
Work the search-freshness tracker at `C:\Users\danie\Projects\smart-connections-mcp\BUILD-TRACKER.md`.

START POSITION: read the tracker completely, then verify its state against
`git log` and `git status` in that repo. Start at the FIRST UNCHECKED ITEM. Do
not trust any phase number remembered from a prompt, a summary, or a previous
session over what the tracker and the code actually say. If they disagree, the
code wins and the tracker gets corrected as your first act.

CONTEXT, in this order:
1. `BUILD-TRACKER.md` in that repo. It carries the ordered work, a "Decisions
   already made" table, and a baseline-observations block so you don't re-derive
   findings that cost real time to get.
2. `intelligence/research/2026-08-25-search-index-staleness.md` in this vault,
   the diagnosis.
3. `intelligence/decisions/2026-08-25-current-corpus-architecture.md`, the
   ruling the tracker implements. Read it before disagreeing with any design
   choice; most objections are answered there.
4. Board: https://github.com/goggledefogger/apc-ai-course/issues/138

THE ONE-LINE VERSION: retrieval treats "Smart Connections has an entry for this
path" as a proxy for "this note's current contents are represented in
retrieval." Those are different statements, and they disagreed for the
overwhelming majority of notes. Phase 1 builds the one place that decides
whether evidence is safe to use; every later phase is a set operation against it.

WHERE TO WORK
- Repo: `C:\Users\danie\Projects\smart-connections-mcp` (NOT OneDrive; the repos
  moved 2026-08-24 and OneDrive paths are dead).
- Anchor every git command to the repo in the same command
  (`cd /c/Users/danie/Projects/smart-connections-mcp && git ...`), because the
  Bash cwd drifts back to the vault between calls.
- `git status` before editing. A dirty tree you did not make is someone else's
  work: stop and ask. Never `git stash` to get a clean tree.

HARD RULES (from the tracker's decisions table; do not relitigate silently)
- Freshness is a CANONICAL CONTENT HASH. Never mtime. Never size. Never both.
  Not even as a "cheap skip" before hashing: a same-size edit with a preserved
  timestamp makes that skip claim false-fresh, which is the exact failure this
  build exists to remove. Version 1 always hashes during reconciliation.
- Hash canonical TEXT, not raw bytes: UTF-8 decode, strip BOM, normalize CRLF
  and lone CR to LF, preserve everything else. Store the algorithm id
  (`canonical-markdown-sha256-v1`) beside every digest. Raw bytes would let
  core.autocrlf invalidate the entire vault across machines.
- If the Smart Connections hash cannot be reproduced AND proven to track the
  embedded content, then every preexisting plugin vector is unverifiable: treat
  them as stale ONCE, re-embed through the supplemental path, and store our own
  hash from then on. Do not bootstrap trust from metadata already judged
  non-authoritative.
- Freshness bias is asymmetric: a false stale costs one embedding, a false fresh
  is a confidently wrong answer. Bias toward false-stale, always.
- Stale vectors are dropped from ranking, whole-note AND block together.
- The 3,000-call budget stays. Interactive work gets a much smaller sub-budget
  and never blocks on generic backlog.
- Never write to `~/.claude` memory. Durable rules go in the vault.

VERIFICATION STANDARD
This bug shipped because a health check graded its own homework, and static
tests passed while the thing was broken in reality. So:
- "It compiles" and "the assertion passes" are not verification.
- Every RETRIEVAL-SEMANTICS phase needs at least one test that FAILS on a stale
  index by construction. If a test would pass against the current broken build,
  it is not testing the thing.
- PACKAGING and DEPLOY phases cannot fail on a stale index, so their standard is
  different and equally strict: prove the built artifact CONTAINS the fix and
  EXECUTES it. Extract the zip, run it, read the health output.
- Verify against a real vault or a real fixture, by running it. Three Windows
  bugs in the last session (npm.cmd vs PATHEXT, PowerShell 5.1 has no `&&`, cmd
  quoting silently dropping commands) were all invisible to static checks and
  obvious within seconds of actually executing.
- The tracker's baseline numbers are OBSERVATIONS from 2026-08-25, not test
  oracles. The vault changes daily. Recompute live values; never assert the
  constants.

RUN IT ALL, IN ONE PASS, WITHOUT CHECKPOINTS
Dan's explicit instruction: do not come back to him with decisions. The tracker's
"Decisions already made" table answers every question this build previously held
open. Make the calls, build it, verify it, ship it.
- Do NOT stop to confirm a design choice, a field name, a threshold, an ordering,
  or which of two reasonable options to take. Pick the better one and note why in
  the progress log.
- DO stop for real harm only: destroying a member's data, force-pushing over
  someone else's work, a dirty tree this build did not create, or anything a
  `git revert` cannot undo. That is ordinary care, not a checkpoint.
- If a decision in the tracker turns out wrong once it meets the code, change it,
  record the reason in the progress log, and keep going. A tracker decision is a
  starting position, not a cage. Stalling is the only wrong move.

AS YOU GO
- Check the box and append one dated line to the progress log the moment an item
  ships, not in a batch at the end.
- One commit per phase or per meaningful item, with the reasoning in the commit
  body. Depth belongs in commits and the tracker, never in chat.
- End commit messages with:
  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
- Push when a phase completes. Interim progress comments on issue #138 are
  welcome any time; the FINAL results-and-closure comment is the last item in
  Phase 11 and belongs there, not earlier.
- If a phase changes a design decision, write it back to
  `intelligence/decisions/2026-08-25-current-corpus-architecture.md` in the
  vault, in the same pass.

IN CHAT: one thing at a time, short. Report what shipped and what broke, not
what you are about to do. Dan has inattentive ADHD and a dumped list stalls him.

THE STRATEGIC SITUATION, which should shape the tradeoffs
Almost nobody is running this system yet. The population that could ever
experience the broken version is tiny. So a fresh download can simply be
correct, and everything else is a small patch. When a tradeoff pits
fresh-install quality against backwards compatibility, fresh install wins.

THE BUILD IS NOT DONE WHEN THE ENGINE IS FIXED.
- Phase 9 is the fresh-download path: a brain that has never existed comes up
  with verified-current search and nobody types a command. It also pins the
  bridge to a tested revision instead of tracking main, which changes the
  release model on purpose.
- Phase 10 is migration, where the backlog actually bites: a migrated vault
  arrives with hundreds of notes at once and often a stale `.smart-env` from an
  Obsidian install the member stopped opening. `MIGRATE.md` gets a real search
  step, and it is Kit material so its commit needs a KIT-CHANGELOG entry.
- Phase 11 rebuilds the zip, proves the artifact executes the fix, cuts and
  deploys the kit release, leaves Dan's own vault working, pushes all four
  repos, and posts the closing comment to the board last.
```

---

## Splitting it across sittings

Phases 1 through 4 are the correctness fix and belong together: canonical paths,
the inventory, content hashing, the corpus snapshot, then supplemental indexing
consuming "needs a current vector", the lexical corpus, and honest coverage.
Stopping partway leaves the engine in a state where some paths trust freshness
and others do not, which is the condition this build exists to remove.

Phases 5 through 8 are propagation and hardening. They are safe to start a
separate sitting on, and the tracker's resume section covers picking them up.

**Phases 9 through 11 are the point, not cleanup.** Everything before them fixes
the engine on the machine it was built on. Phase 9 is what reaches someone who
downloads the zip, Phase 10 is what reaches someone bringing an existing vault
in, and Phase 11 puts it on the kit site.

Note the thing Phase 9 opens with: the zip contains the installer, not the
bridge, so what installs is whatever revision the installer targets. That is why
9.1 pins a tested revision rather than letting every brain track `main` and
inherit an untested commit on next boot.

## It runs unattended

There are no checkpoints. The tracker's "Decisions already made" table settles
every open question, including the freshness predicate, the legacy-vector
bootstrap, the health field formulas, and the bridge pinning. The build makes its
own calls, records them in the progress log, and runs to completion. The only
stop condition is real, irreversible harm.

## The one genuine unknown

Whether the Smart Connections hash can be reproduced AND proven to track the
embedded content. It is not a blocker either way, and the fallback is decided:
treat every preexisting plugin vector as unverifiable, re-embed once through the
supplemental path, and store our own canonical hash from then on. The cost is a
single full re-embed.

What matters is not concluding "reproduced" from one lucky match. Phase 1.4 says
to characterize it: vary body text, headings, frontmatter, whitespace, line
endings, and a same-size substitution, and record when the hash actually moves.
Knowing how to compute it is not the same as knowing what it means.
