/**
 * Slash-command handlers for the chat participant.
 *
 * /new, /resume, /model, /compact, /session, /login, /logout, /help
 *
 * Each handler receives a `conversationId` so it can look up / create the
 * correct per-tab AgentSession in `state.conversations`.
 */

import type { Api, Model, OAuthProviderId } from "@mariozechner/pi-ai";
import type { UserMessage, AssistantMessage, TextContent, ToolCall } from "@mariozechner/pi-ai";
import { getOAuthProviders } from "@mariozechner/pi-ai";
import {
	type SessionInfo,
	type SessionMessageEntry,
	AuthStorage,
	createAgentSession,
	getAgentDir,
	ModelRegistry,
	SessionManager,
	SettingsManager,
} from "@mariozechner/pi-coding-agent";
import { join } from "path";
import * as vscode from "vscode";
import { updateStatusBar } from "./status-bar.mjs";
import {
	type ChatConversation,
	cleanupConversationSubscription,
	getActiveSession,
	state,
} from "./state.mjs";
import { createResourceLoader } from "./session.mjs";

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Show a "no active session" message with inline command links to start or resume one.
 * Uses trusted MarkdownString so command links render side-by-side on one line.
 */
function noSessionResponse(
	response: vscode.ChatResponseStream,
	conversationId: string,
): vscode.ChatResult {
	const newArgs = encodeURIComponent(JSON.stringify({ query: "@piagent /new", isPartialQuery: false }));
	const resumeArgs = encodeURIComponent(JSON.stringify({ query: "@piagent /resume", isPartialQuery: false }));

	const md = new vscode.MarkdownString(
		`No active session. ` +
		`[$(add) New Session](command:workbench.action.chat.open?${newArgs}) · ` +
		`[$(history) Resume Session](command:workbench.action.chat.open?${resumeArgs})`,
	);
	md.isTrusted = { enabledCommands: ["workbench.action.chat.open"] };
	md.supportThemeIcons = true;

	response.markdown(md);
	return { metadata: { conversationId, error: true } };
}

/**
 * Get the conversation for this chat tab, or return a no-session response.
 * Returns `null` if no conversation exists (and sends the no-session message).
 */
function requireConversation(
	conversationId: string,
	response: vscode.ChatResponseStream,
): ChatConversation | null {
	const conv = state.conversations.get(conversationId);
	if (!conv) {
		noSessionResponse(response, conversationId);
		return null;
	}
	return conv;
}

/**
 * Render the previous conversation from session history into the chat response.
 * Shows user prompts and assistant replies so the user has context.
 */
function renderSessionHistory(
	response: vscode.ChatResponseStream,
	sessionManager: SessionManager,
): void {
	const entries = sessionManager.getEntries();
	const messageEntries = entries.filter(
		(e): e is SessionMessageEntry => e.type === "message",
	);

	if (messageEntries.length === 0) return;

	response.markdown("\n\n---\n\n**Previous conversation:**\n\n");

	for (const entry of messageEntries) {
		const msg = entry.message;

		if (msg.role === "user") {
			const userMsg = msg as UserMessage;
			const text =
				typeof userMsg.content === "string"
					? userMsg.content
					: userMsg.content
							.filter((c): c is TextContent => c.type === "text")
							.map((c) => c.text)
							.join("");

			if (!text.trim()) continue;

			const display = text.length > 300 ? text.slice(0, 300) + "…" : text;
			response.markdown(`**You:** ${display}\n\n`);
		} else if (msg.role === "assistant") {
			const assistantMsg = msg as AssistantMessage;
			const textParts = assistantMsg.content
				.filter((c): c is TextContent => c.type === "text")
				.map((c) => c.text)
				.join("");

			const toolCalls = assistantMsg.content.filter(
				(c): c is ToolCall => c.type === "toolCall",
			);

			if (textParts.trim()) {
				const display =
					textParts.length > 500 ? textParts.slice(0, 500) + "…" : textParts;
				response.markdown(`**Assistant:** ${display}\n\n`);
			}

			if (toolCalls.length > 0) {
				const toolSummary = toolCalls
					.map((tc) => `\`${tc.name}\``)
					.join(", ");
				response.markdown(`*Tools used: ${toolSummary}*\n\n`);
			}
		}
	}

	response.markdown("---\n\n");
}

// ── Router ───────────────────────────────────────────────────────────────────

