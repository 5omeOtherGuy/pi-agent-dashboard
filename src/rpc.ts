/**
 * Minimal, strict JSONL client for `pi --mode rpc`.
 *
 * Framing rules that matter (see pi docs/rpc.md):
 *  - records are delimited by LF only; U+2028/U+2029 are valid inside JSON strings
 *    and must never split a record (so `readline` is not usable here),
 *  - a prompt is sent as one `prompt` command and may be larger than the pipe buffer,
 *    so writes are chunked and must respect the run deadline while the child is not
 *    reading,
 *  - `response` records correlate by `id`; everything else is an event.
 */

export class TimeoutError extends Error {}
export class RpcError extends Error {}

export interface RpcEvent {
	type?: string;
	id?: string;
	[key: string]: unknown;
}

interface Waiter {
	resolve: (event: RpcEvent) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
}

const CHUNK = 64 * 1024;

/** Write `text` to `stream`, waiting for drain when needed, aborting at `deadline`. */
export async function writeWithDeadline(
	stream: NodeJS.WritableStream,
	text: string,
	deadline: number,
	what = "transport",
): Promise<void> {
	const buffer = Buffer.from(text, "utf8");
	let offset = 0;
	while (offset < buffer.length) {
		if (Date.now() >= deadline) throw new TimeoutError(`Worker deadline reached during ${what}`);
		const chunk = buffer.subarray(offset, Math.min(offset + CHUNK, buffer.length));
		offset += chunk.length;
		if (!stream.write(chunk)) await drainOrDeadline(stream, deadline, what);
	}
}

function drainOrDeadline(stream: NodeJS.WritableStream, deadline: number, what: string): Promise<void> {
	const remaining = deadline - Date.now();
	if (remaining <= 0) return Promise.reject(new TimeoutError(`Worker deadline reached during ${what}`));
	return new Promise<void>((resolve, reject) => {
		const done = (): void => {
			clearTimeout(timer);
			stream.off("drain", onDrain);
			stream.off("error", onError);
			stream.off("close", onClose);
		};
		const timer = setTimeout(() => {
			done();
			reject(new TimeoutError(`Worker deadline reached during ${what}`));
		}, remaining);
		const onDrain = (): void => {
			done();
			resolve();
		};
		const onError = (error: Error): void => {
			done();
			reject(error);
		};
		const onClose = (): void => {
			done();
			reject(new RpcError("Worker transport closed while sending"));
		};
		stream.once("drain", onDrain);
		stream.once("error", onError);
		stream.once("close", onClose);
	});
}

export interface RpcOptions {
	deadline: number;
	/** Called for every event as soon as it is parsed, before anyone consumes it. */
	onEvent?: (event: RpcEvent) => void;
	/** Sink for the raw event stream (the run's events.jsonl). */
	sink?: (line: string) => void;
}

