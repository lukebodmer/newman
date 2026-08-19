import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

const HN_API = "https://hacker-news.firebaseio.com/v0";

function htmlToText(html: string): string {
	return html
		.replace(/<script[\s\S]*?<\/script>/gi, " ")
		.replace(/<style[\s\S]*?<\/style>/gi, " ")
		.replace(/<[^>]+>/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&nbsp;/g, " ")
		.replace(/\s{2,}/g, " ")
		.trim();
}

async function fetchArticle(url: string): Promise<string> {
	try {
		const resp = await fetch(url, {
			headers: { "User-Agent": "Mozilla/5.0 (compatible; newman/1.0)" },
			signal: AbortSignal.timeout(15_000),
		});
		if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
		const html = await resp.text();
		const text = htmlToText(html);
		if (text.length > 100) return text;
		throw new Error("No content extracted");
	} catch {
		// fall through to archive
	}

	try {
		const archiveUrl = `https://web.archive.org/web/${url}`;
		const resp = await fetch(archiveUrl, { signal: AbortSignal.timeout(15_000) });
		if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
		const html = await resp.text();
		const text = htmlToText(html);
		if (text.length > 100) return `[Via archive.org]\n${text}`;
	} catch {
		// fall through
	}

	return "[Article could not be fetched — may be paywalled or unavailable.]";
}

interface HnItem {
	id: number;
	title?: string;
	score?: number;
	by?: string;
	text?: string;
	url?: string;
}

const HackerNewsParams = Type.Object({
	action: Type.Union([Type.Literal("list"), Type.Literal("story")], {
		description:
			"'list' — get top stories (title, score, ID). 'story' — fetch full article content for a specific story ID or URL.",
	}),
	count: Type.Optional(Type.Number({ description: "Number of top stories to return. Only for action='list'. Default 10." })),
	story: Type.Optional(Type.String({ description: "Story ID or HN URL. Required for action='story'." })),
});

export const hackerNewsTool: ToolDefinition<typeof HackerNewsParams, Record<string, never>, Record<string, never>> = {
	name: "hacker_news",
	label: "Hacker News",
	description:
		"Interact with Hacker News. Use action='list' to get top N stories. Use action='story' to fetch full article content for a specific story ID or URL.",
	parameters: HackerNewsParams,

	async execute(_id, params) {
		try {
			const text = await dispatch(params);
			return { content: [{ type: "text", text }], details: {} };
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			return { content: [{ type: "text", text: `Error: ${msg}` }], details: {}, isError: true };
		}
	},
};

async function dispatch(params: { action: string; count?: number; story?: string }): Promise<string> {
	if (params.action === "list") {
		const count = params.count ?? 10;
		const resp = await fetch(`${HN_API}/topstories.json`, { signal: AbortSignal.timeout(10_000) });
		if (!resp.ok) throw new Error(`HN API error: ${resp.status}`);
		const ids = ((await resp.json()) as number[]).slice(0, count);

		const items = await Promise.all(
			ids.map(async (id) => {
				const r = await fetch(`${HN_API}/item/${id}.json`, { signal: AbortSignal.timeout(10_000) });
				return r.ok ? ((await r.json()) as HnItem) : null;
			}),
		);

		const lines: string[] = [];
		for (let i = 0; i < items.length; i++) {
			const item = items[i];
			if (item) lines.push(`${i + 1}. [${item.score ?? 0}] ${item.title ?? "?"} (id: ${item.id})`);
		}
		return lines.join("\n");
	}

	if (params.action === "story") {
		if (!params.story) throw new Error("'story' is required for action='story'.");

		let storyId = params.story.trim();
		if (storyId.includes("item?id=")) {
			storyId = storyId.split("item?id=")[1].split("&")[0];
		}

		const resp = await fetch(`${HN_API}/item/${storyId}.json`, { signal: AbortSignal.timeout(10_000) });
		if (!resp.ok) throw new Error(`HN API error: ${resp.status}`);
		const item = (await resp.json()) as HnItem | null;
		if (!item) throw new Error(`Story ${storyId} not found.`);

		const parts: string[] = [
			`# ${item.title ?? "(no title)"}`,
			`by ${item.by ?? "unknown"} | score: ${item.score ?? 0}`,
		];

		if (item.text) {
			const clean = item.text.replace(/<[^>]+>/g, " ").trim();
			parts.push(`\n## HN Post Text\n${clean}`);
		}

		if (item.url) {
			parts.push(`\n## Article URL\n${item.url}`);
			const content = await fetchArticle(item.url);
			parts.push(`\n## Article Content\n${content}`);
		} else {
			parts.push("\n[No external URL — this is a text-only post.]");
		}

		return parts.join("\n");
	}

	throw new Error(`Unknown action: ${params.action}`);
}
