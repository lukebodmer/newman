import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const TOKEN_URL = "https://api.schwabapi.com/v1/oauth/token";
const MARKET_URL = "https://api.schwabapi.com/marketdata/v1";
const TOKEN_FILE = join(homedir(), ".config", "schwab", "token.json");
const CONFIG_FILE = join(homedir(), ".config", "newman", "config.json");
const MIN_REFRESH_TOKEN_LEN = 30;

function loadJson(path: string): Record<string, string> {
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as Record<string, string>;
	} catch {
		return {};
	}
}

function saveJson(path: string, data: Record<string, string>): void {
	try {
		writeFileSync(path, JSON.stringify(data, null, 2));
	} catch {
		// best-effort
	}
}

function isPlaceholder(token: string): boolean {
	if (!token || token.length < MIN_REFRESH_TOKEN_LEN) return true;
	return !/[A-Za-z0-9_-]{6}/.test(token);
}

function resolveRefreshToken(): { token: string; source: "config" | "token_file" } {
	const cfg = loadJson(CONFIG_FILE);
	const configRt = cfg.schwab_refresh_token ?? "";
	if (!isPlaceholder(configRt)) return { token: configRt, source: "config" };
	const fileRt = loadJson(TOKEN_FILE).refresh_token ?? "";
	if (!isPlaceholder(fileRt)) return { token: fileRt, source: "token_file" };
	return { token: configRt, source: "config" };
}

async function getAccessToken(): Promise<string> {
	const cfg = loadJson(CONFIG_FILE);
	const appKey = cfg.schwab_app_key ?? "";
	const appSecret = cfg.schwab_app_secret ?? "";
	const { token: refreshToken, source } = resolveRefreshToken();

	if (!appKey || !appSecret || !refreshToken) {
		throw new Error(
			"Schwab credentials not configured. Set schwab_app_key, schwab_app_secret, and schwab_refresh_token in ~/.config/newman/config.json",
		);
	}

	const credentials = Buffer.from(`${appKey}:${appSecret}`).toString("base64");
	const resp = await fetch(TOKEN_URL, {
		method: "POST",
		headers: {
			Authorization: `Basic ${credentials}`,
			"Content-Type": "application/x-www-form-urlencoded",
		},
		body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }),
	});

	if (!resp.ok) {
		const body = await resp.text();
		throw new Error(`Schwab token error ${resp.status}: ${body}`);
	}

	const data = (await resp.json()) as Record<string, string>;
	const accessToken = data.access_token;

	const updates: Record<string, string> = { schwab_access_token: accessToken };
	if (data.refresh_token) updates.schwab_refresh_token = data.refresh_token;

	if (source === "token_file") {
		const disk = loadJson(TOKEN_FILE);
		if (data.refresh_token) disk.refresh_token = data.refresh_token;
		saveJson(TOKEN_FILE, disk);
		updates.schwab_refresh_token = data.refresh_token ?? refreshToken;
	}

	saveJson(CONFIG_FILE, { ...loadJson(CONFIG_FILE), ...updates });
	return accessToken;
}

async function apiGet(path: string, params: Record<string, string | number | undefined>): Promise<unknown> {
	const token = await getAccessToken();
	const url = new URL(`${MARKET_URL}${path}`);
	for (const [k, v] of Object.entries(params)) {
		if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
	}
	const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
	if (!resp.ok) {
		const body = await resp.text();
		throw new Error(`Schwab API ${resp.status}: ${body}`);
	}
	return resp.json();
}

// --- Formatters ---

function fmtQuotes(data: Record<string, Record<string, Record<string, unknown>>>): string {
	const lines: string[] = [];
	for (const [sym, info] of Object.entries(data)) {
		const q = (info.quote ?? info) as Record<string, unknown>;
		lines.push(
			`${sym}: $${q.lastPrice ?? q.last ?? "N/A"} ` +
				`(${Number(q.netChange ?? 0) >= 0 ? "+" : ""}${Number(q.netChange ?? 0).toFixed(2)} / ` +
				`${Number(q.netPercentChange ?? 0) >= 0 ? "+" : ""}${Number(q.netPercentChange ?? 0).toFixed(2)}%) ` +
				`bid ${q.bidPrice ?? "N/A"} ask ${q.askPrice ?? "N/A"} ` +
				`vol ${q.totalVolume ?? q.volume ?? "N/A"}`,
		);
	}
	return lines.join("\n") || "No quote data returned.";
}

function fmtOptionChain(data: Record<string, unknown>): string {
	const lines = [`Option chain: ${data.symbol} — underlying $${data.underlyingPrice ?? "N/A"}`];
	for (const [side, label] of [
		["callExpDateMap", "CALLS"],
		["putExpDateMap", "PUTS"],
	] as const) {
		const expMap = (data[side] ?? {}) as Record<string, Record<string, unknown[]>>;
		for (const [expiry, strikes] of Object.entries(expMap)) {
			lines.push(`\n  ${label} — exp ${expiry.split(":")[0]}`);
			for (const [strike, contracts] of Object.entries(strikes)) {
				for (const c of contracts as Record<string, unknown>[]) {
					lines.push(
						`    $${strike} | bid ${c.bid} ask ${c.ask} last ${c.last} ` +
							`IV ${c.volatility !== undefined ? (Number(c.volatility) / 100).toFixed(1) + "%" : "N/A"} ` +
							`delta ${c.delta ?? "N/A"} OI ${c.openInterest ?? "N/A"}`,
					);
				}
			}
		}
	}
	return lines.join("\n");
}

