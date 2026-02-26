/**
 * Status bar — shows model name, token usage, cost, and context usage.
 *
 * Format matches the pi CLI footer:
 *   $(robot) claude-sonnet-4-20250514 / ↑141 / ↓26k / R7.8M / W99k / $5.159 (sub) / 49.7%/200k (auto)
 */

import type { ContextUsage } from "@mariozechner/pi-coding-agent";
import * as vscode from "vscode";
import { getActiveConversation, state } from "./state.mjs";

let statusBarItem: vscode.StatusBarItem | undefined;

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Format token counts for compact display (matches CLI footer style).
 * Examples: 141 → "141", 26000 → "26k", 7800000 → "7.8M"
 */
function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

/** Status bar item visibility keys, controlled by piagent.statusBar.show setting. */
type StatusBarItemKey =
	| "inputTokens"
	| "outputTokens"
	| "cacheRead"
	| "cacheWrite"
	| "cost"
	| "contextUsage";

function getStatusBarItemOrder(): StatusBarItemKey[] {
	const config = vscode.workspace.getConfiguration("piagent");
	return config.get<StatusBarItemKey[]>("statusBar.show", [
		"inputTokens",
		"outputTokens",
		"cacheRead",
		"cacheWrite",
		"cost",
		"contextUsage",
	]);
}

// ── Public API ───────────────────────────────────────────────────────────────

export function ensureStatusBar(): vscode.StatusBarItem {
	if (!statusBarItem) {
		statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
		statusBarItem.command = "piagent.selectModel";
		statusBarItem.tooltip = "Click to change PiAgent model";
		state.extensionContext.subscriptions.push(statusBarItem);
	}
	return statusBarItem;
}

export function updateStatusBar(): void {
	const conv = getActiveConversation();

	if (!statusBarItem && !conv) {
		// Don't create the status bar until PiAgent has been used
		return;
	}

	const bar = ensureStatusBar();

	if (!conv?.session?.model) {
		bar.text = "$(robot) PiAgent: No model";
		bar.tooltip = "Click to change PiAgent model";
		bar.show();
		return;
	}

	const session = conv.session;
	const model = session.model!;
	const itemOrder = getStatusBarItemOrder();

	// Calculate cumulative usage from ALL session entries
	let totalInput = 0;
	let totalOutput = 0;
	let totalCacheRead = 0;
	let totalCacheWrite = 0;
	let totalCost = 0;

	for (const entry of session.sessionManager.getEntries()) {
		if (entry.type === "message" && entry.message.role === "assistant") {
			totalInput += entry.message.usage.input;
			totalOutput += entry.message.usage.output;
			totalCacheRead += entry.message.usage.cacheRead;
			totalCacheWrite += entry.message.usage.cacheWrite;
			totalCost += entry.message.usage.cost.total;
		}
	}

	const hasUsage = totalInput > 0 || totalOutput > 0;

	// Build a map of all available parts, then assemble in setting order
	const availableParts = new Map<StatusBarItemKey, string>();

	if (hasUsage) {
		if (totalInput) availableParts.set("inputTokens", `↑${formatTokens(totalInput)}`);
		if (totalOutput) availableParts.set("outputTokens", `↓${formatTokens(totalOutput)}`);
		if (totalCacheRead) availableParts.set("cacheRead", `R${formatTokens(totalCacheRead)}`);
		if (totalCacheWrite) availableParts.set("cacheWrite", `W${formatTokens(totalCacheWrite)}`);

		const usingSubscription = session.modelRegistry.isUsingOAuth(model);
		if (totalCost || usingSubscription) {
			availableParts.set("cost", `$${totalCost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`);
		}
	}

	// Context usage is available even before usage data (shows ?/window)
	const contextUsageData: ContextUsage | undefined = session.getContextUsage();
	const contextWindow = contextUsageData?.contextWindow ?? model.contextWindow ?? 0;
	if (contextWindow > 0) {
		const autoIndicator = session.autoCompactionEnabled ? " (auto)" : "";
		if (contextUsageData?.percent != null) {
			availableParts.set(
				"contextUsage",
				`${contextUsageData.percent.toFixed(1)}%/${formatTokens(contextWindow)}${autoIndicator}`,
			);
		} else {
			availableParts.set("contextUsage", `?/${formatTokens(contextWindow)}${autoIndicator}`);
		}
	}

	// Assemble parts in the order specified by the setting
	const parts: string[] = [];
	for (const item of itemOrder) {
		const text = availableParts.get(item);
		if (text) parts.push(text);
	}

	const statsStr = parts.length > 0 ? ` / ${parts.join(" / ")}` : "";
	bar.text = `$(robot) ${model.id}${statsStr}`;

	// Build a detailed tooltip (always shows everything regardless of setting)
	const tooltipLines = [`Model: ${model.provider}/${model.id}`];
	if (hasUsage) {
		tooltipLines.push("");
		tooltipLines.push(`Input tokens: ${totalInput.toLocaleString()}`);
		tooltipLines.push(`Output tokens: ${totalOutput.toLocaleString()}`);
		if (totalCacheRead) tooltipLines.push(`Cache read: ${totalCacheRead.toLocaleString()}`);
		if (totalCacheWrite) tooltipLines.push(`Cache write: ${totalCacheWrite.toLocaleString()}`);
		tooltipLines.push(`Cost: $${totalCost.toFixed(3)}`);

		const contextUsage: ContextUsage | undefined = session.getContextUsage();
		if (contextUsage?.percent != null) {
			tooltipLines.push(`Context: ${contextUsage.percent.toFixed(1)}%`);
		}
	}
	tooltipLines.push("");
	tooltipLines.push("Click to change model");

	bar.tooltip = tooltipLines.join("\n");
	bar.show();
}
