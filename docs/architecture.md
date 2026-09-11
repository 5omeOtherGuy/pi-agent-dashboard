# Architecture

One worker is one supervisor process. `pi-orch run` (or `orch_spawn`) starts a detached
supervisor, which starts and owns a `pi --mode rpc` child, publishes a record every dashboard
can read, serves a control socket and enforces the deadline. The session that dispatched the
worker is not part of the worker's lifetime.

## State directory

`$PI_ORCH_STATE_DIR`, else `$PI_CODING_AGENT_DIR/subagent-dashboard`, else
`~/.pi/agent/subagent-dashboard`:

    workers/<id>.json       worker record, written by its supervisor with temp+rename
    workers/<id>.ctl.sock   control socket for that worker
    logs/<id>.log           detached supervisor stdout and stderr
    briefs/<id>.md          briefs passed to orch_spawn as text
    runs/<id>/              default run directory for orch_spawn
    audit.jsonl             one line per control action
    config.json             optional, described in config.md
    cli                     absolute path of the CLI, written by the last CLI run

The directory is mode 0700, each socket 0600, and each record has one writer and any number of readers.

## Run directory

`--run-dir` must be a fresh directory whose parent exists; `run` creates the parent and the
`--cwd`. A directory that already holds `result.json` or `events.jsonl` is refused.

    launch.json     selection, brief digest and status at launch, rewritten when running
    events.jsonl    raw RPC events from the worker
    session.jsonl   the worker's Pi session file, unless --session names another file
    result.json     final report plus the definition-of-done rows
    stderr.txt      worker stderr

## Control channel

Each supervisor listens on `<state>/workers/<id>.ctl.sock`: newline-delimited JSON, one request
per line, commands `status`, `steer`, `follow_up`, `abort`, `stop`, `answer`, and a reply of
`{ok, data}` or `{ok: false, error}` with a 5 second client timeout. The caller's `by` field is
written to `audit.jsonl` with every mutation. A steer is sent to the worker first; counters and
audit are written only after Pi accepts, so a failed send returns the error to the caller and
leaves the run untouched.

## Lifecycle

    starting          record published, worker process not yet verified
    running           get_state verified the provider, model and thinking level
    awaiting-input    the worker raised a dialog and, with --input park, the run waits
    completed         the final assistant message had stopReason "stop" and text
    failed            any other error before completion
    timeout           the wall-clock deadline elapsed
    stopped           abort, stop or a signal reached the supervisor

`stale` is not written by a live supervisor: it is derived at read time from a missing
supervisor pid or a heartbeat older than `staleMs` (default 45000 ms). `check` ends in
`completed` with result status `ready`.

## Deadline, signal, crash, tmux

Deadline: `--timeout SECONDS` (default 900) is a wall clock from launch. It also bounds the
prompt write and the wait for an answer. On expiry the supervisor aborts the RPC run, ends
stdin, sends SIGTERM to the worker's process group, then SIGKILL, and records `timeout`.

Signal: SIGINT, SIGTERM or SIGHUP to the supervisor asks the worker to abort, then kills the
process group, and records `stopped`. The worker runs in its own process group, so a supervisor
killed with SIGKILL cannot reap it; that worker keeps running with no supervisor.

Crash: a record whose supervisor is gone is displayed as `stale`; its socket is gone, so `steer`
and `stop` fail, and `rm` or `clean` forgets the record. A session lock (`<session file>.lock`)
owned by a dead pid is reclaimed by the next run.

tmux: every tmux call is optional and bounded by a 4 second timeout. With no tmux server,
`--window auto` runs the worker without a window and `--window always` exits 1. tmux older than
3.2 cannot pass environment into a new window, so `auto` also runs without one.

## Session file

A worker's session file is `<run-dir>/session.jsonl` by default. `--session FILE` continues an
existing file and must point at one. The lock file next to it prevents two supervisors from
writing one session.

## Not in the state directory

- the workspace (`--cwd`); the state directory never holds project files or copies of them
- a brief passed as `--prompt-file`; only briefs given to `orch_spawn` as text are copied into
  `briefs/<id>.md`
- run directories passed with `--run-dir` outside the state directory
- credentials; the worker inherits the caller's environment, minus the dispatching session's
  identity variables (`PI_SESSION_ID`, `PI_SESSION_FILE`, `PI_MODEL`, `PI_PROVIDER`,
  `PI_REASONING_LEVEL`, `PI_ORCH_WINDOW`)