export async function handleSlashCommand(
	command: string,
	_prompt: string,
	response: vscode.ChatResponseStream,
	workspaceFolder: string,
	conversationId: string,
): Promise<vscode.ChatResult> {
	switch (command) {
		case "new":
			return slashNew(response, workspaceFolder, conversationId);
		case "resume":
			return slashResume(response, workspaceFolder, conversationId);
		case "model":
			return slashModel(response, conversationId);
		case "compact":
			return slashCompact(response, conversationId);
		case "session":
			return slashSession(response, conversationId);
		case "login":
			return slashLogin(response, conversationId);
		case "logout":
			return slashLogout(response, conversationId);
		case "help":
			return slashHelp(response, conversationId);
		default:
			response.markdown(`Unknown command: \`/${command}\``);
			return { metadata: { conversationId, error: true } };
	}
}

// ── /new ─────────────────────────────────────────────────────────────────────

async function slashNew(
	response: vscode.ChatResponseStream,
	workspaceFolder: string,
	conversationId: string,
): Promise<vscode.ChatResult> {
	try {
		const authStorage = AuthStorage.create();
		const modelRegistry = new ModelRegistry(authStorage);
		const settingsManager = SettingsManager.create(workspaceFolder);
		const sessionManager = SessionManager.create(workspaceFolder);
		sessionManager.newSession();
		const resourceLoader = await createResourceLoader(workspaceFolder, settingsManager);

		const { session } = await createAgentSession({
			cwd: workspaceFolder,
			authStorage,
			modelRegistry,
			settingsManager,
			sessionManager,
			resourceLoader,
		});

		// Clean up any existing conversation for this tab
		const existing = state.conversations.get(conversationId);
		if (existing) cleanupConversationSubscription(existing);

		// Create a new conversation entry
		const conv: ChatConversation = {
			id: conversationId,
			session,
			workspaceFolder,
			activeResponse: undefined,
			activeToolCalls: new Map(),
			sessionUnsubscribe: undefined,
		};
		state.conversations.set(conversationId, conv);
		state.activeConversationId = conversationId;

		updateStatusBar();
		const model = session.model ? `${session.model.provider}/${session.model.id}` : "no model";
		response.markdown(`> **New session started** · ${model}`);
		return { metadata: { conversationId, success: true } };
	} catch (err) {
		const errorMsg = err instanceof Error ? err.message : String(err);
		response.markdown(`**Error:** ${errorMsg}`);
		return { metadata: { conversationId, error: true } };
	}
}

// ── /resume ──────────────────────────────────────────────────────────────────

async function slashResume(
	response: vscode.ChatResponseStream,
	workspaceFolder: string,
	conversationId: string,
): Promise<vscode.ChatResult> {
	try {
		const sessions: SessionInfo[] = await SessionManager.list(workspaceFolder);

		if (sessions.length === 0) {
			response.markdown("No previous sessions found.");
			return { metadata: { conversationId, success: true } };
		}

		const items = sessions.slice(0, 20).map((s) => ({
			label: s.name || s.id.slice(0, 8),
			description: s.modified.toLocaleString(),
			detail: `${s.messageCount} messages`,
			sessionPath: s.path,
			messageCount: s.messageCount,
		}));

		const selected = await vscode.window.showQuickPick(items, {
			placeHolder: "Select a session to resume",
		});

		if (!selected) {
			response.markdown("Session selection cancelled.");
			return { metadata: { conversationId, cancelled: true } };
		}

		const sessionManager = SessionManager.create(workspaceFolder);
		sessionManager.setSessionFile(selected.sessionPath);

		const authStorage = AuthStorage.create();
		const modelRegistry = new ModelRegistry(authStorage);
		const settingsManager = SettingsManager.create(workspaceFolder);
		const resourceLoader = await createResourceLoader(workspaceFolder, settingsManager);

		const { session, modelFallbackMessage } = await createAgentSession({
			cwd: workspaceFolder,
			authStorage,
			modelRegistry,
			settingsManager,
			sessionManager,
			resourceLoader,
		});

		// Clean up any existing conversation for this tab
		const existing = state.conversations.get(conversationId);
		if (existing) cleanupConversationSubscription(existing);

		const conv: ChatConversation = {
			id: conversationId,
			session,
			workspaceFolder,
			activeResponse: undefined,
			activeToolCalls: new Map(),
			sessionUnsubscribe: undefined,
		};
		state.conversations.set(conversationId, conv);
		state.activeConversationId = conversationId;

		updateStatusBar();
		const model = session.model ? `${session.model.provider}/${session.model.id}` : "no model";
		let status = `> **Resumed session** · ${selected.label} · ${selected.messageCount} messages · ${model}`;
		if (modelFallbackMessage) {
			status += `\n> ⚠️ ${modelFallbackMessage}`;
		}
		response.markdown(status);

		// Render previous conversation history
		renderSessionHistory(response, session.sessionManager);

		return { metadata: { conversationId, success: true } };
	} catch (err) {
		const errorMsg = err instanceof Error ? err.message : String(err);
		response.markdown(`**Error:** ${errorMsg}`);
		return { metadata: { conversationId, error: true } };
	}
}

