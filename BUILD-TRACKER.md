# smart-connections-mcp: one current corpus -- Build Tracker

**Source of truth for scope:** [`intelligence/research/2026-08-25-search-index-staleness.md`](https://github.com/bookbran/JDH-Second-Brain/blob/main/intelligence/research/2026-08-25-search-index-staleness.md)
in the vault, plus Dan's architectural review of it (logged at
[`intelligence/decisions/2026-08-25-current-corpus-architecture.md`](https://github.com/bookbran/JDH-Second-Brain/blob/main/intelligence/decisions/2026-08-25-current-corpus-architecture.md)).
This file tracks *doing* it.

**Board:** [apc-ai-course#138](https://github.com/goggledefogger/apc-ai-course/issues/138) (this work), split out of [#103](https://github.com/goggledefogger/apc-ai-course/issues/103) (the install path, shipped as kit 0.5.0).
**Status:** Phase 0.1 done. 0.2 open. Nothing in Phase 1 started. Runs unattended: see "Decisions already made".

## What this build takes from, to

**From:** retrieval treats "Smart Connections has an entry for this path" as a
proxy for "this note's current contents are represented in retrieval." Those are
different statements, and on Dan's vault they disagree for 509 of 525 notes.

**To:** exactly one place in the engine decides whether evidence is safe to use.
Disk presence establishes existence; a verified-current vector establishes
semantic coverage. The plugin stops being a source of truth and becomes one
source of reusable embeddings.

Phases are ordered blockers-first, and the build is not done when the engine is
fixed. Phases 9 through 11 are the point: **the fresh-download path**, the
**migration path**, and then shipping. A correctness fix that only ever runs on
Dan's machine has not helped the person the kit was built for.

**Almost nobody is running this system yet**, which is the whole strategic
situation. The population that could ever experience the broken version is still
tiny, so a fresh download can simply be correct, and everything else is a small
patch. Weight decisions accordingly: when a tradeoff pits fresh-install quality
against backwards compatibility, fresh install wins.

**This tracker does not have checkpoints.** Every decision it needs has been made
and written down, including the ones that used to say "bring it to Dan". Run it
start to finish in one pass, exercising judgment where something unforeseen comes
up rather than stopping. See "Decisions already made" below.

Phase 1 is the architectural change Dan
called the deepest improvement; doing Phase 2 onward without it just scatters
`statSync` freshness checks through the engine and leaves the next tool to
rediscover this.

**Hard rule:** never widen the interactive embed budget as the fix for a
backlog. The 3,000-call cap exists because heading sections multiply one note
into many calls and an unbounded first run turns a member's first query into
minutes. Backlogs get better scheduling and a deliberate catch-up path, not a
raised ceiling.

**Second hard rule:** every freshness predicate biases toward false-stale. A
false stale costs one unnecessary embedding. A false fresh is a confidently
wrong answer, which is the entire bug.

---

## Decisions already made, so this build never stops to ask

Dan's instruction, 2026-08-25: make the calls, run it in one pass, no
checkpoints. Every question this tracker used to hold open is answered below.
Where something genuinely unforeseen comes up, use judgment and **write down what
you decided and why** in the progress log, then keep going.

| Question | Decision |
|---|---|
| Freshness predicate | Hash if reproducible. Otherwise `size` exact match AND `last_import.mtime >= file.mtimeMs - 2`. Never mtime alone. |
| Stale vectors in ranking | Dropped, whole-note and block together. |
| Embed budget | Stays 3,000 interactive. Bulk work goes through the deliberate refresh path. |
| Health field names | `semanticReady`, `retrievalProbePassed`, `freshnessVerified`, `coverageComplete`, `negativeResultsTrustworthy`. Keep `alive` as derived. |
| Existing installs | Self-heal: fast-forward a clean bridge clone on boot, refuse loudly on any other state. |
| An imported stale `.smart-env` | Treated exactly like any other index. Fresh entries used, stale ones ignored. No special case. |
| Migration backlog | Bulk refresh at migration time, not interactive dribble. |
| Fresh install vs backwards compatibility | Fresh install wins. Almost nobody is running the old thing. |
| Rule 14 | Interim wording now, simplified to `negativeResultsTrustworthy` once the server reports it. |

**The bar for stopping is real harm, not uncertainty.** Do not stop to confirm a
design choice, a name, a threshold, or an ordering. Do stop for: destroying a
member's data, force-pushing over someone else's work, a dirty tree this build
did not create, or anything that cannot be undone with `git revert`. Those are
not checkpoints; they are the ordinary care any build takes.

**When a decision above turns out to be wrong once it meets the code**, change
it, say so in the progress log with the reason, and continue. A tracker decision
is a starting position, not a cage. What is not acceptable is stalling on it.

---

## What we already know, so nobody re-derives it

Measured on Dan's 700-note vault, 2026-08-25:

- 525 plugin sources: **7 fresh, 509 stale, 9 phantom** (deleted `cursor-skills/`).
  Median staleness 67 days, max 107.
- `check_search_health` returns `unsearchable: 0` throughout, because both sides
  of that subtraction are built from the same two indexes.
- **The hashes Dan asked about exist.** A real source record:
  `last_import: {mtime, size, at, hash: "v9osj6"}` and
  `embeddings["TaylorAI/bge-micro-v2"].last_embed: {tokens, hash: "v9osj6"}`.
  The two hashes match on a fresh entry, so `last_embed.hash` is the embedding's
  claim about which content it encodes. Algorithm unknown; 6 chars, base36-ish.
- **`size` alone would have caught these.** The stale 2026-08-25 entry records
  `size: 2121`; the file on disk is 6418 bytes.
- **The stale vector actively suppresses lexical rescue.** Reproduced: the note
  ranks **6th of 55** in `searchByKeyword` for a literal phrase, and still never
  appears in fused output, because its stale vector earns a terrible dense rank
  and RRF buries a lexical-only hit under notes scoring in both lists. Dropping
  stale vectors therefore *restores* a fallback path, it does not remove one.
  This resolves the reconciliation Dan flagged in review point 5.

---

## Phase 0 -- Stop the bleeding (today, before any code)

- [x] **0.1 Patch [[CLAUDE]] rule 14 in the vault.** DONE 2026-08-25, vault `3aaf7c5`. Right now the rule tells
  every agent to trust `mode: semantic` + `unsearchable: 0`, a predicate that
  cannot fail. Replace with: an empty semantic result is evidence of absence
  only when health reports freshness verified AND coverage complete; otherwise
  say "not found in the verified searchable index," never "absent from the
  vault," and use lexical or live-file search when absence actually matters.
  Done when the rule is committed and pushed to the vault on `main`.

- [ ] **0.2 Note the same caveat in `SEARCH-BRIDGE.md`** so a brain shipped from
  the kit carries the warning until the fixed server ships.

---

## Phase 1 -- One definition of reality (the architectural change)

- [ ] **1.1 `VaultInventory`: a disk-backed inventory built per run.**
  `Map<path, {path, size, mtimeMs}>` from `listMarkdown`. This is the only thing
  allowed to answer "does this note exist." Done when it is constructed once per
  server run and unit-tested against a fixture vault.

- [ ] **1.2 Classify every plugin source as `fresh | stale | phantom`.**
  Phantom: not in the inventory. Fresh vs stale: see 1.3. Expose as
  `pluginFresh`/`pluginStale`/`pluginPhantoms` sets on the loader, not as
  scattered `statSync` calls in the engine.

- [ ] **1.3 Freshness predicate, hash-first.** Investigate whether
  `last_import.hash` / `last_embed.hash` is reproducible from file contents
  (both are `"v9osj6"` on a fresh entry, so start by hashing that file's known
  2121-byte July content and looking for a 6-char base36 match; check Smart
  Connections' bundled `main.js` the way the pooling detail was confirmed in
  August). If reproducible, hash is authoritative and mtime+size is only a
  fast-path skip. **If not, DECIDED fallback, no need to ask:** an entry is fresh
  only when `size` matches exactly AND `last_import.mtime >= file.mtimeMs - 2`.
  Two milliseconds, not one second: it covers JSON round-trip precision loss and
  nothing else. Size mismatch is stale regardless of any timestamp. Done when a table of
  cases passes: unchanged file, same-size edit, touched-but-unchanged,
  timestamp-preserving copy, timestamp-destroying copy.

- [ ] **1.4 `CorpusState`: the single object every retrieval feature consumes.**
  `onDisk`, `pluginFresh`, `pluginStale`, `pluginPhantoms`, `supplementalFresh`,
  `semanticPending`. Every later phase is a set operation against this.

---

## Phase 2 -- Make semantic retrieval tell the truth

- [ ] **2.1 Supplemental indexing consumes "needs a current vector," not
  "missing path."** Replace `!knownPaths.has(p)` with membership in
  `semanticPending`. This is the one-line change that repairs `search_notes`,
  and it is deliberately after Phase 1 so it is a set operation rather than a
  second freshness implementation.

- [ ] **2.2 Drop stale vectors from ranking, whole-note AND block together.**
  Filtering `pluginVectors()` without also filtering `getBlockVectors()` leaves
  the bug intact, because `denseScores` takes the max and a stale block can be
  the strongest signal for a note. Done when a stale note contributes zero dense
  evidence from either path.

- [ ] **2.3 Verify the lexical rescue comes back.** Regression test: a note with
  a stale plugin vector and a unique literal phrase must be returned by
  `search_notes`. This currently fails (rank 6 lexically, absent from fused
  output) and is the sharpest single proof the fix worked.

---

## Phase 3 -- Make the lexical corpus the whole vault

- [ ] **3.1 `searchByKeyword` iterates the inventory, not `getSources()`.**
  A note Smart Connections has never seen is currently invisible to keyword
  fallback despite sitting on disk. Result: lexical corpus = every readable
  markdown file; semantic corpus = every file with a verified-current vector.
  This is also what makes an indexing backlog non-catastrophic.

---

## Phase 4 -- Coverage by set difference

- [ ] **4.1 Compute coverage with sets, never by adding counts.**
  `searchablePaths = semanticPaths ∩ onDiskPaths`;
  `unsearchablePaths = onDiskPaths \ searchablePaths`. Makes three bug classes
  structurally impossible: duplicate paths inflating `searched`, phantoms
  inflating anything, and plugin/supplemental overlap making `searched >
  vaultTotal`.

- [ ] **4.2 New coverage contract.** Separate `semantic` (searchable, pending,
  pluginFresh, supplementalFresh) from `lexical` (searchable) from `plugin`
  (sources, fresh, stale, phantom). `unsearchable` currently conflates "not
  embedded" with "cannot be found at all"; once Phase 3 lands those are
  different facts and both matter.

---

## Phase 5 -- Every other retrieval surface

- [ ] **5.1 `getCurrentVectorCorpus()`, and everything semantic uses it.**
  Merges fresh plugin vectors with current supplemental vectors. Without this,
  `search_notes` returns current results while `get_similar_notes` and
  `get_connection_graph` still answer from the May snapshot. May require making
  `getSimilarNotes` async; worth it.

- [ ] **5.2 The query note gets the same treatment.** If a note is stale in the
  plugin but fresh in supplemental, `get_similar_notes` on that note must use
  the supplemental vector, not the plugin's placeholder. Easy to miss because
  the source note is fetched by a different call path than the comparison set.

- [ ] **5.3 `get_connection_graph` and `get_embedding_neighbors`** inherit the
  fix via 5.1; add a test that proves it rather than assuming.

- [ ] **5.4 `getStats` reports vault-world, not plugin-world.** Split into
  `vaultNotes`, `pluginSources`, `pluginFresh`, `supplemental`,
  `semanticSearchable`.

- [ ] **5.5 Block metadata is only trustworthy for fresh notes.** Plugin sources
  carry heading-to-line-range mappings; once a file changes those coordinates
  are as suspect as the vectors. Use them only for `pluginFresh`, or derive
  headings from current markdown.

---

## Phase 6 -- Health that separates four different questions

- [ ] **6.1 Split the verdict. Field names DECIDED, use these exactly:**
  `semanticReady`, `retrievalProbePassed`, `freshnessVerified`,
  `coverageComplete`, `negativeResultsTrustworthy`, with the nested
  `semantic` / `lexical` / `plugin` coverage objects from Dan's review. These are
  his own proposed names, already reviewed, so adopt them verbatim rather than
  reopening naming. Keep `alive` as a derived convenience so nothing that reads
  it today breaks. A healthy-but-catching-up server is not a dead one, and one
  boolean cannot say that.

- [ ] **6.2 Redefine the title probes as retrieval probes.** They draw expected
  notes from the live index, so they test reachability of the historical corpus
  and pass happily on a stale one. Keep them, rename the concept, and establish
  freshness mechanically from fingerprints instead.

- [ ] **6.3 Give agents one field to read.** `negativeResultsTrustworthy` is
  what rule 14 should key on, rather than every agent reconstructing the
  predicate from four numbers.

---

## Phase 7 -- Catch-up scheduling, not a bigger budget

- [ ] **7.1 Prioritize recently-modified stale notes first.** Currently the
  backlog is walked in directory order, so a note edited today waits behind
  hundreds of unrelated ones.

- [ ] **7.2 Query-aware catch-up.** Lexically scan the current vault, find
  high-ranking stale/pending candidates, re-embed those first, then spend the
  remaining budget on general backlog. Makes the 3,000-call cap much less
  painful: the note you are actually looking for becomes searchable now.

- [ ] **7.3 `SMART_INDEX_EMBED_BUDGET` as configuration**, and a deliberate
  `refresh_search_index` maintenance operation for finishing a backlog on purpose.

---

## Phase 8 -- Regression fixtures

- [ ] **8.1 Fixtures for every case that produced this bug:** stale edit,
  same-size edit, touched-but-unchanged file, deleted file still in the index,
  plugin-missing file, budget exhaustion mid-run, stale block outranking a fresh
  note, and graph/similarity calls against a stale source note.

- [ ] **8.2 A test that fails on a stale index by construction**, so this class
  of bug cannot ship silently again.

---

## Phase 9 -- The fresh-download path (the one that matters most)

Almost nobody is running this yet. That is the opportunity: the population that
will ever experience the broken version is still small, and a fresh download can
be made correct with no migration story at all. **Fresh install is the highest
priority surface in this build.** Get it right and the rest is a patch for a
handful of people.

**Read this first: the zip does NOT contain the bridge.** It contains the
dashboard, whose `seedSearchBridge` clones `bookbran/smart-connections-mcp` from
GitHub on a brain's first boot. So a fix merged to `main` here reaches every NEW
brain with no zip rebuild, and reaches NO existing install unless something
pulls. Verify that claim rather than assuming it; assuming is how this bug got
here.

- [ ] **9.1 Prove the fix reaches a brand new brain, end to end, unaided.** On a
  throwaway brain directory, boot the dashboard fresh and let `seedSearchBridge`
  clone and build with nobody helping it. Then run `check_search_health` and
  confirm the new freshness fields are present and honest. Done when a brain that
  never existed before comes up with verified-current search and no human typed a
  command.

- [ ] **9.2 Existing installs self-heal on boot. DECIDED, build it.**
  `seedSearchBridge` fast-forwards an existing bridge clone when it is safe to:
  the directory is a git repo, the remote is `bookbran/smart-connections-mcp`,
  the tree is clean, and it is on `main`. Then `git pull --ff-only` and rebuild if
  the pull moved anything. Any other state (dirty tree, detached head, a fork,
  someone's local work) logs the reason and leaves it completely alone. Rationale
  for the record: the bridge is infrastructure, not the member's code, so there is
  nothing of theirs to conflict with, and a shipped brain that cannot self-heal
  means this bug lives forever in the installs of people who will never know to
  ask. Detached and non-fatal like the install. Needs a test for both legs, the
  clean fast-forward and the refusal.

- [ ] **9.3 Retire the interim caveat and state the real contract.**
  `SEARCH-BRIDGE.md` ships in the zip and into every seeded brain, so it is where
  an agent learns what search can promise. Remove the Phase 0.2 warning, document
  the new health fields, and say plainly which single field answers "can I trust
  an empty result."

- [ ] **9.4 Simplify vault rule 14 to the shipped signal.** Phase 0.1 was
  deliberately interim. Now that the server reports it, the rule keys on
  `negativeResultsTrustworthy === true` rather than making every agent
  reconstruct a four-field predicate. Vault repo, `CLAUDE.md`. Leaving the scary
  interim wording in place after the fix ships is its own kind of stale.

- [ ] **9.5 First-run cost is honest.** A fresh brain embeds its whole vault on
  first use. Confirm the budget and the catch-up scheduling from Phase 7 make
  that tolerable rather than a multi-minute stall on a member's first question,
  and that health reports `coverageComplete: false` while it converges instead of
  claiming completeness it has not earned.

---

## Phase 10 -- The migration path, which is where the backlog actually bites

A member bringing an existing vault in is the one case that dumps hundreds of
notes into a brain at once. On Dan's own migration that was roughly 660 notes.
The interactive embed budget is 3,000 calls, about 258 notes, so a migrated
brain is **guaranteed** to start life with a large semantic backlog. Migration is
also the exact moment a member is most likely to have a stale `.smart-env` from
an Obsidian install they stopped opening, which is the bug this whole build is
about, arriving pre-installed.

- [ ] **10.1 `MIGRATE.md` wires in search, as a real step.** The migration skill
  currently ends at frontmatter passes and hands off to name-your-world. Add a
  step after the passes: make sure the bridge is installed and the migrated notes
  are actually embedded. Written the way the rest of that file is written, as the
  agent's job and never the member's, and honest that it runs in the background.
  `dashboard/MIGRATE.md` in `second-brain-dashboard` is Kit material, so the
  commit needs a `KIT-CHANGELOG.md` entry in the same pass or the pre-commit hook
  refuses it.

- [ ] **10.2 Migration triggers deliberate catch-up, not interactive dribble.**
  Use the `refresh_search_index` maintenance operation from Phase 7.3 rather than
  letting a 660-note backlog trickle in 258 notes at a time across the member's
  first ten queries. Migration is a bulk moment and should get the bulk path.

- [ ] **10.3 An imported `.smart-env` is treated as suspect, not as truth.**
  DECIDED: a migrated vault's existing plugin index is used only where Phase 1.3
  says an entry is fresh, exactly like any other. No special case, no trusting it
  because it looks populated. Add a fixture: a vault arriving with a populated
  but months-old `.smart-env` must come up with correct search and honest
  coverage.

- [ ] **10.4 The migration manifest records search state.** `MIGRATE.md`'s
  contract promises a manifest and reversibility. Note in it how many notes were
  embedded, how many are pending, and that search converges rather than being
  instantly complete. A member who migrates and immediately searches should not
  conclude their notes vanished.

- [ ] **10.5 Verify the whole migration path on a real copy.** Take a throwaway
  copy of a real multi-hundred-note vault, run the migration skill's passes
  against it, and confirm search comes up correct and honest at the end. Copy,
  never the original.

---

## Phase 11 -- Ship it, then tell the board

- [ ] **11.1 Rebuild the Astrolabe zip.**
  `powershell -NoProfile -ExecutionPolicy Bypass -File dashboard/dev/build-astrolabe-zip.ps1`
  in `second-brain-dashboard`. Then open the built zip and confirm the changed
  files are actually inside it. The builder excludes `test`, `docs`, `dist` and
  `dist-template`, and a file in the wrong place ships as silence.

- [ ] **11.2 Cut the kit release.** In `apc-second-brain-kit`: copy the zip to
  `functions/protected/astrolabe.zip`, bump `functions/kit-version.json`
  (currently 0.5.0, this is a minor bump), and add a `CHANGELOG.md` entry written
  for a member, saying what changes for them rather than what changed in the code.
  The repo documents the sequence under "How to cut a release".

- [ ] **11.3 Deploy and verify live.** `npm run deploy` from `functions/`.
  **Verify by fetching `https://apc-second-brain-kit.web.app/version` and reading
  the version back.** A successful deploy message is not verification.

- [ ] **11.4 Dan's own vault is left working.** Restart Astrolabe against
  `C:\Users\danie\Projects\JDH-Second-Brain`, let the catch-up run, and confirm
  `check_search_health` reports honest freshness and that a note written today is
  findable. It started at 7 fresh of 525; record the after number. Check for live
  Astrolabe tabs before restarting and let any busy one finish.

- [ ] **11.5 Commit and push all four repos.** `smart-connections-mcp`,
  `second-brain-dashboard`, `apc-second-brain-kit`, and the vault. `git status`
  each first. `second-brain-dashboard` has a pre-commit hook requiring a
  `KIT-CHANGELOG.md` entry for changes to staged Kit material.

- [ ] **11.6 Update the board, last.** Post results to
  [apc-ai-course#138](https://github.com/goggledefogger/apc-ai-course/issues/138):
  what shipped, before and after numbers from Dan's vault, confirmation that a
  fresh download gets verified search with no manual steps, that existing installs
  now self-heal, that the migration path handles its backlog, and anything that
  turned out differently from this tracker's assumptions. Answer whatever Danny
  or Roy raised on `CorpusState` and the health field names. Close the issue if
  nothing is left open; say what is left if something is.

---

## Progress log
_(One dated line per item as it ships.)_
- 2026-08-25: **0.1 shipped.** Rule 14 in the vault now says `unsearchable: 0`
  proves nothing and names the interim test, because leaving it intact told every
  agent to make an inference already demonstrated unsound. Vault commit `3aaf7c5`.
- 2026-08-25: Tracker created from the staleness diagnosis and Dan's review.
  Pre-work already done and recorded above: hash fields located in real data,
  `size` shown sufficient for the two known cases, and the RRF-suppression
  mechanism reproduced (lexical rank 6 of 55, absent from fused output), which
  resolves the open reconciliation from review point 5.

---

## Resuming this build

A ready-to-paste kickoff prompt for a genuinely fresh session lives in
[`KICKOFF-PROMPT.md`](KICKOFF-PROMPT.md), including the hard rules and the
verification standard. Prefer resuming over re-briefing when the session still
exists.

Default: `claude --continue` in this folder, or `claude --resume` and pick this
build's session. Read this tracker top to bottom, skim the diagnosis note in the
vault, check `git log` against what the tracker claims, then start at the first
unchecked box.

Phase 0 is vault work, not code, and is the only part that should happen before
anything else.
