/**
 * Session event → ChatResponseStream rendering.
 *
 * Translates AgentSessionEvent objects into markdown / progress calls on the
 * active VSCode chat response stream.
 */

import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import * as vscode from "vscode";
import { state } from "./state.mjs";
import { updateStatusBar } from "./status-bar.mjs";

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Format a byte count for display.
 */
function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} bytes`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Build a human-readable summary shown right after "Tool: <name>" so there's
 * no blank gap while the tool executes.
 */
function formatToolStartContext(toolName: string, args: Record<string, unknown>): string {
	switch (toolName) {
		case "write": {
			const path = args.path as string | undefined;
			const content = args.content as string | undefined;
			if (path && content) {
				return `\`${path}\` (${formatBytes(content.length)})`;
			}
			if (path) return `\`${path}\``;
			return "";
		}
		case "edit": {
			const path = args.path as string | undefined;
			return path ? `\`${path}\`` : "";
		}
		case "read": {
			const path = args.path as string | undefined;
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			let detail = path ? `\`${path}\`` : "";
			if (offset || limit) {
				const parts: string[] = [];
				if (offset) parts.push(`offset ${offset}`);
				if (limit) parts.push(`limit ${limit}`);
				detail += ` (${parts.join(", ")})`;
			}
			return detail;
		}
		case "bash": {
			const command = args.command as string | undefined;
			if (command) {
				const firstLine = command.split("\n")[0];
				const truncated = firstLine.length > 120 ? firstLine.slice(0, 120) + "…" : firstLine;
				return `\`${truncated}\``;
			}
			return "";
		}
		case "grep": {
			const pattern = args.pattern as string | undefined;
			const path = args.path as string | undefined;
			if (pattern && path) return `\`${pattern}\` in \`${path}\``;
			if (pattern) return `\`${pattern}\``;
			return "";
		}
		case "find": {
			const pattern = args.pattern as string | undefined;
			const path = args.path as string | undefined;
			if (pattern && path) return `\`${pattern}\` in \`${path}\``;
			if (pattern) return `\`${pattern}\``;
			return "";
		}
		case "ls": {
			const path = args.path as string | undefined;
			return path ? `\`${path}\`` : "";
		}
		default:
			return "";
	}
}

// ── Public API ───────────────────────────────────────────────────────────────

export function handleSessionEvent(
	event: AgentSessionEvent,
	response: vscode.ChatResponseStream,
	toolCallsInProgress: Map<string, { name: string; args: string }>,
): void {
	switch (event.type) {
		case "message_update": {
			const evt = event.assistantMessageEvent;
			if (!evt) break;

			if (evt.type === "text_delta") {
				const delta = (evt as { type: "text_delta"; delta: string }).delta;
				response.markdown(delta);
			}
			// thinking_delta is ignored for now
			break;
		}

		case "tool_execution_start": {
			const { toolCallId, toolName, args } = event;
			toolCallsInProgress.set(toolCallId, {
				name: toolName,
				args: JSON.stringify(args, null, 2),
			});

			const context = formatToolStartContext(toolName, args as Record<string, unknown>);
			const contextSuffix = context ? ` ${context}` : "";
			response.markdown(`\n\n**Tool:** \`${toolName}\`${contextSuffix}\n`);

			// For tools that don't stream updates, show a progress indicator
			// so the user knows something is happening
			if (toolName === "write" || toolName === "edit" || toolName === "read") {
				response.progress(`Running ${toolName}...`);
			}

			state.outputChannel.appendLine(`[Tool Start] ${toolName}: ${JSON.stringify(args)}`);
			break;
		}

		case "tool_execution_update": {
			const { partialResult } = event;
			if (partialResult?.content) {
				for (const block of partialResult.content) {
					if (block.type === "text") {
						state.outputChannel.append(block.text);
					}
				}
			}
			break;
		}

		case "tool_execution_end": {
			const { toolCallId, toolName, result, isError } = event;
			toolCallsInProgress.delete(toolCallId);

			const resultText = extractToolResultText(result);
			const truncated = resultText.length > 500 ? `${resultText.slice(0, 500)}...` : resultText;

			if (isError) {
				response.markdown(`\n\`\`\`\nError: ${truncated}\n\`\`\`\n`);
			} else {
				response.markdown(`\n\`\`\`\n${truncated}\n\`\`\`\n`);
			}

			state.outputChannel.appendLine(`[Tool End] ${toolName}: ${isError ? "ERROR" : "OK"}`);
			state.outputChannel.appendLine(resultText);
			state.outputChannel.appendLine("");
			break;
		}

		case "message_end": {
			// Update status bar with latest token usage after each assistant message
			updateStatusBar();
			break;
		}

		case "auto_compaction_start": {
			response.progress(`Compacting context (${event.reason})...`);
			break;
		}

		case "auto_compaction_end": {
			// Context usage changes after compaction
			updateStatusBar();
			break;
		}

		case "auto_retry_start": {
			response.progress(`Retrying (attempt ${event.attempt}/${event.maxAttempts})...`);
			break;
		}
	}
}

function extractToolResultText(result: unknown): string {
	if (!result || typeof result !== "object") return String(result ?? "");

	const r = result as { content?: Array<{ type: string; text?: string }> };
	if (Array.isArray(r.content)) {
		return r.content
			.filter((c) => c.type === "text")
			.map((c) => c.text ?? "")
			.join("");
	}

	return JSON.stringify(result, null, 2);
}