// ── /model ───────────────────────────────────────────────────────────────────

interface ModelQuickPickItem extends vscode.QuickPickItem {
	model?: Model<Api>;
}

async function slashModel(
	response: vscode.ChatResponseStream,
	conversationId: string,
): Promise<vscode.ChatResult> {
	const conv = requireConversation(conversationId, response);
	if (!conv) return { metadata: { conversationId, error: true } };

	try {
		const models: Model<Api>[] = conv.session.modelRegistry.getAvailable();

		if (models.length === 0) {
			response.markdown("No models available. Check your API keys.");
			return { metadata: { conversationId, error: true } };
		}

		// Group models by provider
		const modelsByProvider = new Map<string, Model<Api>[]>();
		for (const model of models) {
			const provider = model.provider;
			if (!modelsByProvider.has(provider)) {
				modelsByProvider.set(provider, []);
			}
			modelsByProvider.get(provider)!.push(model);
		}

		// Build items with separators
		const items: ModelQuickPickItem[] = [];
		const currentModelId = conv.session.model?.id;
		const sortedProviders = Array.from(modelsByProvider.keys()).sort();

		for (const provider of sortedProviders) {
			items.push({
				label: provider,
				kind: vscode.QuickPickItemKind.Separator,
			});

			const providerModels = modelsByProvider.get(provider)!;
			for (const m of providerModels) {
				const isCurrent = m.id === currentModelId;
				items.push({
					label: isCurrent ? `$(check) ${m.id}` : m.id,
					description: m.reasoning ? "reasoning" : undefined,
					model: m,
				});
			}
		}

		const selected = await vscode.window.showQuickPick(items, {
			placeHolder: "Select a model",
			matchOnDescription: true,
		});

		if (!selected || !selected.model) {
			response.markdown("Model selection cancelled.");
			return { metadata: { conversationId, cancelled: true } };
		}

		await conv.session.setModel(selected.model);
		updateStatusBar();
		response.markdown(`> **Model changed** · ${selected.model.provider}/${selected.model.id}`);
		return { metadata: { conversationId, success: true } };
	} catch (err) {
		const errorMsg = err instanceof Error ? err.message : String(err);
		response.markdown(`**Error:** ${errorMsg}`);
		return { metadata: { conversationId, error: true } };
	}
}

// ── /compact ─────────────────────────────────────────────────────────────────

async function slashCompact(
	response: vscode.ChatResponseStream,
	conversationId: string,
): Promise<vscode.ChatResult> {
	const conv = requireConversation(conversationId, response);
	if (!conv) return { metadata: { conversationId, error: true } };

	try {
		response.progress("Compacting session context...");
		await conv.session.compact();
		response.markdown("> **Session compacted**");
		return { metadata: { conversationId, success: true } };
	} catch (err) {
		const errorMsg = err instanceof Error ? err.message : String(err);
		response.markdown(`**Error:** ${errorMsg}`);
		return { metadata: { conversationId, error: true } };
	}
}

// ── /session ─────────────────────────────────────────────────────────────────

async function slashSession(
	response: vscode.ChatResponseStream,
	conversationId: string,
): Promise<vscode.ChatResult> {
	const conv = requireConversation(conversationId, response);
	if (!conv) return { metadata: { conversationId, error: true } };

	const session = conv.session;
	const model = session.model
		? `${session.model.provider}/${session.model.id}`
		: "no model";
	const messageCount = session.messages.length;
	const sessionId = session.sessionManager.getSessionId();

	// Count total conversations
	const totalConversations = state.conversations.size;

	let info = `## Session Info\n\n`;
	info += `- **Session ID:** \`${sessionId}\`\n`;
	info += `- **Conversation:** \`${conversationId}\`\n`;
	info += `- **Model:** ${model}\n`;
	info += `- **Messages:** ${messageCount}\n`;
	info += `- **Working directory:** \`${conv.workspaceFolder}\`\n`;
	info += `- **Active conversations:** ${totalConversations}\n`;

	response.markdown(info);
	return { metadata: { conversationId, success: true } };
}

// ── /login ───────────────────────────────────────────────────────────────────

