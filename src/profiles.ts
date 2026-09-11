/**
 * Profile selection. The orchestration skill owns the roster (`profiles.json`);
 * this module only enforces it, so an invalid combination can never reach a model.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readConfig } from "./config.ts";

export interface ProfileEntry {
	provider: string;
	model?: string;
	thinking: string;
	allowed_thinking: string[];
	model_by_thinking?: Record<string, string>;
	card?: string;
	reasoning_policy?: string;
}

export interface ProfilesFile {
	updated_on?: string;
	profiles: Record<string, ProfileEntry>;
}

export interface Selection {
	profile: string;
	provider: string;
	model: string;
	thinking: string;
}

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** Candidate locations, in priority order, for the skill's roster. */
export function profilesCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
	const home = os.homedir();
	const candidates: string[] = [];
	const configured = readConfig(env).profilesPath;
	if (configured) candidates.push(configured);
	candidates.push(
		path.join(home, ".agents", "skills", "multi-model-orchestration", "profiles.json"),
		path.join(home, ".claude", "skills", "multi-model-orchestration", "profiles.json"),
		path.join(home, ".pi", "agent", "skills", "multi-model-orchestration", "profiles.json"),
		path.join(home, ".codex", "skills", "multi-model-orchestration", "profiles.json"),
	);
	return candidates;
}

export function resolveProfilesPath(explicit?: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
	if (explicit) return path.resolve(explicit);
	if (env.PI_ORCH_PROFILES) return path.resolve(env.PI_ORCH_PROFILES);
	return profilesCandidates(env).find((candidate) => fs.existsSync(candidate));
}

export function loadProfiles(file: string): ProfilesFile {
	let raw: unknown;
	try {
		raw = JSON.parse(fs.readFileSync(file, "utf8"));
	} catch (error) {
		throw new Error(`Cannot read profiles file ${file}: ${(error as Error).message}`);
	}
	if (typeof raw !== "object" || raw === null || typeof (raw as { profiles?: unknown }).profiles !== "object") {
		throw new Error(`Profiles file ${file} has no "profiles" object`);
	}
	const profiles = (raw as { profiles: Record<string, unknown> }).profiles;
	const parsed: Record<string, ProfileEntry> = {};
	for (const [name, value] of Object.entries(profiles)) {
		if (typeof value !== "object" || value === null) throw new Error(`Profile ${name} is not an object`);
		const entry = value as Record<string, unknown>;
		if (typeof entry.provider !== "string" || !entry.provider) throw new Error(`Profile ${name} has no provider`);
		if (typeof entry.thinking !== "string" || !entry.thinking) throw new Error(`Profile ${name} has no thinking`);
		if (!Array.isArray(entry.allowed_thinking) || entry.allowed_thinking.some((level) => typeof level !== "string")) {
			throw new Error(`Profile ${name} has no allowed_thinking list`);
		}
		if (entry.model !== undefined && typeof entry.model !== "string") throw new Error(`Profile ${name} model must be a string`);
		const mapped: Record<string, string> = {};
		if (entry.model_by_thinking !== undefined) {
			if (typeof entry.model_by_thinking !== "object" || entry.model_by_thinking === null) {
				throw new Error(`Profile ${name} model_by_thinking must be an object`);
			}
			for (const [level, model] of Object.entries(entry.model_by_thinking as Record<string, unknown>)) {
				if (typeof model !== "string") throw new Error(`Profile ${name} model_by_thinking.${level} must be a string`);
				mapped[level] = model;
			}
		}
		parsed[name] = {
			provider: entry.provider,
			model: entry.model as string | undefined,
			thinking: entry.thinking,
			allowed_thinking: entry.allowed_thinking as string[],
			model_by_thinking: Object.keys(mapped).length > 0 ? mapped : undefined,
			card: typeof entry.card === "string" ? entry.card : undefined,
			reasoning_policy: typeof entry.reasoning_policy === "string" ? entry.reasoning_policy : undefined,
		};
	}
	return { updated_on: typeof (raw as { updated_on?: unknown }).updated_on === "string" ? ((raw as { updated_on: string }).updated_on) : undefined, profiles: parsed };
}

export function profileNames(profiles: ProfilesFile): string[] {
	return Object.keys(profiles.profiles);
}

/**
 * Resolve a profile + optional thinking level into the exact Pi selection.
 * Throws on unknown profiles, disallowed levels, and profiles without a model.
 */
export function selectProfile(profiles: ProfilesFile, profile: string, thinking?: string): Selection {
	const entry = profiles.profiles[profile];
	if (!entry) {
		const known = profileNames(profiles);
		const suggestion = known.find((name) => name.startsWith(profile) || profile.startsWith(name));
		throw new Error(
			`Unknown profile "${profile}". Known profiles: ${known.join(", ")}${suggestion ? ` (did you mean "${suggestion}"?)` : ""}`,
		);
	}
	const level = thinking ?? entry.thinking;
	if (!entry.allowed_thinking.includes(level)) {
		throw new Error(
			`Thinking level "${level}" is not allowed for ${profile}; allowed: ${entry.allowed_thinking.join(", ")}`,
		);
	}
	const model = entry.model_by_thinking?.[level] ?? entry.model;
	if (!model) throw new Error(`Profile ${profile} has no model for thinking level "${level}"`);
	return { profile, provider: entry.provider, model, thinking: level };
}
