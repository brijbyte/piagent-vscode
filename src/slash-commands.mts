/**
 * Slash-command handlers for the chat participant.
 *
 * /new, /resume, /model, /compact, /session, /login, /logout, /help
 */

import type { Api, Model, OAuthProviderId } from "@mariozechner/pi-ai";
import { getOAuthProviders } from "@mariozechner/pi-ai";
import {
	type SessionInfo,
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
import { cleanupSessionSubscription, state } from "./state.mjs";

// ── Router ───────────────────────────────────────────────────────────────────

export async function handleSlashCommand(
	command: string,
	_prompt: string,
	response: vscode.ChatResponseStream,
	workspaceFolder: string,
): Promise<vscode.ChatResult> {
	switch (command) {
		case "new":
			return slashNew(response, workspaceFolder);
		case "resume":
			return slashResume(response, workspaceFolder);
		case "model":
			return slashModel(response);
		case "compact":
			return slashCompact(response);
		case "session":
			return slashSession(response);
		case "login":
			return slashLogin(response);
		case "logout":
			return slashLogout(response);
		case "help":
			return slashHelp(response);
		default:
			response.markdown(`Unknown command: \`/${command}\``);
			return { metadata: { error: true } };
	}
}

// ── /new ─────────────────────────────────────────────────────────────────────

async function slashNew(
	response: vscode.ChatResponseStream,
	workspaceFolder: string,
): Promise<vscode.ChatResult> {
	try {
		const authStorage = AuthStorage.create();
		const modelRegistry = new ModelRegistry(authStorage);
		const settingsManager = SettingsManager.create(workspaceFolder);
		const sessionManager = SessionManager.create(workspaceFolder);
		sessionManager.newSession();

		const { session } = await createAgentSession({
			cwd: workspaceFolder,
			authStorage,
			modelRegistry,
			settingsManager,
			sessionManager,
		});

		cleanupSessionSubscription();
		state.currentSession = session;
		state.currentWorkspaceFolder = workspaceFolder;
		updateStatusBar();
		const model = session.model ? `${session.model.provider}/${session.model.id}` : "no model";
		response.markdown(`> **New session started** · ${model}`);
		state.outputChannel.appendLine("New session started via /new");
		return { metadata: { success: true } };
	} catch (err) {
		const errorMsg = err instanceof Error ? err.message : String(err);
		response.markdown(`**Error:** ${errorMsg}`);
		return { metadata: { error: true } };
	}
}

// ── /resume ──────────────────────────────────────────────────────────────────

async function slashResume(
	response: vscode.ChatResponseStream,
	workspaceFolder: string,
): Promise<vscode.ChatResult> {
	try {
		const sessions: SessionInfo[] = await SessionManager.list(workspaceFolder);

		if (sessions.length === 0) {
			response.markdown("No previous sessions found.");
			return { metadata: { success: true } };
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
			return { metadata: { cancelled: true } };
		}

		const sessionManager = SessionManager.create(workspaceFolder);
		sessionManager.setSessionFile(selected.sessionPath);

		const authStorage = AuthStorage.create();
		const modelRegistry = new ModelRegistry(authStorage);
		const settingsManager = SettingsManager.create(workspaceFolder);

		const { session, modelFallbackMessage } = await createAgentSession({
			cwd: workspaceFolder,
			authStorage,
			modelRegistry,
			settingsManager,
			sessionManager,
		});

		cleanupSessionSubscription();
		state.currentSession = session;
		state.currentWorkspaceFolder = workspaceFolder;
		updateStatusBar();
		const model = session.model ? `${session.model.provider}/${session.model.id}` : "no model";
		let status = `> **Resumed session** · ${selected.label} · ${selected.messageCount} messages · ${model}`;
		if (modelFallbackMessage) {
			status += `\n> ⚠️ ${modelFallbackMessage}`;
		}
		response.markdown(status);
		state.outputChannel.appendLine(`Resumed session via /resume: ${selected.sessionPath}`);
		return { metadata: { success: true } };
	} catch (err) {
		const errorMsg = err instanceof Error ? err.message : String(err);
		response.markdown(`**Error:** ${errorMsg}`);
		return { metadata: { error: true } };
	}
}

// ── /model ───────────────────────────────────────────────────────────────────

interface ModelQuickPickItem extends vscode.QuickPickItem {
	model?: Model<Api>;
}

async function slashModel(response: vscode.ChatResponseStream): Promise<vscode.ChatResult> {
	if (!state.currentSession) {
		response.markdown("No active session. Send a message first to initialize.");
		return { metadata: { error: true } };
	}

	try {
		const models: Model<Api>[] = state.currentSession.modelRegistry.getAvailable();

		if (models.length === 0) {
			response.markdown("No models available. Check your API keys.");
			return { metadata: { error: true } };
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
		const currentModelId = state.currentSession.model?.id;
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
			return { metadata: { cancelled: true } };
		}

		await state.currentSession.setModel(selected.model);
		updateStatusBar();
		response.markdown(`> **Model changed** · ${selected.model.provider}/${selected.model.id}`);
		state.outputChannel.appendLine(
			`Model changed via /model to ${selected.model.provider}/${selected.model.id}`,
		);
		return { metadata: { success: true } };
	} catch (err) {
		const errorMsg = err instanceof Error ? err.message : String(err);
		response.markdown(`**Error:** ${errorMsg}`);
		return { metadata: { error: true } };
	}
}

// ── /compact ─────────────────────────────────────────────────────────────────

async function slashCompact(response: vscode.ChatResponseStream): Promise<vscode.ChatResult> {
	if (!state.currentSession) {
		response.markdown("No active session. Send a message first to initialize.");
		return { metadata: { error: true } };
	}

	try {
		response.progress("Compacting session context...");
		await state.currentSession.compact();
		response.markdown("> **Session compacted**");
		state.outputChannel.appendLine("Session compacted via /compact");
		return { metadata: { success: true } };
	} catch (err) {
		const errorMsg = err instanceof Error ? err.message : String(err);
		response.markdown(`**Error:** ${errorMsg}`);
		return { metadata: { error: true } };
	}
}

// ── /session ─────────────────────────────────────────────────────────────────

async function slashSession(response: vscode.ChatResponseStream): Promise<vscode.ChatResult> {
	if (!state.currentSession) {
		response.markdown("No active session. Send a message first to initialize.");
		return { metadata: { error: true } };
	}

	const model = state.currentSession.model
		? `${state.currentSession.model.provider}/${state.currentSession.model.id}`
		: "no model";
	const messageCount = state.currentSession.messages.length;
	const sessionId = state.currentSession.sessionManager.getSessionId();

	let info = `## Session Info\n\n`;
	info += `- **Session ID:** \`${sessionId}\`\n`;
	info += `- **Model:** ${model}\n`;
	info += `- **Messages:** ${messageCount}\n`;
	info += `- **Working directory:** \`${state.currentWorkspaceFolder ?? "unknown"}\`\n`;

	response.markdown(info);
	return { metadata: { success: true } };
}

// ── /login ───────────────────────────────────────────────────────────────────

async function slashLogin(response: vscode.ChatResponseStream): Promise<vscode.ChatResult> {
	const authStorage = AuthStorage.create();
	const providers = getOAuthProviders();

	if (providers.length === 0) {
		response.markdown("No OAuth providers available.");
		return { metadata: { error: true } };
	}

	// Build QuickPick items with login status
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
		return { metadata: { cancelled: true } };
	}

	const providerId = selected.providerId;
	const providerName = selected.label;

	try {
		response.progress(`Logging in to ${providerName}...`);
		state.outputChannel.appendLine(`Starting OAuth login for ${providerName}`);

		await authStorage.login(providerId as OAuthProviderId, {
			onAuth: (info) => {
				vscode.env.openExternal(vscode.Uri.parse(info.url));
				state.outputChannel.appendLine(`OAuth: opened browser for ${info.url}`);

				if (info.instructions) {
					state.outputChannel.appendLine(`OAuth instructions: ${info.instructions}`);
				}
			},

			onPrompt: async (prompt) => {
				const value = await vscode.window.showInputBox({
					prompt: prompt.message,
					placeHolder: prompt.placeholder,
					ignoreFocusOut: true,
				});
				if (value === undefined) {
					throw new Error("Login cancelled");
				}
				if (!value && !prompt.allowEmpty) {
					throw new Error("Login cancelled");
				}
				return value ?? "";
			},

			onProgress: (message) => {
				response.progress(message);
				state.outputChannel.appendLine(`OAuth progress: ${message}`);
			},

			onManualCodeInput: async () => {
				const value = await vscode.window.showInputBox({
					prompt: "Paste the redirect URL from your browser",
					placeHolder: "https://...",
					ignoreFocusOut: true,
				});
				if (value === undefined) {
					throw new Error("Login cancelled");
				}
				return value;
			},
		});

		// Refresh model registry if session exists
		if (state.currentSession) {
			state.currentSession.modelRegistry.refresh();
		}

		const authPath = join(getAgentDir(), "auth.json");
		response.markdown(`> **Logged in to ${providerName}**\n>\n> Credentials saved to \`${authPath}\``);
		state.outputChannel.appendLine(`Successfully logged in to ${providerName}`);
		return { metadata: { success: true } };
	} catch (err) {
		const errorMsg = err instanceof Error ? err.message : String(err);
		if (errorMsg === "Login cancelled") {
			response.markdown("Login cancelled.");
			return { metadata: { cancelled: true } };
		}
		state.outputChannel.appendLine(`Login failed for ${providerName}: ${errorMsg}`);
		response.markdown(`**Error logging in to ${providerName}:** ${errorMsg}`);
		return { metadata: { error: true } };
	}
}

