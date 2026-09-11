/**
 * Read a run directory's `events.jsonl` back as a compact, human-readable
 * transcript. Shared by `pi-orch tail` and the dashboard's detail view.
 */

import * as fs from "node:fs";

export type ItemKind = "user" | "assistant" | "thinking" | "tool" | "error" | "system";

export interface TranscriptItem {
	kind: ItemKind;
	text: string;
	at?: string;
}

interface RpcLike {
	type?: string;
	message?: { role?: string; content?: unknown; stopReason?: string };
	assistantMessageEvent?: { type?: string; delta?: string; toolName?: string; toolCall?: { name?: string } };
	toolName?: string;
	args?: unknown;
	isError?: boolean;
	method?: string;
	title?: string;
	steer?: string;
	delta?: string;
	willRetry?: boolean;
}

function textOf(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (typeof part !== "object" || part === null) return "";
			const candidate = part as { type?: unknown; text?: unknown };
			return candidate.type === "text" && typeof candidate.text === "string" ? candidate.text : "";
		})
		.filter(Boolean)
		.join("\n");
}

function previewArgs(name: string, args: unknown): string {
	if (typeof args !== "object" || args === null) return name;
	const source = args as Record<string, unknown>;
	for (const key of ["command", "file_path", "path", "pattern", "query"]) {
		const value = source[key];
		if (typeof value === "string") return `${name} ${value.replace(/\s+/g, " ").slice(0, 160)}`;
	}
	return name;
}

/** Read at most `maxBytes` from the end of a file, dropping a partial first line. */
export function readTail(file: string, maxBytes: number): string {
	const stat = fs.statSync(file);
	const start = Math.max(0, stat.size - maxBytes);
	const length = stat.size - start;
	const handle = fs.openSync(file, "r");
	try {
		const buffer = Buffer.alloc(length);
		fs.readSync(handle, buffer, 0, length, start);
		const text = buffer.toString("utf8");
		const firstBreak = text.indexOf("\n");
		return start > 0 && firstBreak >= 0 ? text.slice(firstBreak + 1) : text;
	} finally {
		fs.closeSync(handle);
	}
}

export interface TranscriptOptions {
	maxBytes?: number;
	limit?: number;
}

export function readTranscript(runDir: string, options: TranscriptOptions = {}): TranscriptItem[] {
	const file = `${runDir}/events.jsonl`;
	let text: string;
	try {
		text = readTail(file, options.maxBytes ?? 512 * 1024);
	} catch {
		return [];
	}
	const items: TranscriptItem[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		let event: RpcLike;
		try {
			event = JSON.parse(line) as RpcLike;
		} catch {
			continue;
		}
		switch (event.type) {
			case "message_end": {
				const message = event.message;
				if (!message) break;
				const body = textOf(message.content);
				if (!body.trim()) break;
				if (message.role === "user") items.push({ kind: "user", text: body });
				else if (message.role === "assistant") items.push({ kind: "assistant", text: body });
				break;
			}
			case "tool_execution_start":
				items.push({ kind: "tool", text: previewArgs(String(event.toolName ?? "tool"), event.args) });
				break;
			case "tool_execution_end":
				if (event.isError === true) items.push({ kind: "error", text: `${String(event.toolName ?? "tool")} failed` });
				break;
			case "extension_ui_request": {
				if (["select", "confirm", "input", "editor"].includes(String(event.method))) {
					items.push({ kind: "system", text: `waiting for input: ${String(event.title ?? event.method)}` });
				}
				break;
			}
			case "auto_retry_start":
				items.push({ kind: "system", text: "provider retry" });
				break;
			case "compaction_start":
				items.push({ kind: "system", text: "compacting context" });
				break;
			default:
				break;
		}
	}
	const limit = options.limit ?? 200;
	return items.slice(-limit);
}

export function formatTranscript(items: TranscriptItem[]): string[] {
	const lines: string[] = [];
	for (const item of items) {
		const label =
			item.kind === "user"
				? "▌brief"
				: item.kind === "assistant"
					? "│"
					: item.kind === "thinking"
						? "· thinking"
						: item.kind === "tool"
							? "→"
							: item.kind === "error"
								? "✗"
								: "•";
		const body = item.text.split("\n");
		const head = `${label} ${body[0] ?? ""}`;
		lines.push(head);
		for (const extra of body.slice(1)) lines.push(`  ${extra}`);
	}
	return lines;
}
