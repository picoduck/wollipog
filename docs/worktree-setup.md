# Worktree Setup Configuration

Wollipog can prepare a newly created session worktree from a repository-owned `.wollipog.json` file. The file is read from the immutable base commit before the agent starts.

Setup is always trust-gated. Wollipog hashes the exact configuration bytes and shows the commands, copies, and environment names for approval. Declining creates the worktree without setup. Changing any byte produces a new hash and requires a new approval. A checked-in or generated command is therefore a proposal, never permission to execute it.

## Generate a Starter

Use **Generate** in the first worktree session, use **Generate Starter Config** for a Project Location, or run this inside a Git checkout:

```sh
wollipog init
```

The generator reads bounded file names such as lockfiles and known ignored local configuration names. It never invokes a detected tool, reads secret file contents, executes setup, stages the generated file, or commits it. It creates only the repository-root `.wollipog.json` and refuses to overwrite an existing file, directory, or symbolic link. Review and commit the result like any other repository change.

Generating a valid file does not apply it retroactively to the current worktree. Wollipog reads setup from the immutable base commit when it creates a future worktree, then presents the exact configuration hash for trust approval.

## Version 1 Schema

```json wollipog
{
  "version": 1,
  "copyFiles": [
    {
      "source": ".env.local",
      "destination": ".env.local"
    }
  ],
  "environment": {
    "CACHE_DIR": "${WOLLIPOG_WORKTREE_PATH}/.cache"
  },
  "setup": [
    {
      "name": "Install Node Dependencies",
      "command": ["pnpm", "install", "--frozen-lockfile"],
      "timeoutSeconds": 600,
      "optional": false
    }
  ],
  "teardown": []
}
```

- `version` must be `1`.
- `copyFiles` contains relative `source` and `destination` paths. A destination must be ignored by Git. Existing destinations are preserved on retry.
- `environment` contains non-sensitive literal values. Values may interpolate `${WOLLIPOG_WORKTREE_PATH}`, `${WOLLIPOG_WORKTREE_BRANCH}`, `${WOLLIPOG_WORKTREE_BASE_REF}`, `${WOLLIPOG_PRIMARY_CHECKOUT}`, `${WOLLIPOG_PORT_BLOCK_START}`, `${WOLLIPOG_PORT_BLOCK_END}`, and `${WOLLIPOG_PORT_BLOCK_SIZE}`. Wollipog-reserved, authentication, network, loader, and process-control environment names are rejected.
- `setup` contains named argv arrays, not shell strings. `timeoutSeconds` is 1–3,600 and defaults to 600. `optional` defaults to `false`.
- `teardown` contains the separately ordered, trust-gated cleanup steps. See [Worktree Hooks and Ports](worktree-hooks-and-ports.md) for frozen teardown and stable port-allocation semantics.

All sections may be empty:

```json wollipog
{
  "version": 1,
  "copyFiles": [],
  "environment": {},
  "setup": [],
  "teardown": []
}
```

## Validation and Retry

Validation errors identify the failing key, for example `.wollipog.json.setup[0].command`. Invalid configuration never reaches copying or command execution. Project Settings reports status separately for every Location; offline and older Machines remain unknown rather than being mislabeled valid, absent, or invalid.

If a required setup step fails, **Retry Setup** resumes at that step and preserves successful earlier steps and copies. Optional failures are reported but do not stop later steps. Setup finishes before the agent receives the worktree.

## Trust Boundary

Approval is local to the Machine and exact project/configuration hash. Configuration values and copied file contents remain runner-private. Only bounded step names, timings, statuses, environment names, copy paths, and validation errors cross the control-plane boundary.

This repository's own [reference configuration](../.wollipog.json) uses the same schema and the same trust gate. Tests assert that an unapproved hash executes no command and copies no file.