// ── /logout ──────────────────────────────────────────────────────────────────

async function slashLogout(response: vscode.ChatResponseStream): Promise<vscode.ChatResult> {
	const authStorage = AuthStorage.create();
	const providers = getOAuthProviders();

	// Filter to only providers that are logged in
	const loggedInProviders = providers.filter((p) => {
		const cred = authStorage.get(p.id);
		return cred?.type === "oauth";
	});

	if (loggedInProviders.length === 0) {
		response.markdown("No OAuth providers are currently logged in. Use `/login` first.");
		return { metadata: { error: true } };
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
		return { metadata: { cancelled: true } };
	}

	try {
		authStorage.logout(selected.providerId);

		// Refresh model registry if session exists
		if (state.currentSession) {
			state.currentSession.modelRegistry.refresh();
			updateStatusBar();
		}

		response.markdown(`> **Logged out of ${selected.label}**`);
		state.outputChannel.appendLine(`Logged out of ${selected.label}`);
		return { metadata: { success: true } };
	} catch (err) {
		const errorMsg = err instanceof Error ? err.message : String(err);
		response.markdown(`**Error logging out of ${selected.label}:** ${errorMsg}`);
		return { metadata: { error: true } };
	}
}

// ── /help ────────────────────────────────────────────────────────────────────

async function slashHelp(response: vscode.ChatResponseStream): Promise<vscode.ChatResult> {
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
`;

	response.markdown(help);
	return { metadata: { success: true } };
}