export class RpcClient {
	private readonly stream: NodeJS.ReadableStream;
	private readonly writable: NodeJS.WritableStream;
	private readonly options: RpcOptions;
	private readonly queue: RpcEvent[] = [];
	private readonly waiters: Waiter[] = [];
	private readonly pending = new Map<string, { resolve: (event: RpcEvent) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
	private failure?: Error;
	private closed = false;
	private serial = 0;
	private buffer = "";

	constructor(readable: NodeJS.ReadableStream, writable: NodeJS.WritableStream, options: RpcOptions) {
		this.stream = readable;
		this.writable = writable;
		this.options = options;
		this.stream.setEncoding?.("utf8");
		this.stream.on("data", (chunk: string) => this.ingest(chunk));
		this.stream.on("error", (error: Error) => this.fail(error));
		this.stream.on("close", () => this.fail(new RpcError("Pi stdout closed")));
		// A write can fail asynchronously (for example EPIPE after the child exits).
		// Without this listener Node raises an unhandled 'error' event and kills the supervisor.
		this.writable.on("error", (error: Error) => this.fail(error instanceof Error ? error : new Error(String(error))));
	}

	private ingest(chunk: string): void {
		this.buffer += chunk;
		let index = this.buffer.indexOf("\n");
		while (index >= 0) {
			const raw = this.buffer.slice(0, index);
			this.buffer = this.buffer.slice(index + 1);
			index = this.buffer.indexOf("\n");
			const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
			if (line.trim() === "") continue;
			this.options.sink?.(`${line}\n`);
			let event: RpcEvent;
			try {
				event = JSON.parse(line) as RpcEvent;
			} catch (error) {
				this.fail(new RpcError(`Unparsable event from worker: ${(error as Error).message}`));
				return;
			}
			try {
				this.options.onEvent?.(event);
			} catch (error) {
				this.fail(error instanceof Error ? error : new Error(String(error)));
				return;
			}
			// A response is only interesting to the request that asked for it. Routing it here
			// keeps `next()` free for event consumers and lets a control command wait for its
			// own response while the run's event loop keeps reading.
			if (event.type === "response" && typeof event.id === "string") {
				const pending = this.pending.get(event.id);
				if (pending) {
					this.pending.delete(event.id);
					clearTimeout(pending.timer);
					if (event.success === true) pending.resolve(event);
					else pending.reject(new RpcError(`Pi rejected ${String(event.command ?? "command")}: ${String(event.error ?? "unknown error")}`));
					continue;
				}
			}
			const waiter = this.waiters.shift();
			if (waiter) {
				clearTimeout(waiter.timer);
				waiter.resolve(event);
			} else {
				this.queue.push(event);
			}
		}
	}

	private fail(error: Error): void {
		if (this.closed) return;
		this.closed = true;
		this.failure = error;
		for (const waiter of this.waiters.splice(0)) {
			clearTimeout(waiter.timer);
			waiter.reject(error);
		}
		for (const [, pending] of this.pending) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.pending.clear();
	}

	/** Mark the transport as intentionally finished so late close events are ignored. */
	dispose(): void {
		this.closed = true;
		for (const waiter of this.waiters.splice(0)) {
			clearTimeout(waiter.timer);
			waiter.reject(new RpcError("RPC client disposed"));
		}
		for (const [, pending] of this.pending) {
			clearTimeout(pending.timer);
			pending.reject(new RpcError("RPC client disposed"));
		}
		this.pending.clear();
	}

	/** Send one command. Returns its correlation id. */
	async send(command: string, fields: Record<string, unknown> = {}, deadline = this.options.deadline): Promise<string> {
		if (this.failure) throw this.failure;
		this.serial += 1;
		const id = String(this.serial);
		const payload = `${JSON.stringify({ id, type: command, ...fields })}\n`;
		await writeWithDeadline(this.writable, payload, deadline, `${command} command`);
		return id;
	}

	/** Wait for the next unconsumed event. */
	next(deadline = this.options.deadline): Promise<RpcEvent> {
		const queued = this.queue.shift();
		if (queued) return Promise.resolve(queued);
		if (this.failure) return Promise.reject(this.failure);
		const remaining = deadline - Date.now();
		if (remaining <= 0) return Promise.reject(new TimeoutError("Worker deadline reached"));
		return new Promise<RpcEvent>((resolve, reject) => {
			const waiter: Waiter = {
				resolve,
				reject,
				timer: setTimeout(() => {
					const index = this.waiters.indexOf(waiter);
					if (index >= 0) this.waiters.splice(index, 1);
					reject(new TimeoutError("Worker deadline reached"));
				}, remaining),
			};
			this.waiters.push(waiter);
		});
	}

	/** Send a command and resolve with its response, leaving unrelated events for `next()`. */
	async request<T = Record<string, unknown>>(command: string, fields: Record<string, unknown> = {}, deadline = this.options.deadline): Promise<T> {
		const id = await this.send(command, fields, deadline);
		return new Promise<T>((resolve, reject) => {
			const remaining = deadline - Date.now();
			if (remaining <= 0) {
				reject(new TimeoutError(`Worker deadline reached waiting for ${command}`));
				return;
			}
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new TimeoutError(`Worker deadline reached waiting for ${command}`));
			}, remaining);
			this.pending.set(id, {
				resolve: (event) => resolve((event.data ?? {}) as T),
				reject,
				timer,
			});
		});
	}
}

export interface RpcState {
	model?: { id?: string; provider?: string } | null;
	thinkingLevel?: string;
	isStreaming?: boolean;
	isCompacting?: boolean;
	pendingMessageCount?: number;
	sessionFile?: string;
	sessionId?: string;
	messageCount?: number;
}

export interface Selection {
	provider: string;
	model: string;
	thinking: string;
}

export interface Observed {
	provider?: string;
	model?: string;
	thinking?: string;
}

/** Compare the state Pi reports with the selection we asked for. */
export function verifySelection(state: RpcState, selected: Selection, what: string): void {
	const observed: Observed = {
		provider: state.model?.provider,
		model: state.model?.id,
		thinking: state.thinkingLevel,
	};
	if (observed.provider !== selected.provider || observed.model !== selected.model || observed.thinking !== selected.thinking) {
		throw new RpcError(
			`Pi selection mismatch ${what}: expected ${JSON.stringify(selected)}, observed ${JSON.stringify(observed)}`,
		);
	}
	if (state.isStreaming || state.isCompacting || (state.pendingMessageCount ?? 0) > 0) {
		throw new RpcError("Selected session is not idle");
	}
}
