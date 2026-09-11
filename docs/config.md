# Configuration

## config.json

Read from `<state>/config.json` (state directory in architecture.md). Every field is optional
and unknown fields are ignored.

| Field | Type | Meaning |
|---|---|---|
| `profilesPath` | string | Path to the roster, tried after `--profiles` and `$PI_ORCH_PROFILES`. Use an absolute path. |
| `maxParallel` | number | Machine-wide cap on active workers. `run --max-parallel N` / `orch_spawn max_parallel` overrides it for one run. |
| `staleMs` | number | Heartbeat age that marks a non-terminal worker as stale in `list`, `dash` and `/agents`. Default 45000. |
| `shortcut` | string | Key that opens the `/agents` overlay. Default `ctrl+alt+a`. |
| `tmux.windows` | `"auto"` or `"always"` or `"never"` | Default window mode for `run` and `orch_spawn`. Other values are ignored. Default `never`. |

## profiles.json

The roster the spine enforces. A profile resolves to one provider, model and thinking level before anything is spawned.

| Key | Required | Meaning |
|---|---|---|
| `updated_on` | no | Date string, not used. |
| `profiles` | yes | Object of profile name to entry. |
| `profiles.<name>.provider` | yes | Provider id passed to `pi --provider`. |
| `profiles.<name>.model` | no | Model id used when `model_by_thinking` has no entry for the selected level. |
| `profiles.<name>.thinking` | yes | Default level when `--thinking` is omitted. |
| `profiles.<name>.allowed_thinking` | yes | List of levels the profile accepts. Any other level is rejected. |
| `profiles.<name>.model_by_thinking` | no | Object of level to model id. |
| `profiles.<name>.card` | no | Free-form pointer shown by `orch_profiles`. |
| `profiles.<name>.reasoning_policy` | no | Free-form string, not interpreted. |

The selected model is `model_by_thinking[level] ?? model`; a missing model is an error. The sample roster is in `test/profiles.json`.

## Environment variables

| Variable | Effect |
|---|---|
| `PI_ORCH_STATE_DIR` | State directory. `tmux-setup` prefixes its generated commands with this value. |
| `PI_ORCH_PROFILES` | Roster path, tried after `--profiles` and before `profilesPath`. |
| `PI_ORCH_PI` | `pi` executable used by `orch_spawn`; the CLI equivalent is `--pi PATH`. |
| `PI_ORCH_TMUX_SOCKET` | tmux socket name. Every tmux call runs with `-L <name>`. |
| `PI_ORCH_WINDOW_ENV` | Comma-separated names of extra variables to forward into a worker window or watch pane. |
| `PI_ORCH_WINDOW_START_TIMEOUT_MS` | Milliseconds `run --window` waits for the worker record before reporting failure. Default 20000. |
| `PI_ORCH_CLI` | Path to the CLI used by `orch_spawn`; defaults to the package's `bin/pi-orch.mjs`. |

## Before the first run

Create a roster and make it discoverable. `profiles.json` is searched in this order:

1. `--profiles FILE`
2. `$PI_ORCH_PROFILES`
3. `profilesPath` in `<state>/config.json`
4. `~/.agents/skills/multi-model-orchestration/profiles.json`
5. `~/.claude/skills/multi-model-orchestration/profiles.json`
6. `~/.pi/agent/skills/multi-model-orchestration/profiles.json`
7. `~/.codex/skills/multi-model-orchestration/profiles.json`

The state directory is created on demand. `config.json` is optional, and is only needed to point
both the CLI and the extension at a roster outside those paths. Nothing else has to exist before
the first run.
