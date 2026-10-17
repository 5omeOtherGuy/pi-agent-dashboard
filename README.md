# pi-agent-dashboard

`pi-agent-dashboard` runs Pi workers as detached, long-lived processes and lets a human watch
and steer them from any Pi session or from tmux. It has two parts: `pi-orch`, a CLI that
supervises one worker per process, and `/agents`, a Pi extension that reads the same state
directory. The supervisor owns the worker's `pi` process, its deadline and a control socket, so a
worker outlives the session that started it.

This is a personal project, published as-is. There is no support promise.

## Requirements

- Node.js >= 22.18; the CLI executes the TypeScript sources directly, with no build step
- the `pi` CLI on `PATH`
- `tmux` 3.2 or newer, optional; tmux is the intended way to watch workers
- `git`, used for the workspace revision and diffstat in acceptance evidence

## Install

Install from a checkout; the package is not published to npm yet. Two steps, run in the checkout:

```bash
pi install "$PWD"    # registers the /agents extension and the orch_* tools with Pi
npm link             # puts the pi-orch command on PATH
```

`pi install` only registers the Pi extension; it does not put `pi-orch` on `PATH`. `npm link`
links `bin/pi-orch.mjs` into npm's global bin directory, which a standard Node install puts on
`PATH`. A symlink into any other directory on `PATH` works the same way:

```bash
ln -s "$PWD/bin/pi-orch.mjs" ~/.local/bin/pi-orch
```

The bare `pi-orch` commands in this README's tables and in [docs/](docs/) assume this step; without
it, run `node bin/pi-orch.mjs` from the checkout instead.

## Quickstart

Commands below run `bin/pi-orch.mjs` from the checkout, so they work before the `PATH` step;
once `pi-orch` is linked, `pi-orch doctor` and `node bin/pi-orch.mjs doctor` are the same.

1. Install the package and link the CLI.
```bash
cd /path/to/pi-agent-dashboard
pi install "$PWD"
npm link
```

2. Print the toolchain, state directory and roster discovery result.
```bash
node bin/pi-orch.mjs doctor
```

3. Create a roster and point `config.json` at it; replace `provider` and `model` with values your Pi setup can run.
```bash
state=${PI_ORCH_STATE_DIR:-$HOME/.pi/agent/subagent-dashboard}
mkdir -p "$state"
printf '%s\n' '{ "profiles": { "demo": { "provider": "<provider-id>", "model": "<model-id>", "thinking": "high", "allowed_thinking": ["high"] } } }' > "$state/profiles.json"
printf '{"profilesPath":"%s/profiles.json"}\n' "$state" > "$state/config.json"
node bin/pi-orch.mjs profiles
```

4. Verify the profile without inference. `check` needs an existing workspace; `run` creates one.
```bash
mkdir -p /tmp/pi-orch-demo/work
node bin/pi-orch.mjs check demo --cwd /tmp/pi-orch-demo/work --run-dir /tmp/pi-orch-demo/probe-01
```

5. Start a worker detached and watch it. `run` prints the worker id; substitute it below.
```bash
node bin/pi-orch.mjs run demo --cwd /tmp/pi-orch-demo/work --run-dir /tmp/pi-orch-demo/run-01 --prompt "List the files in this directory and describe what they contain." --detach
node bin/pi-orch.mjs list
node bin/pi-orch.mjs watch w_1a2b3c4d --follow    # id printed by run
```

6. Install the tmux integration and open the dashboard from Pi.
```bash
node bin/pi-orch.mjs tmux-setup    # append to ~/.tmux.conf, then reload tmux
pi                                 # then type: /agents
```

## Commands

Exit code 0 is `ready` or `completed`, 1 is `failed`, `timeout` or `stopped`, 2 is a usage error.

