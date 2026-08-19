import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";

const SOCKET_CANDIDATES = [
	process.env.XDG_RUNTIME_DIR ? `${process.env.XDG_RUNTIME_DIR}/newman_bridge.sock` : null,
	`/run/user/${process.getuid?.() ?? 1000}/newman_bridge.sock`,
	"/tmp/newman_bridge.sock",
	`${tmpdir()}/newman_bridge.sock`,
].filter(Boolean) as string[];

function resolveSocketPath(): string | null {
	for (const candidate of SOCKET_CANDIDATES) {
		try {
			if (existsSync(candidate)) return candidate;
		} catch {
			// ignore
		}
	}
	return null;
}

function fetchViaSocket(url: string, timeoutMs = 20_000, connectTimeoutMs = 5_000): Promise<Record<string, unknown>> {
	return new Promise((resolve, reject) => {
		const socketPath = resolveSocketPath();
		if (!socketPath) {
			reject(new Error("Newman browser bridge is not running. Is the Firefox extension active?"));
			return;
		}

		const connectTimer = setTimeout(() => {
			socket.destroy();
			reject(new Error(`Browser bridge connect timeout after ${connectTimeoutMs}ms`));
		}, connectTimeoutMs);

		const socket = createConnection(socketPath, () => {
			clearTimeout(connectTimer);

			const readTimer = setTimeout(() => {
				socket.destroy();
				reject(new Error(`Browser fetch timed out after ${timeoutMs}ms`));
			}, timeoutMs);

			const msg = JSON.stringify({ action: "fetch", url, id: process.pid });
			socket.write(msg);
			socket.end();

			const chunks: Buffer[] = [];
			socket.on("data", (chunk) => chunks.push(chunk));
			socket.on("end", () => {
				clearTimeout(readTimer);
				try {
					resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8")) as Record<string, unknown>);
				} catch {
					reject(new Error("Invalid JSON from browser bridge"));
				}
			});
		});

		socket.on("error", (err) => {
			clearTimeout(connectTimer);
			reject(err);
		});
	});
}

const BrowserFetchParams = Type.Object({
	url: Type.String({ description: "The URL to fetch." }),
});

export const browserFetchTool: ToolDefinition<typeof BrowserFetchParams, Record<string, never>, Record<string, never>> = {
	name: "browser_fetch",
	label: "Browser Fetch",
	description:
		"Fetch a URL using your real Firefox browser and return the page text. " +
		"Use this instead of web_fetch for paywalled, JS-heavy, or bot-protected pages. " +
		"Requires the Newman Browser Bridge extension to be active in Firefox.",
	parameters: BrowserFetchParams,

	async execute(_id, params) {
		try {
			const result = await fetchViaSocket(params.url);
			if (!result.ok) {
				const msg = (result.error as string | undefined) ?? "Unknown browser bridge error";
				return { content: [{ type: "text", text: msg }], details: {}, isError: true };
			}
			const title = (result.title as string | undefined) ?? "";
			const finalUrl = (result.url as string | undefined) ?? params.url;
			const text = (result.text as string | undefined) ?? "";
			const output = `Title: ${title}\nURL: ${finalUrl}\n\n${text}`;
			return { content: [{ type: "text", text: output }], details: {} };
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			return { content: [{ type: "text", text: msg }], details: {}, isError: true };
		}
	},
};
