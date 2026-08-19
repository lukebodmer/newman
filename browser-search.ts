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

function parseGoogleResults(text: string, count: number): string[] {
	const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
	const results: string[] = [];
	for (let i = 0; i < lines.length && results.length < count; i++) {
		const line = lines[i];
		if (/^https?:\/\//.test(line) || /^[\w.-]+\.\w{2,}/.test(line)) {
			const url = line;
			const title = i > 0 ? lines[i - 1] : "";
			const snippet = i + 1 < lines.length ? lines[i + 1] : "";
			if (title && !/^https?:\/\//.test(title)) {
				results.push(`${results.length + 1}. ${title}\n   ${url}\n   ${snippet}`);
			}
		}
	}
	return results;
}

const BrowserSearchParams = Type.Object({
	query: Type.String({ description: "Search query." }),
	count: Type.Optional(Type.Number({ description: "Number of results to return (default 5, max 20)." })),
	recency: Type.Optional(
		Type.String({ description: "Google time filter, e.g. '1d', '1w', '1h'. Restricts results to recent pages." }),
	),
});

export const browserSearchTool: ToolDefinition<typeof BrowserSearchParams, Record<string, never>, Record<string, never>> = {
	name: "browser_search",
	label: "Browser Search",
	description:
		"Search Google using your real Firefox browser. Returns titles, URLs, and snippets. " +
		"Requires the Newman Browser Bridge extension to be active in Firefox. " +
		"Pass recency to restrict results to recent pages (e.g. '1d', '1w', '1h').",
	parameters: BrowserSearchParams,

	async execute(_id, params) {
		const count = Math.min(Math.max(1, params.count ?? 5), 20);
		const encoded = encodeURIComponent(params.query);
		let url = `https://www.google.com/search?q=${encoded}&num=${count}`;
		if (params.recency && /^\d+[shdwmy]$/.test(params.recency)) {
			url += `&tbs=qdr:${params.recency}`;
		}

		try {
			const result = await fetchViaSocket(url);
			if (!result.ok) {
				const msg = (result.error as string | undefined) ?? "Unknown browser bridge error";
				return { content: [{ type: "text", text: msg }], details: {}, isError: true };
			}
			if ((result.url as string | undefined)?.includes("/sorry/")) {
				return {
					content: [{ type: "text", text: "Google blocked the request (CAPTCHA). Try again shortly." }],
					details: {},
					isError: true,
				};
			}

			const text = (result.text as string | undefined) ?? "";
			const lines = parseGoogleResults(text, count);
			if (!lines.length) {
				return { content: [{ type: "text", text: "No results found." }], details: {} };
			}
			return { content: [{ type: "text", text: lines.join("\n\n") }], details: {} };
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			return { content: [{ type: "text", text: msg }], details: {}, isError: true };
		}
	},
};
