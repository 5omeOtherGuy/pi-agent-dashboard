/**
 * Control channel: one UNIX socket per worker, owned by its supervisor.
 *
 * Any Pi session on the machine can connect to steer, abort, answer or inspect a
 * worker started by any other session. The socket lives in the 0700 state
 * directory with mode 0600, so access is limited to the owning user.
 */

import * as fs from "node:fs";
import * as net from "node:net";
import { CONTROL_VERSION, type ControlRequest, type ControlResponse } from "./protocol.ts";

export type ControlHandler = (request: ControlRequest, peer: { pid?: number }) => Promise<unknown>;

export interface ControlServer {
	path: string;
	close(): Promise<void>;
}

function parseRequest(line: string): ControlRequest {
	const value: unknown = JSON.parse(line);
	if (typeof value !== "object" || value === null) throw new Error("control request must be an object");
	const request = value as { cmd?: unknown };
	if (typeof request.cmd !== "string") throw new Error("control request needs a cmd");
	return request as ControlRequest;
}

export async function startControlServer(socketPath: string, handler: ControlHandler): Promise<ControlServer> {
	fs.rmSync(socketPath, { force: true });
	const server = net.createServer((socket) => {
		let buffer = "";
		socket.setEncoding("utf8");
		socket.on("data", (chunk: string) => {
			buffer += chunk;
			let index = buffer.indexOf("\n");
			while (index >= 0) {
				const line = buffer.slice(0, index);
				buffer = buffer.slice(index + 1);
				index = buffer.indexOf("\n");
				if (line.trim() === "") continue;
				void handleLine(socket, line);
			}
		});
		socket.on("error", () => socket.destroy());
	});

	const handleLine = async (socket: net.Socket, line: string): Promise<void> => {
		let response: ControlResponse;
		try {
			const request = parseRequest(line);
			const data = await handler(request, {});
			response = { version: CONTROL_VERSION, id: (request as { id?: string }).id, ok: true, data };
		} catch (error) {
			let id: string | undefined;
			try {
				id = (JSON.parse(line) as { id?: string }).id;
			} catch {
				id = undefined;
			}
			response = {
				version: CONTROL_VERSION,
				id,
				ok: false,
				error: error instanceof Error ? error.message : String(error),
			};
		}
		if (!socket.destroyed) socket.write(`${JSON.stringify(response)}\n`);
	};

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(socketPath, () => {
			server.off("error", reject);
			resolve();
		});
	});
	try {
		fs.chmodSync(socketPath, 0o600);
	} catch {
		// Mode is defensive only; the parent directory is already 0700.
	}
	return {
		path: socketPath,
		close: () =>
			new Promise<void>((resolve) => {
				server.close(() => resolve());
				setTimeout(() => resolve(), 500).unref();
			}),
	};
}

export interface ControlCallOptions {
	timeoutMs?: number;
}

/** Send one control request and resolve with its response. Rejects on transport errors or timeout. */
export function sendControl(socketPath: string, request: ControlRequest, options: ControlCallOptions = {}): Promise<ControlResponse> {
	const timeoutMs = options.timeoutMs ?? 5000;
	return new Promise<ControlResponse>((resolve, reject) => {
		const socket = net.connect(socketPath);
		let buffer = "";
		let settled = false;
		const finish = (fn: () => void): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			socket.destroy();
			fn();
		};
		const timer = setTimeout(() => finish(() => reject(new Error(`control timeout after ${timeoutMs}ms`))), timeoutMs);
		socket.setEncoding("utf8");
		socket.on("connect", () => {
			socket.write(`${JSON.stringify({ id: "1", ...request })}\n`);
		});
		socket.on("data", (chunk: string) => {
			buffer += chunk;
			const index = buffer.indexOf("\n");
			if (index < 0) return;
			const line = buffer.slice(0, index);
			try {
				const response = JSON.parse(line) as ControlResponse;
				finish(() => resolve(response));
			} catch (error) {
				finish(() => reject(error instanceof Error ? error : new Error(String(error))));
			}
		});
		socket.on("error", (error) => finish(() => reject(error)));
		socket.on("close", () => finish(() => reject(new Error("control connection closed without a response"))));
	});
}

/** True when a supervisor is listening and answering on this socket. */
export async function controlAlive(socketPath: string, timeoutMs = 400): Promise<boolean> {
	try {
		const response = await sendControl(socketPath, { cmd: "status" }, { timeoutMs });
		return response.ok;
	} catch {
		return false;
	}
}