| Command | What it does |
|---|---|
| `run <profile> --cwd DIR --run-dir DIR --prompt-file FILE` | Start one worker in a fresh run directory. |
| `check <profile> --cwd DIR --run-dir DIR` | Verify provider, model and thinking level against Pi, with no inference. |
| `list [--json] [--all]` / `status [<id>]` | Workers as one line each, or one full record; finished workers are hidden after 15 minutes idle unless `--all`. |
| `steer` / `follow-up` / `answer <id> …` | Queue a message for after the current tool calls, queue one for after the agent settles, or reply to a worker parked in `awaiting-input` (`--cancel` cancels). |
| `stop <id>` | Stop the worker and its process group; `abort` cancels the current run; `--close` closes its tmux window. |
| `tail <id> [--lines N]` | Formatted transcript, or raw `events.jsonl` lines with `logs`; last 40 by default. |
| `watch <id> [--follow]` | Live transcript; read-only, safe while the worker runs. |
| `dash [--watch]` / `statusline` | Standalone board for any terminal or tmux popup, or one status line for tmux `status-left` or `status-right`. |
| `windows [--json]` | tmux windows that carry a worker id, plus `focus <id>` and `pane <id>` to select or watch one. |
| `tmux-setup` | Print the tmux configuration: statusline, popup dashboard, bindings. |
| `profiles [--json]` / `doctor` | Show the roster `run` will accept, or print node, state directory, CLI pointer, profiles path, active workers and tmux. |
| `rm <id>` / `clean [--older-than SECONDS]` | Forget one finished record, or remove finished and abandoned ones by age; deletes the record and socket only, keeping run directories, logs and session files. |

## Pi extension

`pi install` registers the extension. It reads the same state directory as the CLI, so a worker
started by any session appears in every session.

| Tool | Use |
|---|---|
| `orch_spawn` | Start a supervised worker from a brief; wait for it, or detach. |
| `orch_status` | List workers, or read one record, transcript, steering audit trail or acceptance packet. |
| `orch_steer` | Send `steer`, `follow_up`, `abort`, `stop` or `answer` to a worker by id. |
| `orch_result` | Read a worker's final record, acceptance packet, transcript or engineering log. |
| `orch_profiles` | Show profile names, provider/model, allowed thinking levels and card paths. |

`/agents` opens the cross-session overlay. `/agents <id>` starts on one worker, `/agents text`
prints the list for non-TUI hosts, and `/agents clean` removes finished records older than an
hour. The shortcut defaults to `ctrl+alt+a` (config key `shortcut`), and a one-line widget above
the editor shows the active count and the lead worker's activity.

Keys: `↑`/`↓` select, `enter`/`←` detail or back, `s` steer, `f` follow-up, `y` answer, `a` abort,
`x` stop, `o` open session, `g` window, `w` watch pane, `t` transcript or brief, `c` clean, `d` forget, `r` refresh, `q` close.

## How it works

- `run` parses the brief and refuses to reuse a run directory.
- It starts one detached supervisor, which starts `pi --mode rpc` with the profile's provider, model and thinking level.
- The supervisor verifies that selection through `get_state` before inference and after the run settles.
- It writes `<state>/workers/<id>.json` on every state change and heartbeats it every 5 seconds.
- It listens on `<state>/workers/<id>.ctl.sock` for `status`, `steer`, `follow_up`, `abort`, `stop` and `answer`.
- The deadline is wall-clock, 900 seconds by default, enforced during prompt transport and while waiting for input.
- Dashboards read the state directory only; no process is attached to the session that started the worker.
- `--detach` returns immediately, `--window` hosts the supervisor in a tmux window, and both publish the same record.

## Development

```bash
npm ci
npm run check                                 # type check (tsc --noEmit)
npm test                                      # all tests (node --test)
node --test test/registry.test.ts             # one test file
node --test --test-name-pattern="stale" test/control.test.ts    # matching tests only
```

The tests drive the real CLI against `test/fake-pi.mjs`; they need no Pi install, credentials or
network. The tmux tests use an isolated tmux server and skip when tmux is missing.

## Docs

[architecture](docs/architecture.md) · [tmux](docs/tmux.md) · [config](docs/config.md) ·
[troubleshooting](docs/troubleshooting.md)
