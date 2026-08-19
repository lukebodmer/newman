import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { schwabTool } from "./schwab.ts";
import { browserFetchTool } from "./browser-fetch.ts";
import { browserSearchTool } from "./browser-search.ts";
import { hackerNewsTool } from "./hacker-news.ts";

export default function (pi: ExtensionAPI) {
	pi.registerTool(schwabTool);
	pi.registerTool(browserFetchTool);
	pi.registerTool(browserSearchTool);
	pi.registerTool(hackerNewsTool);
}