function fmtExpirations(data: Record<string, unknown>): string {
	const exps = (data.expirationList ?? []) as Record<string, string>[];
	if (!exps.length) return "No expiration dates found.";
	return ["Expiration dates:", ...exps.map((e) => `  ${e.expirationDate}  type=${e.expirationType}  settlement=${e.settlementType}`)].join("\n");
}

function fmtPriceHistory(data: Record<string, unknown>): string {
	const candles = (data.candles ?? []) as Record<string, number>[];
	if (!candles.length) return `No price history returned for ${data.symbol}.`;
	const lines = [`Price history: ${data.symbol} (${candles.length} candles)`, "  date                  open     high      low    close    volume"];
	for (const c of candles) {
		const ts = new Date(c.datetime).toISOString().replace("T", " ").slice(0, 16);
		lines.push(`  ${ts}  ${c.open.toFixed(2).padStart(8)} ${c.high.toFixed(2).padStart(8)} ${c.low.toFixed(2).padStart(8)} ${c.close.toFixed(2).padStart(8)} ${String(c.volume).padStart(10)}`);
	}
	return lines.join("\n");
}

function fmtMovers(data: Record<string, unknown>): string {
	const movers = (data.screeners ?? data.movers ?? []) as Record<string, unknown>[];
	if (!movers.length) return "No movers data returned.";
	return [
		"Top movers:",
		...movers.map((m) => {
			const chg = Number(m.netChange ?? 0);
			const pct = Number(m.netPercentChange ?? m.percentChange ?? 0);
			return `  ${String(m.symbol ?? "").padEnd(8)} ${chg >= 0 ? "+" : ""}${chg.toFixed(2)} (${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%) last $${m.lastPrice ?? m.last ?? "N/A"} vol ${m.totalVolume ?? m.volume ?? "N/A"}`;
		}),
	].join("\n");
}

function fmtMarketHours(data: Record<string, Record<string, Record<string, unknown>>>): string {
	const lines = ["Market hours:"];
	for (const [market, products] of Object.entries(data)) {
		if (typeof products !== "object") continue;
		for (const [product, info] of Object.entries(products)) {
			if (typeof info !== "object") continue;
			const session = (info.sessionHours ?? {}) as Record<string, { start: string; end: string }[]>;
			const regular = session.regularMarket?.[0];
			const hours = regular ? `${regular.start} – ${regular.end}` : "";
			lines.push(`  ${market}/${product}: ${info.isOpen ? "open" : "closed"}  ${hours}`);
		}
	}
	return lines.join("\n");
}

function fmtInstruments(data: unknown): string {
	const items: Record<string, string>[] = Array.isArray(data)
		? (data as Record<string, string>[])
		: Object.values((data as Record<string, unknown>).instruments ?? data ?? {}) as Record<string, string>[];
	if (!items.length) return "No instruments found.";
	return items.map((i) => `${i.symbol} — ${i.description} [${i.assetType}] CUSIP: ${i.cusip ?? "N/A"}`).join("\n");
}

function dateToMs(dateStr: string): number {
	const d = new Date(`${dateStr}T12:00:00Z`);
	return d.getTime();
}

// --- Tool definition ---

