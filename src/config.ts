/**
 * Optional user config: `<state>/config.json`.
 *
 * Every field is optional; absence means "discover it". This file is the only
 * place that pins machine-specific paths, so the CLI and the extension never
 * need to agree on a search order at call time.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { atomicWriteFile, ensureStateDirs, stateDir } from "./registry.ts";

export interface TmuxConfig {
	/**
	 * "auto" opens a worker window when a worker is spawned by an operator who is already
	 * inside tmux, "always" fails when no tmux server is reachable, "never" disables windows.
	 * Windows are always opt-in: a shell run stays in the foreground unless this is set.
	 */
	windows?: "auto" | "always" | "never";
}

export interface OrchConfig {
	/** tmux integration; tmux is always optional. */
	tmux?: TmuxConfig;
	/** Absolute path to the orchestration skill's profiles.json. */
	profilesPath?: string;
	/** Refuse to start a worker when this many are active. */
	maxParallel?: number;
	/** Record heartbeat age that marks an abandoned worker. */
	staleMs?: number;
	/** TUI shortcut that opens the dashboard. */
	shortcut?: string;
}

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
	return path.join(stateDir(env), "config.json");
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): OrchConfig {
	let raw: unknown;
	try {
		raw = JSON.parse(fs.readFileSync(configPath(env), "utf8"));
	} catch {
		return {};
	}
	if (typeof raw !== "object" || raw === null) return {};
	const source = raw as Record<string, unknown>;
	const config: OrchConfig = {};
	if (typeof source.profilesPath === "string") config.profilesPath = source.profilesPath;
	if (typeof source.maxParallel === "number") config.maxParallel = source.maxParallel;
	if (typeof source.staleMs === "number") config.staleMs = source.staleMs;
	if (typeof source.shortcut === "string") config.shortcut = source.shortcut;
	if (typeof source.tmux === "object" && source.tmux !== null) {
		const tmuxSource = source.tmux as Record<string, unknown>;
		const tmuxConfig: TmuxConfig = {};
		if (tmuxSource.windows === "auto" || tmuxSource.windows === "always" || tmuxSource.windows === "never") {
			tmuxConfig.windows = tmuxSource.windows;
		}
		config.tmux = tmuxConfig;
	}
	return config;
}


