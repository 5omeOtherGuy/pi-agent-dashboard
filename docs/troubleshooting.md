# Troubleshooting

The commands below assume `pi-orch` is on `PATH` (see [Install](../README.md#install)); from a
checkout without that step, run `node bin/pi-orch.mjs` instead.

## "no worker record matches <id>"

The record was removed, or this shell uses a different state directory; finished records are
hidden from `list` after 15 minutes idle.

    pi-orch list --all

`--all` includes finished workers; if the id is absent there too, `pi-orch doctor` shows the state directory in use.

## A worker parks on a question

The record shows `awaiting-input` with `WAITING <method>: <question>`. The extension spawns with
`--input park`; a CLI run needs the same flag, because the default `--input fail` fails the run.

    pi-orch status <id>

Reply with `pi-orch answer <id> <value>`, or `--cancel`. In the `/agents` overlay, `y` answers
the selected worker.

## A worker window does not open

Window mode needs tmux 3.2 or newer and is opt-in. `--window auto` runs the worker without a
window when tmux is missing or too old, and `--window always` exits 1 in that case. A
`tmux.windows` value of `never` disables windows everywhere.

    pi-orch doctor

`doctor` prints whether tmux is reachable, its version, and the worker window count.

## A variable is missing inside a worker window

A new tmux window inherits the tmux server environment, not the environment of the process that
opened it. The spine forwards `PI_*`, a fixed list of standard variables, and names in
`PI_ORCH_WINDOW_ENV`.

    tmux show-environment -g

If it is missing there, add the name to `PI_ORCH_WINDOW_ENV` in the supervisor's environment and
start the worker again.

## A record is stale after a reboot

The supervisor pid no longer exists, so the record is shown as `stale` and its socket is gone; `steer` and `stop` fail, and the record can be removed.

    pi-orch list

Clear abandoned records with `pi-orch clean --older-than 0`, or one record with
`pi-orch rm <id>`. A plain `pi-orch clean` waits an hour.

## Seeing a finished worker

`list` hides terminal records after 15 minutes idle; the run directory stays on disk.

    pi-orch list --all

In a Pi session, `orch_result` with `id` and `view: "acceptance"` prints the definition-of-done
rows, the engineering-log verdict, the git revision and diffstat, usage and the final response;
`/agents <id>` opens the record in the overlay.
