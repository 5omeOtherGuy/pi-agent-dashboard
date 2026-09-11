/**
 * Brief parsing and engineering-log checking.
 *
 * The orchestration skill already prescribes a definition-of-done table and five
 * engineering-log headings. This module reads that prose shape mechanically so the
 * supervisor can refuse an assignment without a testable definition of done and can
 * report at handoff whether the log was actually filled in.
 *
 * It validates structure only, never content quality.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { LogCheck } from "./protocol.ts";

export interface DodRow {
	criterion: string;
	verification: string;
	owner: string;
	result: string;
}

export interface ParsedBrief {
	outcome?: string;
	dod: DodRow[];
	hasDodTable: boolean;
	logPath?: string;
}

export const LOG_HEADINGS = [
	"Actions Taken",
	"Issues & Friction",
	"Decisions & Rationale",
	"Solutions Applied",
	"Insights",
] as const;

const PLACEHOLDER = /_pending_|_none yet_|\bTODO\b|\[\.\.\.\]/i;

function cells(line: string): string[] {
	return line
		.trim()
		.replace(/^\|/, "")
		.replace(/\|$/, "")
		.split("|")
		.map((cell) => cell.trim());
}

function isSeparator(line: string): boolean {
	const parts = cells(line);
	return parts.length > 0 && parts.every((part) => /^:?-{2,}:?$/.test(part.replace(/\s/g, "")));
}

function stripMarkdown(value: string): string {
	return value.replace(/`/g, "").replace(/^\*\*|\*\*$/g, "").trim();
}

/** Parse a GitHub-style markdown table whose first column is an observable criterion. */
function parseDodTable(lines: string[]): DodRow[] {
	const rows: DodRow[] = [];
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index];
		if (!line || !line.trim().startsWith("|")) continue;
		const header = cells(line).map((cell) => cell.toLowerCase());
		const next = lines[index + 1];
		if (!next || !isSeparator(next)) continue;
		const ownerColumn = header.findIndex((cell) => cell.startsWith("owner"));
		const criterionColumn = 0;
		let cursor = index + 2;
		while (cursor < lines.length) {
			const row = lines[cursor];
			if (!row || !row.trim().startsWith("|")) break;
			if (isSeparator(row)) {
				cursor++;
				continue;
			}
			const parsed = cells(row).map(stripMarkdown);
			const criterion = parsed[criterionColumn] ?? "";
			if (criterion && !PLACEHOLDER.test(criterion)) {
				rows.push({
					criterion,
					verification: stripMarkdown(parsed[1] ?? ""),
					owner: stripMarkdown(ownerColumn >= 0 ? (parsed[ownerColumn] ?? "") : ""),
					result: stripMarkdown(parsed[ownerColumn >= 0 ? ownerColumn + 1 : 3] ?? ""),
				});
			}
			cursor++;
		}
		index = cursor - 1;
	}
	return rows;
}

function labelled(text: string, labels: string[]): string | undefined {
	const pattern = new RegExp(`^\\s*(?:[-*]\\s*)?(?:#+\\s*)?(?:\\*\\*)?(${labels.join("|")})(?:\\*\\*)?\\s*:\\s*(.+)$`, "im");
	const match = pattern.exec(text);
	const value = match?.[2]?.trim();
	return value ? value : undefined;
}

