/**
 * Session event → ChatResponseStream rendering.
 *
 * Translates AgentSessionEvent objects into markdown / progress calls on the
 * active VSCode chat response stream.
 */

import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import * as vscode from "vscode";
import { updateStatusBar, setThinkingStatus } from "./status-bar.mjs";

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Format a byte count for display.
 */
function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} bytes`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Map file extensions to markdown fence language identifiers. */
const EXT_TO_LANG: Record<string, string> = {
	".ts": "typescript",
	".tsx": "tsx",
	".mts": "typescript",
	".cts": "typescript",
	".js": "javascript",
	".jsx": "jsx",
	".mjs": "javascript",
	".cjs": "javascript",
	".json": "json",
	".jsonc": "jsonc",
	".py": "python",
	".rs": "rust",
	".go": "go",
	".rb": "ruby",
	".java": "java",
	".kt": "kotlin",
	".kts": "kotlin",
	".swift": "swift",
	".c": "c",
	".h": "c",
	".cpp": "cpp",
	".hpp": "cpp",
	".cc": "cpp",
	".cs": "csharp",
	".html": "html",
	".htm": "html",
	".css": "css",
	".scss": "scss",
	".less": "less",
	".vue": "vue",
	".svelte": "svelte",
	".php": "php",
	".sh": "bash",
	".bash": "bash",
	".zsh": "zsh",
	".fish": "fish",
	".ps1": "powershell",
	".sql": "sql",
	".md": "markdown",
	".mdx": "mdx",
	".yaml": "yaml",
	".yml": "yaml",
	".toml": "toml",
	".xml": "xml",
	".graphql": "graphql",
	".gql": "graphql",
	".r": "r",
	".lua": "lua",
	".dart": "dart",
	".ex": "elixir",
	".exs": "elixir",
	".erl": "erlang",
	".zig": "zig",
	".tf": "hcl",
	".dockerfile": "dockerfile",
	".proto": "protobuf",
};

/**
 * Infer a fence language for tool results based on tool name and args.
 * Returns "" when no language can be determined (plain text fence).
 */
function inferResultLanguage(toolName: string, argsJson: string | undefined): string {
	if (!argsJson) return "";

	try {
		const args = JSON.parse(argsJson);

		switch (toolName) {
			case "read":
			case "write":
			case "edit": {
				const filePath = args.path as string | undefined;
				if (!filePath) return "";
				return langFromPath(filePath);
			}
			case "bash":
				return "bash";
			case "grep":
			case "find":
			case "ls":
				return "";
			default:
				return "";
		}
	} catch {
		return "";
	}
}

function langFromPath(filePath: string): string {
	// Check exact filename first (e.g. "Dockerfile", "Makefile")
	const basename = filePath.split("/").pop() ?? "";
	const lowerBase = basename.toLowerCase();
	if (lowerBase === "dockerfile" || lowerBase.startsWith("dockerfile."))
		return "dockerfile";
	if (lowerBase === "makefile" || lowerBase === "gnumakefile") return "makefile";

	// Extension lookup
	const dot = basename.lastIndexOf(".");
	if (dot === -1) return "";
	const ext = basename.slice(dot).toLowerCase();
	return EXT_TO_LANG[ext] ?? "";
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
			} else if (evt.type === "thinking_start") {
				setThinkingStatus(true);
			} else if (evt.type === "thinking_end") {
				setThinkingStatus(false);
			}
			// thinking_delta content is not displayed
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
			break;
		}

		case "tool_execution_update": {
			// Partial results streamed to output channel for debugging if needed
			break;
		}

		case "tool_execution_end": {
			const { toolCallId, toolName, result, isError } = event;
			const entry = toolCallsInProgress.get(toolCallId);
			toolCallsInProgress.delete(toolCallId);

			const resultText = extractToolResultText(result);
			const truncated = resultText.length > 500 ? `${resultText.slice(0, 500)}...` : resultText;
			const lang = inferResultLanguage(toolName, entry?.args);

			if (isError) {
				response.markdown(`\n\`\`\`\nError: ${truncated}\n\`\`\`\n`);
			} else {
				response.markdown(`\n\`\`\`${lang}\n${truncated}\n\`\`\`\n`);
			}
			break;
		}

		case "message_end": {
			// Clear thinking status and update status bar with latest token usage
			setThinkingStatus(false);
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