const SchwabParams = Type.Object({
	action: Type.Union(
		[
			Type.Literal("quote"),
			Type.Literal("quotes"),
			Type.Literal("option_chain"),
			Type.Literal("option_expirations"),
			Type.Literal("price_history"),
			Type.Literal("movers"),
			Type.Literal("market_hours"),
			Type.Literal("instrument"),
		],
		{
			description:
				"'quote' — single symbol. 'quotes' — multiple symbols. 'option_chain' — full options chain. " +
				"'option_expirations' — available expiry dates. 'price_history' — OHLCV candles. " +
				"'movers' — top movers for an index. 'market_hours' — trading hours. 'instrument' — symbol lookup.",
		},
	),
	symbol: Type.Optional(Type.String({ description: "Ticker symbol (e.g. 'AAPL', 'SPY'). Required for most actions." })),
	symbols: Type.Optional(Type.String({ description: "Comma-separated symbols for 'quotes' action." })),
	contract_type: Type.Optional(
		Type.Union([Type.Literal("CALL"), Type.Literal("PUT"), Type.Literal("ALL")], {
			description: "Filter option chain by contract type. Default ALL.",
		}),
	),
	strike_count: Type.Optional(Type.Number({ description: "Strikes above and below ATM price." })),
	from_date: Type.Optional(Type.String({ description: "Start date YYYY-MM-DD." })),
	to_date: Type.Optional(Type.String({ description: "End date YYYY-MM-DD." })),
	period_type: Type.Optional(
		Type.Union([Type.Literal("day"), Type.Literal("month"), Type.Literal("year"), Type.Literal("ytd")], {
			description: "Period type for price history.",
		}),
	),
	period: Type.Optional(Type.Number({ description: "Number of periods." })),
	frequency_type: Type.Optional(
		Type.Union([Type.Literal("minute"), Type.Literal("daily"), Type.Literal("weekly"), Type.Literal("monthly")], {
			description: "Candle frequency type.",
		}),
	),
	frequency: Type.Optional(Type.Number({ description: "Candle frequency (e.g. 1, 5, 15, 30 for minutes)." })),
	sort: Type.Optional(
		Type.Union(
			[
				Type.Literal("VOLUME"),
				Type.Literal("TRADES"),
				Type.Literal("PERCENT_CHANGE_UP"),
				Type.Literal("PERCENT_CHANGE_DOWN"),
			],
			{ description: "How to sort movers. Default PERCENT_CHANGE_UP." },
		),
	),
	frequency_movers: Type.Optional(Type.Number({ description: "Mover frequency in minutes (0, 1, 5, 10, 30, 60). 0 = all day." })),
	markets: Type.Optional(Type.String({ description: "Comma-separated markets for 'market_hours': equity, option, bond, forex, future." })),
	date: Type.Optional(Type.String({ description: "Date YYYY-MM-DD for market_hours query." })),
	projection: Type.Optional(
		Type.Union(
			[
				Type.Literal("symbol-search"),
				Type.Literal("symbol-regex"),
				Type.Literal("desc-search"),
				Type.Literal("desc-regex"),
				Type.Literal("search"),
				Type.Literal("fundamental"),
			],
			{ description: "Search projection for 'instrument' action." },
		),
	),
});

export const schwabTool: ToolDefinition<typeof SchwabParams, Record<string, never>, Record<string, never>> = {
	name: "schwab",
	label: "Schwab Market Data",
	description:
		"Fetch real-time and historical market data from Schwab. Supports quotes, options chains, price history, market movers, market hours, and instrument lookup. Read-only.",
	parameters: SchwabParams,

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

async function dispatch(p: {
	action: string;
	symbol?: string;
	symbols?: string;
	contract_type?: string;
	strike_count?: number;
	from_date?: string;
	to_date?: string;
	period_type?: string;
	period?: number;
	frequency_type?: string;
	frequency?: number;
	sort?: string;
	frequency_movers?: number;
	markets?: string;
	date?: string;
	projection?: string;
}): Promise<string> {
	switch (p.action) {
		case "quote": {
			if (!p.symbol) throw new Error("'symbol' is required for quote.");
			const data = await apiGet(`/${p.symbol}/quotes`, {});
			return fmtQuotes(data as Record<string, Record<string, Record<string, unknown>>>);
		}
		case "quotes": {
			const syms = p.symbols ?? p.symbol;
			if (!syms) throw new Error("'symbols' or 'symbol' is required for quotes.");
			const data = await apiGet("/quotes", { symbols: syms });
			return fmtQuotes(data as Record<string, Record<string, Record<string, unknown>>>);
		}
		case "option_chain": {
			if (!p.symbol) throw new Error("'symbol' is required for option_chain.");
			const data = await apiGet("/chains", {
				symbol: p.symbol,
				contractType: p.contract_type ?? "ALL",
				strikeCount: p.strike_count,
				fromDate: p.from_date,
				toDate: p.to_date,
			});
			return fmtOptionChain(data as Record<string, unknown>);
		}
		case "option_expirations": {
			if (!p.symbol) throw new Error("'symbol' is required for option_expirations.");
			const data = await apiGet("/expirationchain", { symbol: p.symbol });
			return fmtExpirations(data as Record<string, unknown>);
		}
		case "price_history": {
			if (!p.symbol) throw new Error("'symbol' is required for price_history.");
			const data = await apiGet("/pricehistory", {
				symbol: p.symbol,
				periodType: p.period_type,
				period: p.period,
				frequencyType: p.frequency_type,
				frequency: p.frequency,
				startDate: p.from_date ? dateToMs(p.from_date) : undefined,
				endDate: p.to_date ? dateToMs(p.to_date) : undefined,
			});
			return fmtPriceHistory(data as Record<string, unknown>);
		}
		case "movers": {
			if (!p.symbol) throw new Error("'symbol' is required for movers (index, e.g. '$SPX').");
			const data = await apiGet(`/movers/${p.symbol}`, {
				sort: p.sort ?? "PERCENT_CHANGE_UP",
				frequency: p.frequency_movers,
			});
			return fmtMovers(data as Record<string, unknown>);
		}
		case "market_hours": {
			const data = await apiGet("/markets", {
				markets: p.markets ?? "equity,option",
				date: p.date,
			});
			return fmtMarketHours(data as Record<string, Record<string, Record<string, unknown>>>);
		}
		case "instrument": {
			if (!p.symbol) throw new Error("'symbol' is required for instrument.");
			const data = await apiGet("/instruments", {
				symbol: p.symbol,
				projection: p.projection ?? "symbol-search",
			});
			return fmtInstruments(data);
		}
		default:
			throw new Error(`Unknown action: ${p.action}`);
	}
}