export function parseBrief(text: string): ParsedBrief {
	const lines = text.split("\n");
	const dod = parseDodTable(lines);
	const parsed: ParsedBrief = { dod, hasDodTable: dod.length > 0 };
	const outcome = labelled(text, ["outcome", "objective", "goal", "task"]);
	if (outcome) {
		parsed.outcome = outcome.slice(0, 300);
	} else {
		const first = lines.find((line) => line.trim().length > 0);
		if (first) parsed.outcome = first.replace(/^#+\s*/, "").slice(0, 300);
	}
	const logPath = labelled(text, ["engineering log", "log path", "log"]);
	if (logPath && !/[|]/.test(logPath)) parsed.logPath = logPath.slice(0, 400);
	return parsed;
}

export interface BriefValidation {
	errors: string[];
	warnings: string[];
}

export function validateBrief(parsed: ParsedBrief, options: { requireDod: boolean; minLength: number }, text: string): BriefValidation {
	const errors: string[] = [];
	const warnings: string[] = [];
	if (text.trim().length < options.minLength) {
		errors.push(`brief is shorter than ${options.minLength} characters (${text.trim().length})`);
	}
	if (options.requireDod) {
		if (!parsed.hasDodTable) {
			errors.push("brief has no definition-of-done table (markdown table with a criterion, verification method, owner and result column)");
		} else {
			for (const [index, row] of parsed.dod.entries()) {
				if (!row.verification) errors.push(`definition-of-done row ${index + 1} ("${row.criterion}") has no verification method`);
				if (!row.owner) errors.push(`definition-of-done row ${index + 1} ("${row.criterion}") has no owner`);
				else if (!/\b(worker|lead|astra|reviewer)\b/i.test(row.owner) && !row.owner.includes("?")) {
					warnings.push(`definition-of-done row ${index + 1} owner "${row.owner}" is neither worker nor lead`);
				}
			}
		}
	}
	if (!parsed.outcome) warnings.push("brief declares no outcome");
	return { errors, warnings };
}

export interface BriefDigest {
	bytes: number;
	sha256: string;
	excerpt: string;
}

export function digestBrief(text: string, excerptChars = 600): BriefDigest {
	return {
		bytes: Buffer.byteLength(text, "utf8"),
		sha256: createHash("sha256").update(text).digest("hex"),
		excerpt: text.slice(0, excerptChars),
	};
}

export function scaffoldLog(file: string, meta: { id: string; profile: string; outcome?: string; runDir: string }): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	if (fs.existsSync(file)) return;
	const lines = [
		`# Engineering log ${meta.id}`,
		"",
		`Worker: \`${meta.profile}\` · outcome: ${meta.outcome ?? "(unstated)"} · run: \`${meta.runDir}\``,
		"",
		...LOG_HEADINGS.map((heading) => `- **${heading}:** _pending_`),
		"",
	];
	fs.writeFileSync(file, lines.join("\n"), { mode: 0o644 });
}

function sectionContent(text: string, heading: string): string | undefined {
	const pattern = new RegExp(`\\*\\*${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:?\\*\\*\\s*:?([\\s\\S]*?)(?=\\n\\s*(?:[-*]\\s*)?(?:\\*\\*)?(?:${LOG_HEADINGS.map((item) => item.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})|$)`, "i");
	const match = pattern.exec(text);
	return match?.[1];
}

/** Check that a worker actually maintained its assigned engineering log. */
export function checkLog(file: string): LogCheck {
	let text: string;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch {
		return { log: "missing", detail: file };
	}
	const scaffoldOnly = /_pending_/g.test(text) && !text.replace(/_pending_/g, "").trim().split("\n").some((line) => line.replace(/^[-*#\s>]*/, "").length > 120);
	const missing: string[] = [];
	let filled = 0;
	for (const heading of LOG_HEADINGS) {
		const content = sectionContent(text, heading);
		if (content === undefined) {
			missing.push(heading);
			continue;
		}
		const meaningful = content.replace(/\s+/g, " ").trim();
		if (meaningful.length >= 40 && !PLACEHOLDER.test(meaningful) && !/^[:\s]*$/.test(meaningful)) filled++;
	}
	if (text.trim().length < 60 || scaffoldOnly) return { log: "empty", detail: "log has no entries beyond the scaffold" };
	if (missing.length > 0) return { log: "unfilled", detail: `missing headings: ${missing.join(", ")}` };
	if (filled < 3) return { log: "unfilled", detail: `only ${filled}/${LOG_HEADINGS.length} headings have content` };
	return { log: "ok" };
}
