/**
 * Command-palette commands.
 *
 * These run outside of a chat request so they can't write to a
 * ChatResponseStream.  Instead they stash a status string in
 * `state.pendingSessionStatus` which the next chat request picks up.
 *
 * Commands that need a session operate on the "active conversation" — the one
 * whose chat tab most recently received a request.
 *
 * Quick Actions are context menu commands that send selected code to the chat
 * with a specific prompt.
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
import { applySettingsToSession } from "./settings.mjs";
import { updateStatusBar } from "./status-bar.mjs";
import {
	type ChatConversation,
	cleanupConversationSubscription,
	getActiveConversation,
	newConversationId,
	state,
} from "./state.mjs";
import { createResourceLoader } from "./session.mjs";

// ── Types ────────────────────────────────────────────────────────────────────

interface ModelQuickPickItem extends vscode.QuickPickItem {
	model?: Model<Api>;
}

// ── New Session ──────────────────────────────────────────────────────────────

export async function cmdNewSession(): Promise<void> {
	const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();

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

		// Apply VSCode settings to the new session
		applySettingsToSession(session);

		// Create a new conversation for the active chat tab (or a new ID if none)
		const conversationId = state.activeConversationId ?? newConversationId();
		const existing = state.conversations.get(conversationId);
		if (existing) cleanupConversationSubscription(existing);

		const conv: ChatConversation = {
			id: conversationId,
			session,
			workspaceFolder,
			activeResponse: undefined,
			activeToolCalls: new Map(),
			sessionUnsubscribe: undefined,
			lastPrompt: undefined,
		};
		state.conversations.set(conversationId, conv);
		state.activeConversationId = conversationId;

		updateStatusBar();
		const model = session.model ? `${session.model.provider}/${session.model.id}` : "no model";
		state.pendingSessionStatus = `**New session started** · ${model}`;
	} catch (err) {
		const errorMsg = err instanceof Error ? err.message : String(err);
		vscode.window.showErrorMessage(`Failed to create session: ${errorMsg}`);
	}
}

// ── Resume Session ───────────────────────────────────────────────────────────

export async function cmdResumeSession(): Promise<void> {
	const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();

	try {
		const sessions: SessionInfo[] = await SessionManager.list(workspaceFolder);

		if (sessions.length === 0) {
			vscode.window.showInformationMessage("No previous sessions found");
			return;
		}

		const items = sessions.slice(0, 20).map((s) => ({
			label: s.name || s.id.slice(0, 8),
			description: s.modified.toLocaleString(),
			detail: `${s.messageCount} messages`,
			sessionPath: s.path,
		}));

		const selected = await vscode.window.showQuickPick(items, {
			placeHolder: "Select a session to resume",
		});

		if (!selected) return;

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

		// Apply VSCode settings to the resumed session
		applySettingsToSession(session);

		const conversationId = state.activeConversationId ?? newConversationId();
		const existing = state.conversations.get(conversationId);
		if (existing) cleanupConversationSubscription(existing);

		const conv: ChatConversation = {
			id: conversationId,
			session,
			workspaceFolder,
			activeResponse: undefined,
			activeToolCalls: new Map(),
			sessionUnsubscribe: undefined,
			lastPrompt: undefined,
		};
		state.conversations.set(conversationId, conv);
		state.activeConversationId = conversationId;

		updateStatusBar();
		const model = session.model ? `${session.model.provider}/${session.model.id}` : "no model";
		const messageCount = sessions.find((s) => s.path === selected.sessionPath)?.messageCount ?? 0;
		let status = `**Resumed session** · ${selected.label} · ${messageCount} messages · ${model}`;

		if (modelFallbackMessage) {
			status += ` · ⚠️ ${modelFallbackMessage}`;
		}

		state.pendingSessionStatus = status;
	} catch (err) {
		const errorMsg = err instanceof Error ? err.message : String(err);
		vscode.window.showErrorMessage(`Failed to resume session: ${errorMsg}`);
	}
}

// ── Select Model ─────────────────────────────────────────────────────────────

export async function cmdSelectModel(): Promise<void> {
	const conv = getActiveConversation();
	if (!conv) {
		vscode.window.showWarningMessage("No active session. Send a message first or resume a session.");
		return;
	}

	try {
		const models: Model<Api>[] = conv.session.modelRegistry.getAvailable();

		if (models.length === 0) {
			vscode.window.showWarningMessage("No models available. Check your API keys.");
			return;
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

		if (!selected || !selected.model) return;

		await conv.session.setModel(selected.model);
		updateStatusBar();
		state.pendingSessionStatus = `**Model changed** · ${selected.model.provider}/${selected.model.id}`;
	} catch (err) {
		const errorMsg = err instanceof Error ? err.message : String(err);
		vscode.window.showErrorMessage(`Failed to select model: ${errorMsg}`);
	}
}

// ── Login ────────────────────────────────────────────────────────────────────

export async function cmdLogin(): Promise<void> {
	const authStorage = AuthStorage.create();
	const providers = getOAuthProviders();

	if (providers.length === 0) {
		vscode.window.showWarningMessage("No OAuth providers available.");
		return;
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

	if (!selected) return;

	const providerId = selected.providerId;
	const providerName = selected.label;

	try {
		await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: `Logging in to ${providerName}...`,
				cancellable: true,
			},
			async (_progress, token) => {
				const abortController = new AbortController();
				token.onCancellationRequested(() => abortController.abort());

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

					onProgress: (_message) => {
						// Progress shown in notification
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

					signal: abortController.signal,
				});
			},
		);

		// Refresh model registries across all conversations
		for (const conv of state.conversations.values()) {
			conv.session.modelRegistry.refresh();
		}
		updateStatusBar();

		const authPath = join(getAgentDir(), "auth.json");
		state.pendingSessionStatus = `**Logged in to ${providerName}** · Credentials saved to \`${authPath}\``;
		vscode.window.showInformationMessage(`Logged in to ${providerName}`);
	} catch (err) {
		const errorMsg = err instanceof Error ? err.message : String(err);
		if (errorMsg !== "Login cancelled") {
			vscode.window.showErrorMessage(`Failed to login to ${providerName}: ${errorMsg}`);
		}
	}
}

// ── Logout ───────────────────────────────────────────────────────────────────

export async function cmdLogout(): Promise<void> {
	const authStorage = AuthStorage.create();
	const providers = getOAuthProviders();

	const loggedInProviders = providers.filter((p) => {
		const cred = authStorage.get(p.id);
		return cred?.type === "oauth";
	});

	if (loggedInProviders.length === 0) {
		vscode.window.showInformationMessage("No OAuth providers are currently logged in.");
		return;
	}

	const items = loggedInProviders.map((p) => ({
		label: p.name,
		providerId: p.id,
	}));

	const selected = await vscode.window.showQuickPick(items, {
		placeHolder: "Select a provider to logout",
	});

	if (!selected) return;

	try {
		authStorage.logout(selected.providerId);

		// Refresh model registries across all conversations
		for (const conv of state.conversations.values()) {
			conv.session.modelRegistry.refresh();
		}
		updateStatusBar();

		state.pendingSessionStatus = `**Logged out of ${selected.label}**`;
		vscode.window.showInformationMessage(`Logged out of ${selected.label}`);
	} catch (err) {
		const errorMsg = err instanceof Error ? err.message : String(err);
		vscode.window.showErrorMessage(`Failed to logout: ${errorMsg}`);
	}
}

// ── Quick Actions (Context Menu) ─────────────────────────────────────────────

/**
 * Get the current text selection from the active editor.
 * Returns the selected text and file info, or null if no selection.
 */
