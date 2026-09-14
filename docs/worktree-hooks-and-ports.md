# Worktree Hooks and Ports

Wollipog can prepare and retire runner-owned session worktrees from a repository-owned
`.wollipog.json` file at the repository root. The runner reads the file from the worktree's
immutable base commit, asks the user to trust its exact content hash, and stores the approved
teardown identity in runner-private state. Later edits in the worktree cannot change what cleanup
runs. Attached operator-owned worktrees never receive hooks or port allocations.

Worktree port blocks and teardown state require runner protocol v145. When connected to a v144 or
older control plane, the runner omits those additive fields from its worktree snapshots.

## Configuration

Version 1 supports ignored-file copies, literal environment values, ordered setup steps, and
ordered teardown steps:

```json
{
  "version": 1,
  "copyFiles": [
    { "source": ".env.local", "destination": ".env.local" }
  ],
  "environment": {
    "APP_PORT": "${WOLLIPOG_PORT_BLOCK_START}",
    "PROJECT_ROOT": "${WOLLIPOG_WORKTREE_PATH}"
  },
  "setup": [
    {
      "name": "Install Dependencies",
      "command": ["pnpm", "install", "--frozen-lockfile"],
      "timeoutSeconds": 600
    }
  ],
  "teardown": [
    {
      "name": "Remove Local Resources",
      "command": ["pnpm", "run", "worktree:teardown"],
      "timeoutSeconds": 120,
      "optional": false
    }
  ]
}
```

Commands are argv arrays, not shell strings. Step names must be unique within their phase.
`timeoutSeconds` defaults to 600 and must be from 1 through 3600; the sum for each phase cannot
exceed 3600 seconds. `optional` defaults to false. Teardown always attempts every declared step,
including steps after required failures.

Environment values are literals with these runner-owned placeholders:

- `${WOLLIPOG_WORKTREE_PATH}`
- `${WOLLIPOG_WORKTREE_BRANCH}`
- `${WOLLIPOG_WORKTREE_BASE_REF}`
- `${WOLLIPOG_PRIMARY_CHECKOUT}`
- `${WOLLIPOG_PORT_BLOCK_START}`
- `${WOLLIPOG_PORT_BLOCK_END}`
- `${WOLLIPOG_PORT_BLOCK_SIZE}`

The resolved variables are available to setup, teardown, and the agent process. Credential,
provider-endpoint, proxy, executable-loader, Git/SSH, runtime-injection, home, temporary-directory,
and other Wollipog-reserved environment names are rejected. Copy destinations must be ignored by
Git and cannot escape the worktree; existing destinations are not overwritten on retry.

## Teardown Lifecycle

Explicit discard, merged-pull-request reconciliation, session deletion, creation rollback, and
startup cleanup all use the same durable cleanup journal. For each runner-owned worktree, cleanup:

1. Records the exact trigger, approved hook material, port block, and worktree identity.
2. Terminates the runner provider and runner-started terminals for that exact worktree, including
   marked descendants that escaped their original process group.
3. Runs the frozen teardown steps under the same execution-isolation policy as setup.
4. Removes the worktree after Git safety checks where the initiating operation requires them.
5. Releases the port block only after worktree removal succeeds and writes a bounded completion
   receipt containing step status and output.

Teardown failures are recorded and surfaced but do not prevent an otherwise authorized worktree
removal. If the runner crashes after recording that a step started but before recording its result,
recovery marks that step `uncertain`, does not replay it, and continues with steps that never
started. This is an at-most-once policy for ambiguous steps.

## Port Allocation

Each active runner-owned worktree receives a stable contiguous port block. The default runner pool
is ports 42000 through 51999 in blocks of 20. Configure it in `runner.config.json`:

```json
{
  "worktreePorts": {
    "start": 42000,
    "end": 51999,
    "blockSize": 20
  }
}
```

The inclusive range must stay within ports 1024 through 65535 and contain at least one whole block.
Allocations persist across runner
restarts. A configuration change preserves existing live blocks and places new blocks only where
they do not overlap; exhaustion fails worktree preparation with the configured range, block size,
and capacity. Cleanup releases a block only after the corresponding worktree is gone.
