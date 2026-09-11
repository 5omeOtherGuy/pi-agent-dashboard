/**
 * Atomic admission control.
 *
 * `preflight()` can only read the registry, so two supervisors starting in the same instant
 * both see a free machine and both take the last slot. Admission closes that window by
 * *reserving* before the run starts.
 *
 * The check-and-reserve section runs under one short-lived gate lock, taken with the same
 * primitive as the session lock (`fs.openSync(path, "wx")` plus a `pidAlive` check on the
 * owner), so the decision is serialized across processes without limiting how many runs may
 * be admitted. The reservation is the artifact that outlives the call: it lives in
 * `<state>/admissions/` (0700), names its owner, counts as an active worker while that pid
 * is alive, and the supervisor removes it in `finally` on every exit path. A supervisor
 * killed without cleanup strands nothing: the next admission ignores and sweeps a
 * reservation whose owner is gone.
 */

import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { listRecords, ensureStateDirs, nowIso, pidAlive, stateDir } from "./registry.ts";
import type { ToolSet, WorkerRecord } from "./protocol.ts";

/**
 * The gate is held only for the read-check-reserve section. Waiting longer than this means
 * the owner is stuck rather than slow, and the operator should see that instead of hanging.
 */
const GATE_WAIT_MS = 10_000;
const GATE_POLL_MS = 10;
const GATE_NAME = "gate.lock";

/** The constraints an admission is decided against, without taking anything. */
export interface AdmissionQuery {
	cwd: string;
	tools: ToolSet;
	/** Machine-wide cap over live workers plus live reservations; undefined means no cap. */
	maxParallel?: number;
	allowSharedCwd?: boolean;
	env?: NodeJS.ProcessEnv;
}

export interface AdmissionOptions extends AdmissionQuery {
	/** Worker id. A reservation and the record it later publishes are one run, counted once. */
	id: string;
}

export interface Admission {
	/** Reservation file, exposed for diagnostics. */
	path: string;
	/** Idempotent: releasing an already-released reservation is fine. */
	release(): void;
}

export function admissionsDir(env: NodeJS.ProcessEnv = process.env): string {
	return path.join(stateDir(env), "admissions");
}

/**
 * Live workers: what the machine-wide cap and the writer rule count. Read inside the gate
 * by `acquireAdmission`; `preflight` uses the same function for its fast fail.
 */
export function activeWorkers(env: NodeJS.ProcessEnv = process.env): WorkerRecord[] {
	return listRecords(env)
		.filter(({ record, stale }) => !stale && ["starting", "running", "awaiting-input"].includes(record.state))
		.map(({ record }) => record);
}

interface Reservation {
	file: string;
	id: string;
	cwd: string;
	tools: string;
	alive: boolean;
}

/**
 * Read one reservation file. A file that cannot be parsed counts as dead so the next
 * admission sweeps it; it cannot be a reservation mid-creation, because the name only
 * appears once its content is complete.
 */
function readReservation(file: string): Reservation {
	const reservation: Reservation = { file, id: "", cwd: "", tools: "", alive: false };
	let raw: unknown;
	try {
		raw = JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return reservation;
	}
	if (typeof raw !== "object" || raw === null) return reservation;
	const source = raw as Record<string, unknown>;
	if (typeof source.id === "string") reservation.id = source.id;
	if (typeof source.cwd === "string") reservation.cwd = source.cwd;
	if (typeof source.tools === "string") reservation.tools = source.tools;
	reservation.alive = pidAlive(typeof source.pid === "number" ? source.pid : undefined);
	return reservation;
}

function readReservations(env: NodeJS.ProcessEnv): Reservation[] {
	let names: string[];
	try {
		names = fs.readdirSync(admissionsDir(env));
	} catch {
		return [];
	}
	const reservations: Reservation[] = [];
	for (const name of names) {
		if (!name.endsWith(".lock") || name === GATE_NAME) continue;
		reservations.push(readReservation(path.join(admissionsDir(env), name)));
	}
	return reservations;
}

/**
 * Why this run may not start, in the operator's words, or undefined when it may.
 *
 * Read-only, so `preflight()` can use it for the fast fail every entry point already relies
 * on. `acquireAdmission()` re-runs it while holding the gate, where the answer is
 * authoritative rather than a snapshot.
 */