function getEditorSelection(): { text: string; fileName: string; languageId: string; startLine: number } | null {
	const editor = vscode.window.activeTextEditor;
	if (!editor) return null;

	const selection = editor.selection;
	if (selection.isEmpty) return null;

	const text = editor.document.getText(selection);
	if (!text.trim()) return null;

	return {
		text,
		fileName: vscode.workspace.asRelativePath(editor.document.uri),
		languageId: editor.document.languageId,
		startLine: selection.start.line + 1,
	};
}

/**
 * Open chat with a specific prompt and the selected code.
 */
async function openChatWithSelection(prompt: string): Promise<void> {
	const selection = getEditorSelection();
	if (!selection) {
		vscode.window.showWarningMessage("No text selected. Select some code first.");
		return;
	}

	const codeBlock = `\`\`\`${selection.languageId}\n${selection.text}\n\`\`\``;
	const context = `File: \`${selection.fileName}\` (line ${selection.startLine})\n\n${codeBlock}`;
	const fullQuery = `@piagent ${prompt}\n\n${context}`;

	await vscode.commands.executeCommand("workbench.action.chat.open", {
		query: fullQuery,
		isPartialQuery: false,
	});
}

/** Quick action configuration */
interface QuickActionConfig {
	enabled: boolean;
	prompt: string;
}

/** Default prompts for quick actions */
const defaultPrompts: Record<string, string> = {
	explainCode: "Explain this code clearly and concisely:",
	refactorCode: "Refactor this code to improve readability, performance, or maintainability:",
	writeTests: "Write comprehensive unit tests for this code:",
	findBugs: "Analyze this code for potential bugs, edge cases, and issues:",
	addDocs: "Add clear documentation and comments to this code:",
	optimizeCode: "Optimize this code for better performance:",
};

/**
 * Get quick action config from settings.
 */
export function getQuickActionConfig(action: string): QuickActionConfig {
	const config = vscode.workspace.getConfiguration("piagent");
	const quickActions = config.get<Record<string, QuickActionConfig>>("quickActions", {});
	const actionConfig = quickActions[action];
	
	return {
		enabled: actionConfig?.enabled ?? true,
		prompt: actionConfig?.prompt || defaultPrompts[action] || "",
	};
}

/** Explain the selected code */
export async function cmdExplainCode(): Promise<void> {
	const config = getQuickActionConfig("explainCode");
	await openChatWithSelection(config.prompt);
}

/** Refactor the selected code */
export async function cmdRefactorCode(): Promise<void> {
	const config = getQuickActionConfig("refactorCode");
	await openChatWithSelection(config.prompt);
}

/** Write tests for the selected code */
export async function cmdWriteTests(): Promise<void> {
	const config = getQuickActionConfig("writeTests");
	await openChatWithSelection(config.prompt);
}

/** Find bugs in the selected code */
export async function cmdFindBugs(): Promise<void> {
	const config = getQuickActionConfig("findBugs");
	await openChatWithSelection(config.prompt);
}

/** Add documentation/comments to the selected code */
export async function cmdAddDocs(): Promise<void> {
	const config = getQuickActionConfig("addDocs");
	await openChatWithSelection(config.prompt);
}

/** Optimize the selected code */
export async function cmdOptimizeCode(): Promise<void> {
	const config = getQuickActionConfig("optimizeCode");
	await openChatWithSelection(config.prompt);
}
