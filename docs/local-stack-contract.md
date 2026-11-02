# Local stack metadata and recovery contract

Stack workflows run on the standalone CLI in an explicit native Git workspace.
Hosted admission refuses every stack command and local checkout option.

1. Versioned repository-local JSON lives in the native Git common directory at `gitea-axi/stacks.json`, outside tracked files.
   It records stack identity, ordered branch names, trunk, selected remote, origin and repository identity, and reconciled PR numbers with their base and head identities.
   It never stores credentials, credential-bearing URLs, or command output.
2. Metadata is validated once on read.
   Unknown versions and inconsistent branch membership are refused.
   An exclusive lock serializes mutations, and metadata replacements are atomic with private permissions.
   Concurrent stack changes refuse instead of automatically breaking another process's lock.
3. Preview and confirmation bind workspace identity, metadata revision, branch tips, relevant dirty state, selected remote and API preconditions.
   Local and API writes use the shared effect policy and secret-free journal, with explicit local operation grants alongside vendor grants.
   Preview performs no Git, stack metadata or API mutation.
4. Before a multi-step mutation, a pending record persists the original branch and tips and ordered step states.
   After interruption, `stack view` exposes the recorded checkpoint; inspect it alongside native Git and API state.
   `stack sync` can recover a pending sync or a push whose selected remote confirms every recorded branch tip; it never repeats the push.
   If pruning deleted a branch before its ownership checkpoint was saved, sync can release that ownership with or without `--prune`.
   Recovery requires a dispatched or completed prune checkpoint identifying the branch, PR number, head and merge commit, a matching original branch tip, unchanged closed-and-merged PR evidence, and locally available commits proving the head is included in the merge.
   An absent owned branch without that evidence, including a legacy checkpoint without prune evidence, refuses with `STACK_RECOVERY_REQUIRED` and preserves the checkpoint for inspection.
   Other pending operations require inspection rather than automatic replay.
   Unrelated mutations refuse while recovery is pending.
5. Rebase recovery retains the ordered original branch tips and current step.
   Native conflicts stop execution and retain Git's conflict state.
   `--continue` and `--abort` operate on the recorded rebase.
   They remain usable while native Git has HEAD detached, using the checkpoint's originally named branch.
   Abort restores the original stack tips and branch only when the recorded state still matches; otherwise it refuses and reports recovery instructions.
   If a native index lock stops abort, remove the lock only after its owning process has stopped, then preview and confirm abort again against the same checkpoint.
6. Sync pruning deletes only owned stack branches whose recorded PR is closed and verified merged, whose local tip matches the PR head, and whose tip is included in the verified merged history.
   Confirmed sync fetches existing remote trunk and stack branches before checking merge history, so merge objects need not already be local at preview time.
   When pruning has candidates, fetched refs must match the confirmed remote tips; a mismatch stops with `CONFIRMATION_MISMATCH` before deletion.
   Candidates whose merge commit remains unavailable or does not contain their tip are retained; eligible candidates use native `git branch -d` safeguards.
   Trunk, the current branch, branches checked out in another worktree and unowned branches are never pruned.
7. Submit requests automatic merge scheduling semantics and reports a compatibility gap when the retained Gitea contract cannot establish actual scheduling.
   Submit and link refuse `--open` before any effect.
   Merge proceeds in dependency order with checked heads and stops at the first failure.

Native Windows behavior and live commissioning require separate evidence.

At a repository-root workspace, `stack add --all` and `--update` both stage tracked modifications and deletions and leave untracked files untouched.
These flags are equivalent at that workspace boundary, cannot be combined, and require `--message`.
Without either staging flag, a requested commit uses only the existing index.
`stack rebase --preserve-dates` refuses with a compatibility gap before any effect.
Its acceptance item remains pending until upstream date semantics are evidenced.
