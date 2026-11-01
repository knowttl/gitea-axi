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
   After interruption, recovery inspects actual Git and API state and reports completed, pending or uncertain work without automatically repeating a dispatched effect.
   Unrelated mutations refuse while recovery is pending.
5. Rebase recovery retains the ordered original branch tips and current step.
   Native conflicts stop execution and retain Git's conflict state.
   `--continue` and `--abort` operate on the recorded rebase.
   Abort restores the original stack tips and branch only when the recorded state still matches; otherwise it refuses and reports recovery instructions.
6. Sync pruning deletes only owned stack branches whose recorded PR is verified merged and whose local tip is included in the verified merged history.
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