export function admissionRefusal(query: AdmissionQuery): string | undefined {
	const active = activeWorkers(query.env);
	const reservations = readReservations(query.env ?? process.env).filter((reservation) => reservation.alive);
	// A reservation and the record it later publishes describe one run; count each id once.
	const workers = new Set(active.map((record) => record.id));
	for (const reservation of reservations) if (reservation.id) workers.add(reservation.id);
	if (query.maxParallel && workers.size >= query.maxParallel) {
		return `Refusing to start: ${workers.size} workers already active (max ${query.maxParallel})`;
	}
	if (query.tools === "write" && !query.allowSharedCwd) {
		const writer =
			active.find((record) => record.worker.tools === "write" && record.worker.cwd === query.cwd) ??
			reservations.find((reservation) => reservation.tools === "write" && reservation.cwd === query.cwd);
		if (writer) {
			return `Refusing to start: writer ${writer.id || "(unknown)"} already owns ${query.cwd}. Isolate the workspace or pass --allow-shared-cwd.`;
		}
	}
	return undefined;
}

/** Check the rules and take a reservation atomically; throws the user-facing refusal. */
export function acquireAdmission(options: AdmissionOptions): Admission {
	const env = options.env ?? process.env;
	ensureStateDirs(env);
	const dir = admissionsDir(env);
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	try {
		fs.chmodSync(dir, 0o700);
	} catch {
		// Best effort, as in ensureStateDirs: the directory may be on a filesystem without modes.
	}
	const releaseGate = acquireGate(env);
	try {
		// Owned by this process: no other process can be creating a reservation, so anything
		// whose owner is gone is abandoned and can be swept before the count is read.
		for (const reservation of readReservations(env)) {
			if (!reservation.alive) fs.rmSync(reservation.file, { force: true });
		}
		const refusal = admissionRefusal(options);
		if (refusal) throw new Error(refusal);
		return reserve(dir, options);
	} finally {
		releaseGate();
	}
}

function reserve(dir: string, options: AdmissionOptions): Admission {
	// The token keeps two reservations for one cwd apart (and a stale file cannot be
	// mistaken for this run's); the id ties the reservation to its future record.
	for (let attempt = 0; attempt < 3; attempt++) {
		const file = path.join(dir, `${options.id}.${randomBytes(4).toString("hex")}.lock`);
		try {
			createExclusive(file, `${JSON.stringify({ pid: process.pid, id: options.id, cwd: options.cwd, tools: options.tools, at: nowIso() })}\n`);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
			throw error;
		}
		return { path: file, release: () => fs.rmSync(file, { force: true }) };
	}
	throw new Error(`Could not reserve an admission slot for ${options.id} in ${dir}`);
}

/**
 * Create `file` with `contents`, failing with `EEXIST` when it already exists. The content
 * is written to a private temp file and linked into place, so the name never appears with
 * a partial payload - a reader can always trust what it finds there. (Hard links are the
 * primitive; the state directory is a local filesystem directory, like the session lock.)
 */
function createExclusive(file: string, contents: string): void {
	const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
	fs.writeFileSync(tmp, contents, { mode: 0o600 });
	try {
		fs.linkSync(tmp, file);
	} finally {
		fs.rmSync(tmp, { force: true });
	}
}

/**
 * Serialize the read-check-reserve section. The gate is the session lock's primitive again:
 * a live owner makes the caller wait, a dead owner is reclaimed, and a holder that stays
 * stuck past the wait is reported instead of silently breaking admission.
 */
function acquireGate(env: NodeJS.ProcessEnv): () => void {
	const file = path.join(admissionsDir(env), GATE_NAME);
	const deadline = Date.now() + GATE_WAIT_MS;
	const sleeper = new Int32Array(new SharedArrayBuffer(4));
	for (;;) {
		try {
			createExclusive(file, `${JSON.stringify({ pid: process.pid, at: nowIso() })}\n`);
			return () => fs.rmSync(file, { force: true });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			const owner = readGateOwner(file);
			if (!owner) {
				fs.rmSync(file, { force: true });
				continue;
			}
			if (Date.now() >= deadline) {
				throw new Error(`Admission lock is held by pid ${owner} and was not released within ${GATE_WAIT_MS / 1000}s: ${file}`);
			}
			Atomics.wait(sleeper, 0, 0, GATE_POLL_MS);
		}
	}
}

/** The pid holding the gate, or undefined when the file is gone or names no live process. */
function readGateOwner(file: string): number | undefined {
	let raw: unknown;
	try {
		raw = JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return undefined;
	}
	const pid = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>).pid : undefined;
	if (typeof pid !== "number") return undefined;
	return pidAlive(pid) ? pid : undefined;
}
