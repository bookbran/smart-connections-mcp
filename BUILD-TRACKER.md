# smart-connections-mcp: one current corpus -- Build Tracker

**Source of truth for scope:** [`intelligence/research/2026-08-25-search-index-staleness.md`](https://github.com/bookbran/JDH-Second-Brain/blob/main/intelligence/research/2026-08-25-search-index-staleness.md)
in the vault, plus Dan's architectural reviews of it (logged at
[`intelligence/decisions/2026-08-25-current-corpus-architecture.md`](https://github.com/bookbran/JDH-Second-Brain/blob/main/intelligence/decisions/2026-08-25-current-corpus-architecture.md)).
This file tracks *doing* it.

**Board:** [apc-ai-course#138](https://github.com/goggledefogger/apc-ai-course/issues/138) (this work), split out of [#103](https://github.com/goggledefogger/apc-ai-course/issues/103) (the install path, shipped as kit 0.5.0).

**Status: start at the first unchecked box.** Do not trust any remembered phase
number, including one in `KICKOFF-PROMPT.md`. Verify this file against `git log`
and `git status` before starting; if they disagree, the code wins and this file
gets corrected.

## What this build takes from, to

**From:** retrieval treats "Smart Connections has an entry for this path" as a
proxy for "this note's current contents are represented in retrieval." Those are
different statements, and on the vault they were measured to disagree for the
overwhelming majority of notes.

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
patch. When a tradeoff pits fresh-install quality against backwards
compatibility, fresh install wins.

**This tracker does not have checkpoints.** Every decision it needs has been made
and written down. Run it start to finish in one pass, exercising judgment where
something unforeseen comes up rather than stopping.

Phase 1 is the architectural change: doing Phase 2 onward without it just
scatters freshness checks through the engine and leaves the next tool to
rediscover this.

**Hard rule:** never widen the interactive embed budget as the fix for a
backlog. The 3,000-call cap exists because heading sections multiply one note
into many calls and an unbounded first run turns a member's first query into
minutes. Backlogs get better scheduling and a deliberate catch-up path.

**Second hard rule:** every freshness predicate biases toward false-stale. A
false stale costs one unnecessary embedding. A false fresh is a confidently
wrong answer, which is the entire bug.

---

## Decisions already made, so this build never stops to ask

Make the calls, run it in one pass. Where something genuinely unforeseen comes
up, use judgment and **write down what you decided and why** in the progress log,
then keep going.

| Question | Decision |
|---|---|
| Freshness predicate | **Canonical content hash.** Never mtime, never size, never both, not even as a skip. |
| Legacy plugin vectors when the Smart Connections hash is not reproducible | **Unverified, therefore stale, once.** Re-embed through the supplemental path and store our own hash from then on. |
| What gets hashed | A canonical text form, versioned as `canonical-markdown-sha256-v1`. Raw bytes are not safe: CRLF makes them lie. |
| Stale vectors in ranking | Dropped, whole-note and block together. |
| Interactive embed budget | Stays 3,000 total, but interactive work gets a much smaller sub-budget and never blocks on generic backlog. |
| Health field names | `semanticReady`, `retrievalProbePassed`, `freshnessVerified`, `coverageComplete`, `negativeResultsTrustworthy`, plus `verifiedAt` and a corpus generation id. Keep `alive` as derived. |
| Corpus lifetime | A **snapshot**, reconciled before each retrieval operation and health check. Correctness first; optimize only against measurements. |
| Bridge version for installs | A **pinned tested revision** carried by the dashboard, not whatever is on `main`. |
| Existing installs | Self-heal to the pinned revision when the clone is clean; refuse loudly otherwise. |
| An imported stale `.smart-env` | Treated exactly like any other index. No special case. |
| Migration backlog | Explicit bulk refresh, resumable and idempotent, triggered by the migration agent. |
| Fresh install vs backwards compatibility | Fresh install wins. |
| Rule 14 | Interim wording now, simplified to `negativeResultsTrustworthy` once the server reports it. |

**The bar for stopping is real harm, not uncertainty.** Do not stop to confirm a
design choice, a name, a threshold, or an ordering. Do stop for: destroying a
member's data, force-pushing over someone else's work, a dirty tree this build
did not create, or anything that cannot be undone with `git revert`.

**When a decision above turns out to be wrong once it meets the code**, change
it, say so in the progress log with the reason, and continue. A tracker decision
is a starting position, not a cage. Stalling on it is the only wrong move.

---

## Baseline observations, 2026-08-25 (NOT assertions to test against)

These were measured once, on Dan's vault, at the moment the bug was found. They
are here so nobody re-derives them. **The vault changes daily, so every
verification step must recompute live values rather than expect these
constants.** Use them to recognize the shape of the problem, never as a test
oracle.

- ~700 notes on disk; ~525 plugin sources, of which **7 fresh, 509 stale, 9
  phantom** (deleted `cursor-skills/`). Median staleness 67 days, max 107.
- `check_search_health` returned `unsearchable: 0` throughout, because both
  sides of that subtraction were built from the same two indexes.
- **Hash fields exist in the plugin data.** A real source record carried
  `last_import: {mtime, size, at, hash: "v9osj6"}` and
  `embeddings["TaylorAI/bge-micro-v2"].last_embed: {tokens, hash: "v9osj6"}`.
  The two matched on that one fresh entry. **That is all that is known**: the
  algorithm is unknown, and so is what the hash covers. 6 chars, base36-ish.
- **The stale vector actively suppresses lexical rescue.** Reproduced: a stale
  note ranked **6th of 55** in `searchByKeyword` for a literal phrase and still
  never appeared in fused output, because its stale vector earned a terrible
  dense rank and RRF buried a lexical-only hit under notes scoring in both lists.
  Dropping stale vectors therefore *restores* a fallback path.

---

## Freshness is content, and only content

An earlier draft made freshness a `size` plus `mtime` test. That was wrong, and
the evidence was already in this codebase. From `second-brain-dashboard@e2b0e66`,
which moved the recency signal off mtime for the globe and the project rail:

> The recency signal read file mtime, which records when a PROCESS wrote a file,
> not when a person worked on it. A sync, checkout, restore, or tag migration
> rewrites every mtime to now and flattens the ranking, which bites hardest on a
> vault that lives on two machines.

That is exactly this vault. It travels between machines by git, and a pull or a
fresh clone rewrites mtimes wholesale. An mtime-based test would mark the entire
vault stale on every machine switch: thousands of embed calls against a
3,000-call budget, several runs to converge, every time Dan switches laptops.
Fails in the safe direction, but wastefully enough to feel broken.

Size is stable across git and misses a same-size edit. Neither half is
sufficient, and the combination inherits both flaws.

### No mtime/size skip, not even as an optimization

A previous draft kept mtime and size as a "cheap skip": if both are unchanged,
do not bother re-hashing. **That is unsafe and it is deleted.** A same-size edit
whose timestamp is preserved, deliberately or by a copy tool, makes the cache
reuse an old hash without ever reading the file and declare changed content
unchanged. That is a false-fresh, which is the exact failure this whole build
exists to remove.

**Version 1 always hashes the corpus during reconciliation.** Hashing markdown is
cheap next to embedding it. Optimize only after there is timing data proving it
matters, and if a skip cache is ever reintroduced, document its guarantee
honestly as probabilistic unless some other authoritative invalidation signal
backs it.

### What "content hash" means, precisely

Hashing raw bytes is not safe here. `core.autocrlf=true` on at least one machine
means git can hand the same logical note to two machines with different line
endings, and a raw-byte hash would call that a change and invalidate the world.

Hash a **canonical text representation**, and ideally the exact representation
the chunker and embedder consume:

- UTF-8 decoded text
- BOM handled consistently (strip it)
- CRLF and lone CR normalized to LF
- everything else preserved exactly

Give it a versioned identity stored beside every digest, so a future change to
canonicalization invalidates deliberately rather than silently:

```
contentHashAlgorithm: "canonical-markdown-sha256-v1"
contentHash: "<hex>"
```

### The legacy-vector bootstrap problem

There is a step this build must not skip. **Our own newly computed hash cannot
validate a plugin vector that already exists**, because we do not possess our
hash of the content as it was when that vector was created. Comparing our fresh
hash to nothing proves nothing.

So the rule is explicit:

```
IF the Smart Connections hash is reproducible AND is proven to describe
   the embedded content:
       fresh  <=>  canonicalContentHash(current) == last_embed.hash

IF it is NOT reproducible:
       every preexisting plugin vector lacks a verifiable fingerprint.
       Treat them all as unverified, therefore stale, ONE TIME.
       Re-embed through the supplemental path.
       Store our own contentHash alongside every vector produced from then on.
```

The penalty is a one-time full re-embed. The alternative is bootstrapping trust
from metadata already judged non-authoritative, which is how this bug happened.

---

## Two things about generated files, found 2026-08-25

Relevant because they are what an agent in a NEW brain reads first, and because
this build is about generated artifacts drifting from their source with nothing
checking.

**`server.js` is hand-written.** No generator to conflict with.

**The contract IS generated.** `dev/compile-contract.js` compiles
`dashboard/contract/canonical.js` into `contract/runtime-dashboard.md` and
`runtime-editor.md`, which `server.js` injects into every live session prompt.
Verified content-current. The generators live at the REPO ROOT `dev/`, not
`dashboard/dev/`.

**The contract says nothing at all about search.** No conflict for this build to
resolve, which was the worry, but a gap: the document every agent reads first is
silent on whether an empty search result can be believed.

**`BRAIN.md` is stale against its generator by its header block only** (10 lines
of HTML comment, no behavioral drift). Separately, `core.autocrlf=true` on this
machine plus generators that write LF means every generated file reads as
modified and every byte-comparison test fails locally. That is an environment
condition, not a repo bug.

---

## Phase 0 -- Stop the bleeding

- [x] **0.1 Patch rule 14 in the vault.** DONE 2026-08-25, vault `3aaf7c5`.
  It told every agent to trust `mode: semantic` + `unsearchable: 0`, a predicate
  that cannot fail.

- [ ] **0.2 Note the same caveat in `SEARCH-BRIDGE.md`** so a brain shipped from
  the kit carries the warning until the fixed server ships.

---

## Phase 1 -- One definition of reality (the architectural change)

- [ ] **1.1 One canonical path function, before any set operation.**
  `CorpusState` only buys structural correctness if every producer agrees what a
  path means. Normalize plugin paths, walker paths, supplemental cache keys and
  search-result paths through a single function. Test slash direction, `./`
  prefixes, relative roots, and whatever casing Smart Connections actually emits
  on Windows. Never let one set hold `daily\2026\a.md` while another holds
  `daily/2026/a.md`. This is architecture, not housekeeping: every later phase is
  a set operation and set operations on disagreeing keys fail silently.

- [ ] **1.2 `VaultInventory`: what exists on disk, with an error class.**
  `Map<canonicalPath, {path, size, mtimeMs}>` from `listMarkdown`. The only thing
  allowed to answer "does this note exist." **A file that exists but cannot be
  read is neither absent nor covered**: give it an explicit `unreadable`
  classification rather than letting it vanish from `onDisk` or count as covered.

- [ ] **1.3 Canonical content hashing.** Implement
  `canonical-markdown-sha256-v1` per "What content hash means, precisely" above:
  UTF-8 decode, strip BOM, normalize CRLF and lone CR to LF, preserve everything
  else. Store the algorithm id beside every digest. Hash failures are their own
  error class, never silently treated as either fresh or stale.

- [ ] **1.4 Characterize the Smart Connections hash before trusting it.**
  Do not conclude it is "reproduced" because one file yields `v9osj6`. The
  question is not only how to compute it but **what it covers**. Vary each of
  these independently and record when the hash changes: body text, a heading,
  frontmatter, trailing and interior whitespace, line endings, and a same-size
  character substitution. Also check Smart Connections' bundled `main.js`
  directly, the way the mean-vs-CLS pooling detail was confirmed in August.
  **If it does not provably track the embedded content, treat it as
  unreproducible** and take the legacy-bootstrap path.

- [ ] **1.5 Classify every plugin source as `fresh | stale | phantom |
  unreadable`.** Phantom: not in the inventory. Fresh: only per 1.4's outcome and
  the bootstrap rule. Expose as sets on the loader, never as freshness checks
  scattered through the engine.

- [ ] **1.6 `CorpusState` is a SNAPSHOT, with a lifetime.**
  Not "built once per server run": a long-lived server whose corpus was correct
  at launch is a smaller version of this same bug. Carry
  `generation` (or `snapshotId`), `verifiedAt`, `onDisk`, `pluginFresh`,
  `pluginStale`, `pluginPhantoms`, `supplementalFresh`, `semanticPending`, and
  the error classes. **Reconcile before each retrieval operation and each health
  check.** Correctness first; measure the latency, and optimize the reconciliation
  mechanism later without weakening the contract. Otherwise
  `freshnessVerified: true` means "was fresh at some unspecified time since
  launch," which is weaker than any agent will assume.

---

## Phase 2 -- Make semantic retrieval tell the truth

- [ ] **2.1 Supplemental indexing consumes "needs a current vector," not
  "missing path."** Replace `!knownPaths.has(p)` with membership in
  `semanticPending`. Deliberately after Phase 1 so it is a set operation rather
  than a second implementation of freshness.

- [ ] **2.2 A vector is bound to the exact content that produced it.**
  Close this race:
  ```
  read file -> hash A -> begin embedding -> member edits file (content B)
            -> embedding finishes -> vector installed as "current"   WRONG
  ```
  Read the content ONCE, canonicalize it, hash **that same text**, chunk **that
  same text**, and embed those chunks. Before promoting the result into
  `supplementalFresh`, reconcile the file again: if its content hash changed
  during the job, keep the vector in cache if useful but mark it pending, not
  current. The invariant to hold: **a current vector carries the fingerprint of
  exactly the content it was built from, and that fingerprint still equals
  disk.**

- [ ] **2.3 Drop stale vectors from ranking, whole-note AND block together.**
  Filtering `pluginVectors()` without also filtering `getBlockVectors()` leaves
  the bug intact, because `denseScores` takes the max and a stale block can be
  the strongest signal for a note.

- [ ] **2.4 Verify the lexical rescue comes back.** Regression test: a note with
  a stale plugin vector and a unique literal phrase must be returned by
  `search_notes`. This currently fails and is the sharpest single proof the fix
  worked.

---

## Phase 3 -- Make the lexical corpus the whole vault

- [ ] **3.1 `searchByKeyword` iterates the inventory, not `getSources()`.**
  A note Smart Connections has never seen is currently invisible to keyword
  fallback despite sitting on disk. Result: lexical corpus = every readable
  markdown file; semantic corpus = every file with a verified-current vector.
  This is what makes an indexing backlog non-catastrophic.

---

## Phase 4 -- Coverage by set difference

- [ ] **4.1 Compute coverage with sets, never by adding counts.**
  `searchablePaths = semanticPaths INTERSECT onDiskPaths`;
  `unsearchablePaths = onDiskPaths MINUS searchablePaths`. Makes three bug
  classes structurally impossible: duplicate paths inflating `searched`,
  phantoms inflating anything, and plugin/supplemental overlap making
  `searched > vaultTotal`.

- [ ] **4.2 New coverage contract, with errors visible.** Separate `semantic`
  (searchable, pending, pluginFresh, supplementalFresh) from `lexical`
  (searchable) from `plugin` (sources, fresh, stale, phantom). Surface
  `inventoryErrors`, `hashFailures`, `embedFailures`, `unreadable`. **Any
  unresolved corpus error prevents `coverageComplete` and `freshnessVerified`
  from being true.** Same philosophy as not letting the health check grade its
  own homework.

---

## Phase 5 -- Every other retrieval surface, and making bypass hard

- [ ] **5.1 `getCurrentVectorCorpus()`, and everything semantic uses it.**
  Merges fresh plugin vectors with current supplemental vectors. Without this,
  `search_notes` returns current results while `get_similar_notes` and
  `get_connection_graph` still answer from the old snapshot. May require making
  `getSimilarNotes` async; worth it.

- [ ] **5.2 The query note gets the same treatment.** If a note is stale in the
  plugin but fresh in supplemental, `get_similar_notes` on that note must use
  the supplemental vector. Easy to miss because the source note is fetched by a
  different call path than the comparison set.

- [ ] **5.3 `get_connection_graph` and `get_embedding_neighbors`** inherit the
  fix via 5.1; add a test that proves it rather than assuming.

- [ ] **5.4 `getStats` reports vault-world, not plugin-world.** Split into
  `vaultNotes`, `pluginSources`, `pluginFresh`, `supplemental`,
  `semanticSearchable`.

- [ ] **5.5 Block metadata is only trustworthy for fresh notes.** Plugin sources
  carry heading-to-line-range mappings; once a file changes those coordinates are
  as suspect as the vectors. Use them only for `pluginFresh`, or derive headings
  from current markdown.

- [ ] **5.6 Make bypassing the corpus hard in code, not just forbidden in
  prose.** Once `getCurrentVectorCorpus()` exists, make raw access
  (`loader.getSources()`, raw block vectors) private or explicitly unsafe
  everywhere outside the classifier. Search, similar-notes, graphs, neighbors,
  stats and block access all consume the facade. **Add an architectural
  regression check** (a static or grep-based test is fine) that fails if a
  retrieval module reaches the raw plugin corpus directly. Without it, six months
  from now someone adds `find_related_projects()` and naturally calls
  `loader.getSources()` again, and this whole build quietly regresses in one
  function.

---

## Phase 6 -- Health that separates several different questions

- [ ] **6.1 Split the verdict, with these exact names and these exact
  formulas.** Names are decided; the implementation must not invent their
  meaning:
  ```
  semanticReady              = embedding/search machinery initialized and usable
  retrievalProbePassed       = independent retrieval probes passed
  freshnessVerified          = the current CorpusState snapshot reconciled
                               successfully, with no unhandled read, hash or
                               classification failures
  coverageComplete           = every eligible on-disk note has a
                               verified-current semantic vector
  negativeResultsTrustworthy = semanticReady && retrievalProbePassed
                               && freshnessVerified && coverageComplete
  ```
  Also return `verifiedAt` and the corpus `generation` id. A naked boolean is far
  less useful than one you can tell the age of. Keep `alive` as a derived
  convenience so nothing reading it today breaks.

- [ ] **6.2 Redefine the title probes as retrieval probes.** They draw expected
  notes from the live index, so they test reachability of the historical corpus
  and pass happily on a stale one. Keep them, rename the concept, and establish
  freshness mechanically from fingerprints instead.

- [ ] **6.3 Give agents one field to read.** `negativeResultsTrustworthy` is
  what rule 14 keys on, rather than every agent reconstructing the predicate from
  four numbers.

---

## Phase 7 -- Two operating modes, not one budget

- [ ] **7.1 Interactive repair is bounded and never blocks on backlog.**
  ```
  Interactive search:
    lexical scan immediately
    repair a SMALL bounded set of query-relevant pending notes
    return the result
    never spend the remaining general budget synchronously
  ```
  Spending "whatever budget is left" before returning a query is exactly the
  multi-minute first query this cap exists to prevent. The 3,000 total can stay
  while the interactive sub-budget is much smaller.

- [ ] **7.2 Prioritize query-relevant and recently-modified notes.** Lexically
  scan the current vault, find high-ranking pending candidates, repair those
  first. Directory order means a note edited today waits behind hundreds of
  unrelated ones.

- [ ] **7.3 `refresh_search_index`: resumable, idempotent, reporting.** Phase 10
  depends on this, so it has to be real before then. Define behaviour on
  interruption, reboot, a failed embedding call, and a second invocation. Return
  at least:
  ```
  attempted, refreshed, alreadyCurrent, failed, remaining, corpusGeneration
  ```
  and continue safely on the next run.

- [ ] **7.4 `SMART_INDEX_EMBED_BUDGET` as configuration**, with the interactive
  sub-budget separately configurable.

---

## Phase 8 -- Regression fixtures

- [ ] **8.1 Fixtures for every case that produced this bug:** stale edit,
  same-size edit, touched-but-unchanged file, deleted file still in the index,
  plugin-missing file, unreadable file, budget exhaustion mid-run, stale block
  outranking a fresh note, and graph/similarity calls against a stale source
  note.

- [ ] **8.2 The combined case, which is the one that defeats a metadata cache:**
  same-size changed content **and** preserved timestamp **and** a different
  line-ending environment **and** a preexisting plugin vector, all at once. Each
  ingredient is tested separately elsewhere; this is the one that breaks anything
  clever.

- [ ] **8.3 A fresh `git clone` of a vault must not invalidate a single note.**
  Clone rewrites every mtime; canonical hashing must be indifferent to that.

- [ ] **8.4 A test that fails on a stale index by construction**, so this class
  of bug cannot ship silently again.

---

## Phase 9 -- The fresh-download path (the one that matters most)

Almost nobody is running this yet. That is the opportunity: a fresh download can
be made correct with no migration story at all. **Fresh install is the highest
priority surface in this build.**

**Read this first: the zip does NOT contain the bridge.** It contains the
dashboard, whose `seedSearchBridge` clones the bridge from GitHub on a brain's
first boot. Verify that claim rather than assuming it.

- [ ] **9.1 Pin the bridge to a tested revision.** DECIDED, and it changes the
  release model. Do not have installs track whatever happens to be on `main`: a
  future bad commit would ship to every brain on next boot, before any kit
  release tested it. The dashboard carries a **target revision** (tag or commit);
  fresh installs check that out, and self-healing installs move to that revision.
  Then "kit 0.6.0" corresponds to a reproducible bridge build. If continuously
  tracking `main` is ever wanted, that is a deliberate product decision recorded
  as such, not an installer detail.

- [ ] **9.2 Prove the fix reaches a brand new brain, end to end, unaided.** On a
  throwaway brain directory, boot the dashboard fresh and let `seedSearchBridge`
  clone and build with nobody helping it. Then run `check_search_health` and
  confirm the new fields are present and honest. Done when a brain that never
  existed before comes up with verified-current search and no human typed a
  command.

- [ ] **9.3 Existing installs self-heal to the pinned revision.**
  `seedSearchBridge` moves an existing bridge clone to the target revision when
  it is safe: it is a git repo, the remote is `bookbran/smart-connections-mcp`,
  the tree is clean. Then check out the pinned revision and rebuild if it moved.
  Any other state (dirty tree, a fork, someone's local work) logs the reason and
  leaves it alone. Rationale: the bridge is infrastructure, not the member's
  code, and a shipped brain that cannot self-heal means this bug lives forever in
  the installs of people who will never know to ask. Detached and non-fatal like
  the install. Test both legs, the clean move and the refusal.

- [ ] **9.4 Retire the interim caveat and state the real contract.**
  `SEARCH-BRIDGE.md` ships in the zip and into every seeded brain. Remove the
  Phase 0.2 warning, document the new health fields, and say plainly which single
  field answers "can I trust an empty result."

- [ ] **9.5 The canonical contract learns that search can be blind.**
  `dashboard/contract/canonical.js` compiles into the runtime contract injected
  in EVERY session, so it is the earliest surface an agent in a new brain reads.
  Add one short invariant: an empty search result is only evidence of absence
  when the health signal says so, and name the field. Recompile with
  `node dev/compile-contract.js` (repo root `dev/`) and commit the regenerated
  runtime files, or the shipped contract will not match its own source.

- [ ] **9.6 Regenerate `BRAIN.md`.** It carries 10 lines its generator no longer
  produces. Header comment only, but this build has no business shipping a
  generated file that disagrees with its generator. `node dev/sync-brain.js`.

- [ ] **9.7 Simplify vault rule 14 to the shipped signal.** Phase 0.1 was
  deliberately interim. Now that the server reports it, the rule keys on
  `negativeResultsTrustworthy === true`. Leaving the interim wording in place
  after the fix ships is its own kind of stale.

- [ ] **9.8 Measure time to first useful search result, not just budget
  compliance.** A fresh brain embeds its whole vault on first use. The number
  that matters to a member is how long until their first question returns
  something useful, with lexical answering immediately while semantic converges.
  Confirm health reports `coverageComplete: false` during convergence rather than
  claiming completeness it has not earned.

---

## Phase 10 -- The migration path, where the backlog actually bites

A member bringing an existing vault in is the one case that dumps hundreds of
notes into a brain at once (roughly 660 on Dan's own migration). Against a
3,000-call budget, a migrated brain is **guaranteed** to start with a large
semantic backlog. Migration is also the exact moment a member is most likely to
arrive carrying a stale `.smart-env` from an Obsidian install they stopped
opening, which is this bug, pre-installed.

- [ ] **10.1 `MIGRATE.md` wires in search, as a real step.** The migration skill
  currently ends at frontmatter passes and hands off to name-your-world. Add a
  step after the passes: ensure the bridge is installed and the migrated notes
  are embedded. Written as the agent's job and never the member's.
  **Describe it as "triggered automatically by the migration agent," not as
  "runs in the background,"** unless a durable job lifecycle has actually been
  implemented and verified. Whether it is blocking, detached or resumable is an
  implementation fact to state accurately, not a comfortable phrase.
  `dashboard/MIGRATE.md` is Kit material, so the commit needs a
  `KIT-CHANGELOG.md` entry in the same pass or the pre-commit hook refuses it.

- [ ] **10.2 Migration calls `refresh_search_index`**, the resumable bulk path
  from 7.3, rather than letting a 660-note backlog trickle in across the
  member's first ten queries.

- [ ] **10.3 An imported `.smart-env` is treated as suspect, not as truth.**
  A migrated vault's plugin index is used only where Phase 1 says an entry is
  fresh, exactly like any other, and under the legacy-bootstrap rule that is
  usually nowhere. Fixture: a vault arriving with a populated but months-old
  `.smart-env` must come up with correct search and honest coverage.

- [ ] **10.4 The migration manifest records search state.** `MIGRATE.md`'s
  contract promises a manifest and reversibility. Record how many notes were
  embedded, how many are pending, and that search converges rather than being
  instantly complete. A member who migrates and immediately searches should not
  conclude their notes vanished.

- [ ] **10.5 Verify the whole migration path on a real copy.** Take a throwaway
  copy of a real multi-hundred-note vault, run the migration passes against it,
  and confirm search comes up correct and honest at the end. Copy, never the
  original.

---

## Phase 11 -- Ship it, then tell the board

Packaging phases are not exempt from verification, but the standard is different:
they cannot "fail on a stale index," so instead **prove the built artifact
contains the fix and executes it.**

- [ ] **11.1 Rebuild the Astrolabe zip.**
  `powershell -NoProfile -ExecutionPolicy Bypass -File dashboard/dev/build-astrolabe-zip.ps1`
  in `second-brain-dashboard`. Then open the built zip and confirm the changed
  files are inside it. The builder excludes `test`, `docs`, `dist` and
  `dist-template`, and a file in the wrong place ships as silence.

- [ ] **11.2 Prove the artifact executes the fix.** Extract the built zip to a
  clean directory, run it against a throwaway brain, and confirm the health
  output carries the new fields. Building is not shipping and containing is not
  executing.

- [ ] **11.3 Cut the kit release.** In `apc-second-brain-kit`: copy the zip to
  `functions/protected/astrolabe.zip`, bump `functions/kit-version.json`
  (currently 0.5.0, minor bump), record the pinned bridge revision from 9.1, and
  add a `CHANGELOG.md` entry written for a member. The repo documents the
  sequence under "How to cut a release".

- [ ] **11.4 Deploy and verify live.** `npm run deploy` from `functions/`.
  **Verify by fetching `https://apc-second-brain-kit.web.app/version` and reading
  the version back.** A successful deploy message is not verification.

- [ ] **11.5 Dan's own vault is left working.** Restart Astrolabe against
  `C:\Users\danie\Projects\JDH-Second-Brain`, let catch-up run, and confirm
  health reports honest freshness and that a note written today is findable.
  Recompute the live before/after numbers rather than quoting the baseline.
  Check for live Astrolabe tabs before restarting and let any busy one finish.

- [ ] **11.6 Commit and push all four repos.** `smart-connections-mcp`,
  `second-brain-dashboard`, `apc-second-brain-kit`, and the vault. `git status`
  each first. `second-brain-dashboard` has a pre-commit hook requiring a
  `KIT-CHANGELOG.md` entry for changes to staged Kit material.

- [ ] **11.7 Post the final results comment and close.** Interim phase comments
  on #138 are welcome throughout; **this is the one that reports results and
  closes.** Include what shipped, live before/after numbers, confirmation that a
  fresh download gets verified search with no manual steps, that existing
  installs self-heal to a pinned revision, that migration handles its backlog,
  and anything that turned out differently from this tracker's assumptions.
  Answer whatever Danny or Roy raised. Close only if nothing is left open; say
  what is left if something is.

---

## Progress log
_(One dated line per item as it ships.)_
- 2026-08-25: **Second review integrated.** Five correctness changes: the
  mtime/size skip cache is deleted (a preserved-timestamp same-size edit makes it
  claim false-fresh); the legacy-vector bootstrap path is defined (our own hash
  cannot validate a vector created before we had it, so unreproducible means
  unverified means one full re-embed); content hashing is specified as canonical
  text rather than raw bytes, because CRLF would otherwise invalidate the world;
  `CorpusState` becomes a reconciled snapshot rather than a launch-time fact; and
  a vector is now bound to the exact content instance that produced it, closing
  an edit-during-embed race. Also: path canonicalization promoted to Phase 1.1,
  error classes made first-class, health formulas specified, interactive and bulk
  repair split, the bridge pinned to a tested revision instead of tracking
  `main`, and the baseline numbers relabeled as observations rather than test
  oracles.
- 2026-08-25: **0.1 shipped.** Rule 14 in the vault now says `unsearchable: 0`
  proves nothing and names the interim test. Vault commit `3aaf7c5`.
- 2026-08-25: Tracker created from the staleness diagnosis and Dan's review.

---

## Resuming this build

A ready-to-paste kickoff prompt for a genuinely fresh session lives in
[`KICKOFF-PROMPT.md`](KICKOFF-PROMPT.md). Prefer resuming over re-briefing when
the session still exists.

Default: `claude --continue` in this folder, or `claude --resume` and pick this
build's session. Read this tracker top to bottom, check `git log` and
`git status` against what it claims, then **start at the first unchecked box**.
If the tracker and the code disagree, the code wins and the tracker gets
corrected.
