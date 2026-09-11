# tmux

tmux is optional for running and steering workers, and the intended way to watch them: one key
for the board, one for a watch pane, one to jump to a worker's window.

## Setup

`pi-orch tmux-setup` prints the configuration below; append it to `~/.tmux.conf` once, then run
`tmux source-file ~/.tmux.conf`. The output substitutes the CLI path recorded in `<state>/cli`
for `pi-orch` and prefixes `PI_ORCH_STATE_DIR=…` when that variable is set.

    # pi-orch tmux configuration — append to ~/.tmux.conf, then: tmux source-file ~/.tmux.conf

    # 1. Live worker count and activity in the status bar
    set -g status-interval 3
    set -g status-right '#(pi-orch statusline)  %H:%M '

    # 2. The dashboard as a popup, with no Pi session running
    bind-key a display-popup -E -w 90% -h 70% -T ' pi-orch ' 'pi-orch dash --watch'

    # 3. Jump to a worker window by id (prefix + j)
    bind-key j command-prompt -p 'worker id:' "run-shell \"pi-orch focus '%1'\""

    # 4. Live watch pane for the worker this window belongs to (prefix + w)
    bind-key w "run-shell \"pi-orch pane '#{@pi_worker_id}'\""

    # 5. Steer this window's worker (prefix + s; queues after its current tool calls)
    bind-key s command-prompt -p 'steer:' "run-shell \"pi-orch steer '#{@pi_worker_id}' '%1'\""

    # 6. Answer this window's worker when it asks a question (prefix + y)
    bind-key y command-prompt -p 'answer:' "run-shell \"pi-orch answer '#{@pi_worker_id}' '%1'\""

    # 7. Worker windows are named by the spine; stop tmux renaming them
    set -g allow-rename off

    # Notes: bindings expand #{@pi_worker_id} from the current window (run-shell has no TMUX_PANE),
    # a watch pane labels its window so these bindings act on the worker you are watching, and
    # worker windows are opt-in (config tmux.windows or --window). A pane running a watcher has no
    # shell, so use the bindings rather than typing into it.

## Statusline

`pi-orch statusline` prints one line from the registry: `⚙2 ◍1 demo read src/auth.ts` is two
active workers, one awaiting input, then the lead worker's profile and tool. With none active it
prints `⚙ idle N` for N finished records, or `⚙ none`.

## Popup dashboard

`prefix + a` opens `pi-orch dash --watch` in a `display-popup`, so the board works with no Pi
session running. `dash` prints one frame and exits; `--watch` redraws until interrupted, and
`--interval SECONDS` sets the period (default 2, minimum 1).

## Watch pane

`pi-orch pane <id>` splits the current window and runs `pi-orch watch <id> --follow` in the new
pane; `--new-window`, `--size N` and `--horizontal` change where it opens. The watcher labels its
window with the watched worker id, so `prefix + s` and `prefix + y` act on that worker.

## Window per worker

`pi-orch run … --window auto` gives a worker its own tmux window. `auto` opens the window when a
tmux server is reachable, `always` fails when no window can be opened, and `never` disables
windows. The default `never` comes from `tmux.windows` in `config.json`, or from `--window`.

The window is named `<id> <profile>`, for example `w_3f9c2a71 demo`, and keeps that name for the
whole run. `pi-orch windows` lists worker windows, `pi-orch focus <id>` selects one, and
`stop <id> --close` closes one.

## Caveats

- A new window inherits the tmux server environment, not the environment of the process that
  opened it. The spine forwards `PATH`, `HOME`, `SHELL`, `TMPDIR`, `LANG`, `LC_ALL`, `USER`,
  `TERM`, `PI_CODING_AGENT_DIR`, the proxy variables, `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`,
  `SSL_CERT_DIR` and every `PI_*` variable. Any other name must be listed in
  `PI_ORCH_WINDOW_ENV`, comma-separated.
- A pane running a watcher has no shell, so use the bindings or another pane for commands.
- Renaming a window breaks `tmux send-keys -t <name>` and binding targets, so names are stable;
  state lives in the `@pi_orch_state` window option and the worker id in `@pi_worker_id`.
- `run-shell` runs with no `TMUX_PANE`, so the generated bindings expand `#{@pi_worker_id}` from
  the current window instead of discovering it like a `--current` call does.
