# smart-connections-mcp: one current corpus -- Build Tracker

**Source of truth for scope:** [`intelligence/research/2026-08-25-search-index-staleness.md`](https://github.com/bookbran/JDH-Second-Brain/blob/main/intelligence/research/2026-08-25-search-index-staleness.md)
in the vault, plus Dan's architectural review of it (logged at
[`intelligence/decisions/2026-08-25-current-corpus-architecture.md`](https://github.com/bookbran/JDH-Second-Brain/blob/main/intelligence/decisions/2026-08-25-current-corpus-architecture.md)).
This file tracks *doing* it.

**Board:** [apc-ai-course#138](https://github.com/goggledefogger/apc-ai-course/issues/138) (this work), split out of [#103](https://github.com/goggledefogger/apc-ai-course/issues/103) (the install path, shipped as kit 0.5.0).
**Status:** Phase 0.1 done. 0.2 open. Nothing in Phase 1 started.

## What this build takes from, to

**From:** retrieval treats "Smart Connections has an entry for this path" as a
proxy for "this note's current contents are represented in retrieval." Those are
different statements, and on Dan's vault they disagree for 509 of 525 notes.

**To:** exactly one place in the engine decides whether evidence is safe to use.
Disk presence establishes existence; a verified-current vector establishes
semantic coverage. The plugin stops being a source of truth and becomes one
source of reusable embeddings.

Phases are ordered blockers-first, and the build is not done when the engine is
fixed. **Phase 9 ships it**: a rebuilt zip, a kit release, a live deploy, and the
board told. A correctness fix that only ever runs on Dan's machine has not
helped the person the kit was built for.

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
  fast-path skip. If not, fall back to **`size` equality AND a tight mtime
  epsilon**, never mtime alone, and never a 1000ms slack. Done when a table of
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

- [ ] **6.1 Split the verdict.** `semanticReady`, `retrievalProbePassed`,
  `freshnessVerified`, `coverageComplete`, `negativeResultsTrustworthy`. A
  healthy-but-catching-up server is not a dead one, and one boolean `alive`
  cannot say that.

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

## Phase 9 -- Ship it to everyone, not just Dan's vault

Everything above fixes the engine. This phase is what turns that into something
a member who downloads the zip actually receives, and it ends by telling the
board.

**Read this before starting: the zip does NOT contain the bridge.** It contains
the dashboard, whose `seedSearchBridge` clones `bookbran/smart-connections-mcp`
from GitHub on a brain's first boot. So a fix merged to `main` here reaches every
NEW brain with no zip rebuild at all, and reaches NO existing install, ever,
because nothing pulls. That asymmetry is the whole content of this phase, and it
is a claim to verify rather than assume. Assuming it is how the original bug got
here.

- [ ] **9.1 Prove the fix reaches a new brain end to end.** On a throwaway brain
  directory, boot the dashboard fresh and let `seedSearchBridge` do its clone and
  build unaided. Then run `check_search_health` against it and confirm the new
  freshness fields are present and honest. Done when a brain that has never
  existed before comes up with verified-current search and nobody typed a command.

- [ ] **9.2 Decide what happens to existing installs.** Every member already
  running has a clone pinned at whatever `main` was on their first boot, and no
  mechanism updates it. Options, in rough order of preference: have
  `seedSearchBridge` fast-forward an existing clean clone on boot (cheap, and the
  bridge is not the member's code to conflict with); or expose a maintenance
  operation; or version-check and tell the agent to offer it. **Bring the
  recommendation to Dan rather than picking silently**, because it decides
  whether a shipped brain self-heals or quietly stays broken. Whatever is chosen
  needs a test.

- [ ] **9.3 Retire the Phase 0.2 caveat and describe the real contract.**
  `SEARCH-BRIDGE.md` ships inside the zip and into every seeded brain, so it is
  where an agent learns what search can and cannot promise. Remove the interim
  warning, document the new health fields, and state plainly which one answers
  "can I trust an empty result."

- [ ] **9.4 Simplify vault rule 14 to the shipped signal.** Phase 0.1 was
  deliberately interim wording. Per Dan's ruling, once the server reports it,
  the rule keys on one machine-readable field
  (`negativeResultsTrustworthy === true`) rather than making every agent
  reconstruct a four-field predicate. Vault repo, `CLAUDE.md`.

- [ ] **9.5 Rebuild the Astrolabe zip.**
  `powershell -NoProfile -ExecutionPolicy Bypass -File dashboard/dev/build-astrolabe-zip.ps1`
  in `second-brain-dashboard`. Then actually open the built zip and confirm the
  changed files are in it; the builder excludes `test`, `docs`, `dist` and
  `dist-template`, and a file in the wrong place ships as silence.

- [ ] **9.6 Cut the kit release.** In `apc-second-brain-kit`: copy the zip to
  `functions/protected/astrolabe.zip`, bump `functions/kit-version.json`
  (currently 0.5.0; this is a minor bump), and add a `CHANGELOG.md` entry written
  for a member, saying what changes for them rather than what changed in the
  code. The repo documents this sequence under "How to cut a release".

- [ ] **9.7 Deploy and verify live.** `npm run deploy` from `functions/`. Dan
  handles the Firebase auth prompt if it appears; `firebase login:list` should
  show `dan@aportlandcareer.com`. **Verify by fetching
  `https://apc-second-brain-kit.web.app/version` and reading the version back.**
  A successful deploy message is not verification.

- [ ] **9.8 Commit and push all four repos.** `smart-connections-mcp`,
  `second-brain-dashboard`, `apc-second-brain-kit`, and the vault. Check each for
  a dirty tree first. Note that `second-brain-dashboard` has a pre-commit hook
  requiring a `KIT-CHANGELOG.md` entry for any change to staged Kit material.

- [ ] **9.9 Update the board, last.** Post results to
  [apc-ai-course#138](https://github.com/goggledefogger/apc-ai-course/issues/138):
  what shipped, the before and after numbers from Dan's own vault (it started at
  7 fresh of 525), confirmation that a new brain from the zip gets verified
  search with no manual steps, what was decided for existing installs in 9.2, and
  anything that turned out differently from this tracker's assumptions. Close the
  issue only if 9.2 left nothing open. Danny and Roy were asked for a read on
  `CorpusState` and the health field names; answer whatever they raised in the
  same pass.

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