async function slashLogin(
	response: vscode.ChatResponseStream,
	conversationId: string,
): Promise<vscode.ChatResult> {
	const authStorage = AuthStorage.create();
	const providers = getOAuthProviders();

	if (providers.length === 0) {
		response.markdown("No OAuth providers available.");
		return { metadata: { conversationId, error: true } };
	}

	const items = providers.map((p) => {
		const cred = authStorage.get(p.id);
		const isLoggedIn = cred?.type === "oauth";
		return {
			label: p.name,
			description: isLoggedIn ? "$(check) logged in" : undefined,
			providerId: p.id,
		};
	});

	const selected = await vscode.window.showQuickPick(items, {
		placeHolder: "Select a provider to login",
	});

	if (!selected) {
		response.markdown("Login cancelled.");
		return { metadata: { conversationId, cancelled: true } };
	}

	const providerId = selected.providerId;
	const providerName = selected.label;

	try {
		response.progress(`Logging in to ${providerName}...`);

		await authStorage.login(providerId as OAuthProviderId, {
			onAuth: (info) => {
				vscode.env.openExternal(vscode.Uri.parse(info.url));
			},

			onPrompt: async (prompt) => {
				const value = await vscode.window.showInputBox({
					prompt: prompt.message,
					placeHolder: prompt.placeholder,
					ignoreFocusOut: true,
				});
				if (value === undefined) throw new Error("Login cancelled");
				if (!value && !prompt.allowEmpty) throw new Error("Login cancelled");
				return value ?? "";
			},

			onProgress: (message) => {
				response.progress(message);
			},

			onManualCodeInput: async () => {
				const value = await vscode.window.showInputBox({
					prompt: "Paste the redirect URL from your browser",
					placeHolder: "https://...",
					ignoreFocusOut: true,
				});
				if (value === undefined) throw new Error("Login cancelled");
				return value;
			},
		});

		// Refresh model registries across all conversations
		for (const conv of state.conversations.values()) {
			conv.session.modelRegistry.refresh();
		}

		const authPath = join(getAgentDir(), "auth.json");
		response.markdown(`> **Logged in to ${providerName}**\n>\n> Credentials saved to \`${authPath}\``);
		return { metadata: { conversationId, success: true } };
	} catch (err) {
		const errorMsg = err instanceof Error ? err.message : String(err);
		if (errorMsg === "Login cancelled") {
			response.markdown("Login cancelled.");
			return { metadata: { conversationId, cancelled: true } };
		}
		response.markdown(`**Error logging in to ${providerName}:** ${errorMsg}`);
		return { metadata: { conversationId, error: true } };
	}
}

// ── /logout ──────────────────────────────────────────────────────────────────

async function slashLogout(
	response: vscode.ChatResponseStream,
	conversationId: string,
): Promise<vscode.ChatResult> {
	const authStorage = AuthStorage.create();
	const providers = getOAuthProviders();

	const loggedInProviders = providers.filter((p) => {
		const cred = authStorage.get(p.id);
		return cred?.type === "oauth";
	});

	if (loggedInProviders.length === 0) {
		response.markdown("No OAuth providers are currently logged in. Use `/login` first.");
		return { metadata: { conversationId, error: true } };
	}

	const items = loggedInProviders.map((p) => ({
		label: p.name,
		providerId: p.id,
	}));

	const selected = await vscode.window.showQuickPick(items, {
		placeHolder: "Select a provider to logout",
	});

	if (!selected) {
		response.markdown("Logout cancelled.");
		return { metadata: { conversationId, cancelled: true } };
	}

	try {
		authStorage.logout(selected.providerId);

		// Refresh model registries across all conversations
		for (const conv of state.conversations.values()) {
			conv.session.modelRegistry.refresh();
		}
		updateStatusBar();

		response.markdown(`> **Logged out of ${selected.label}**`);
		return { metadata: { conversationId, success: true } };
	} catch (err) {
		const errorMsg = err instanceof Error ? err.message : String(err);
		response.markdown(`**Error logging out of ${selected.label}:** ${errorMsg}`);
		return { metadata: { conversationId, error: true } };
	}
}

// ── /help ────────────────────────────────────────────────────────────────────

async function slashHelp(
	response: vscode.ChatResponseStream,
	conversationId: string,
): Promise<vscode.ChatResult> {
	const help = `## Available Commands

| Command | Description |
|---------|-------------|
| \`/new\` | Start a new session |
| \`/resume\` | Resume a previous session |
| \`/model\` | Select a different model |
| \`/compact\` | Compact the session context |
| \`/session\` | Show session info and stats |
| \`/login\` | Login with an OAuth provider (Anthropic, OpenAI, GitHub Copilot, Google) |
| \`/logout\` | Logout from an OAuth provider |
| \`/help\` | Show this help |

### Keyboard Shortcuts

- **Cmd+Shift+M** (Mac) / **Ctrl+Shift+M** (Windows/Linux): Select model

### Command Palette

- **PiAgent: New Session** - Start a fresh session
- **PiAgent: Resume Session** - Continue a previous session
- **PiAgent: Select Model** - Choose a different model
- **PiAgent: Login** - Login with an OAuth provider
- **PiAgent: Logout** - Logout from an OAuth provider

Each chat tab gets its own independent session.
`;

	response.markdown(help);
	return { metadata: { conversationId, success: true } };
}
