#!/usr/bin/env node
/**
 * Fake `pi --mode rpc` used by the contract tests.
 *
 * Behaviour is selected with FAKE_PI_SCENARIO and mirrors the scenarios the
 * orchestration skill's Python contract suite covered, plus the interactive,
 * steer and long-running cases the dashboard adds.
 */

import { appendFileSync, writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
const arg = (name) => argv[argv.indexOf(name) + 1];
const model = arg("--model");
const provider = arg("--provider");
const thinking = arg("--thinking");
const scenario = process.env.FAKE_PI_SCENARIO ?? "ok";

writeFileSync("fake.pid", String(process.pid));
const out = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const states = { count: 0 };

function state() {
	states.count += 1;
	return {
		model: { id: scenario === "wrong" ? "muse-spark-1.3" : model, provider },
		thinkingLevel: scenario === "effort" || (scenario === "post_mismatch" && states.count > 1) ? "low" : thinking,
		isStreaming: false,
		isCompacting: scenario === "compacting",
		pendingMessageCount: 0,
	};
}

function assistant(text, stopReason = "stop") {
	return {
		role: "assistant",
		provider,
		model: scenario === "fallback" ? "paid-model" : model,
		stopReason,
		content: text === null ? [] : [{ type: "text", text }],
		usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { total: 0.001 } },
	};
}

function finish(message) {
	out({ type: "message_end", message });
	out({ type: "agent_end", messages: [message] });
	out({ type: "agent_settled" });
}

let hanging = false;
let aborted = false;
let turnTick;
let turnFinished = false;
let steerAttempts = 0;
let followUpAttempts = 0;

function finishTurn(text, stopReason = "stop") {
	if (turnTick) clearInterval(turnTick);
	if (turnFinished) return;
	turnFinished = true;
	finish(assistant(text, stopReason));
}

function handle(line) {
	let command;
	try {
		command = JSON.parse(line);
	} catch {
		return;
	}
	const id = command.id;
	const respond = (data) => out({ type: "response", id, command: command.type, success: true, data });
	switch (command.type) {
		case "get_state": {
			const payload = state();
			respond(payload);
			if (scenario === "backpressure") {
				process.stdin.pause();
				setTimeout(() => process.exit(0), 30_000);
			}
			break;
		}
		case "get_available_thinking_levels":
			respond({ levels: ["off", "minimal", "low", "medium", "high"] });
			break;
		case "get_commands":
			respond({ commands: [{ name: "fake" }] });
			break;
		case "prompt": {
			writeFileSync("prompt-used", "yes");
			if (scenario === "timeout") {
				setTimeout(() => process.exit(0), 30_000);
				return;
			}
			if (scenario === "exit") process.exit(7);
			if (scenario === "handled") {
				respond({ disposition: "handled" });
				return;
			}
			if (scenario === "rejected") {
				out({ type: "response", id, command: "prompt", success: false, error: "no credentials" });
				return;
			}
			if (scenario === "interactive") {
				out({ type: "extension_ui_request", id: "ui1", method: "confirm", title: "Allow?" });
				return;
			}
			if (scenario === "input_park") {
				respond({ disposition: "started" });
				out({ type: "extension_ui_request", id: "ui7", method: "select", title: "Pick one", options: ["alpha", "beta"] });
				return;
			}
			if (scenario === "steer_rejected" || scenario === "follow_up_rejected") {
				respond({ disposition: "started" });
				hanging = true;
				out({ type: "agent_start" });
				// Keep the turn in flight until the expected control calls have been made; the steer
				// and follow_up handlers finish it, including when they arrived before this prompt.
				turnTick = setInterval(() => {
					if (aborted) {
						finishTurn("stopped after rejected control", "aborted");
						return;
					}
					out({ type: "message_update", usage: {}, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "." } });
				}, 120);
				if (scenario === "steer_rejected" ? steerAttempts >= 2 : followUpAttempts >= 1) {
					finishTurn(scenario === "steer_rejected" ? "done after recovering from rejected steer" : "done after rejected follow-up");
				}
				return;
			}
			if (scenario === "answer_rejected") {
				respond({ disposition: "started" });
				out({ type: "extension_ui_request", id: "ui-rejected", method: "confirm", title: "Allow?" });
				return;
			}
			if (scenario === "hang" || scenario === "steer") {
				respond({ disposition: "started" });
				hanging = true;
				out({ type: "agent_start" });
				const tick = setInterval(() => {
					if (aborted) {
						clearInterval(tick);
						finish(assistant("stopped after steer", "aborted"));
						return;
					}
					out({ type: "message_update", usage: { input: 10, output: 5, totalTokens: 15, cost: { total: 0.001 } }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "." } });
				}, 120);
				return;
			}
			respond({ disposition: "started" });
			out({ type: "message_end", message: { role: "user", content: [{ type: "text", text: command.message }] } });
			if (scenario === "retry") {
				const failed = assistant("", "error");
				out({ type: "message_end", message: failed });
				out({ type: "agent_end", messages: [failed], willRetry: true });
			}
			const text = scenario === "empty" ? null : `${String(command.message.length)}:${String(command.message).slice(-12)}`;
			finish(assistant(text, scenario === "error" ? "error" : "stop"));
			break;
		}
		case "extension_ui_response": {
			if (scenario === "answer_rejected") {
				out({ type: "response", id, command: "extension_ui_response", success: false, error: "answer not allowed here" });
				finish(assistant("done after rejected answer"));
				break;
			}
			respond({});
			finish(assistant(`chose:${String(command.value ?? "cancelled")}`));
			break;
		}
		case "steer":
		case "follow_up": {
			if (scenario === "steer_rejected" && command.type === "steer") {
				steerAttempts += 1;
				if (steerAttempts === 1) {
					out({ type: "response", id, command: "steer", success: false, error: "steer not allowed here" });
					break;
				}
			}
			if (scenario === "follow_up_rejected" && command.type === "follow_up") {
				followUpAttempts += 1;
				out({ type: "response", id, command: "follow_up", success: false, error: "follow_up not allowed here" });
				finishTurn("done after rejected follow-up");
				break;
			}
			appendFileSync(`${command.type}.log`, `${String(command.message)}\n`);
			respond({ disposition: "queued" });
			if (command.type === "steer") {
				out({ type: "message_update", usage: {}, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "steered" } });
				if (scenario === "steer_rejected" && steerAttempts >= 2) finishTurn("done after recovering from rejected steer");
			}
			break;
		}
		case "abort": {
			respond({});
			if (hanging) aborted = true;
			break;
		}
		case "clear_queue":
			respond({ steering: [], followUp: [] });
			break;
		default:
			respond({});
			break;
	}
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	buffer += chunk;
	let index = buffer.indexOf("\n");
	while (index >= 0) {
		const line = buffer.slice(0, index);
		buffer = buffer.slice(index + 1);
		index = buffer.indexOf("\n");
		if (line.trim() !== "") handle(line);
	}
});
process.stdin.on("end", () => setTimeout(() => process.exit(0), 50));
