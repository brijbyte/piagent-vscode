import type { Api, Model, OAuthProviderId } from "@mariozechner/pi-ai";
import { getOAuthProviders } from "@mariozechner/pi-ai";
import {
	type AgentSession,
	type AgentSessionEvent,
	AuthStorage,
	createAgentSession,
	getAgentDir,
	ModelRegistry,
	type SessionInfo,
	SessionManager,
	SettingsManager,
} from "@mariozechner/pi-coding-agent";
import { join } from "path";
import * as vscode from "vscode";

let outputChannel: vscode.OutputChannel;
let currentSession: AgentSession | undefined;
let currentWorkspaceFolder: string | undefined;
let statusBarItem: vscode.StatusBarItem;

// Pending status to show in next chat response
let pendingSessionStatus: string | undefined;

export function activate(context: vscode.ExtensionContext) {
	outputChannel = vscode.window.createOutputChannel("PiAgent");
	outputChannel.appendLine("PiAgent extension activated");

	// Create status bar item
	statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	statusBarItem.command = "piagent.selectModel";
	statusBarItem.tooltip = "Click to change PiAgent model";
	updateStatusBar();

	// Register chat participant
	const participant = vscode.chat.createChatParticipant("piagent.agent", handleChatRequest);
	participant.iconPath = vscode.Uri.joinPath(context.extensionUri, "media", "icon.png");

	context.subscriptions.push(
		participant,
		outputChannel,
		statusBarItem,
		vscode.commands.registerCommand("piagent.newSession", cmdNewSession),
		vscode.commands.registerCommand("piagent.resumeSession", cmdResumeSession),
		vscode.commands.registerCommand("piagent.selectModel", cmdSelectModel),
		vscode.commands.registerCommand("piagent.login", cmdLogin),
		vscode.commands.registerCommand("piagent.logout", cmdLogout),
	);

	outputChannel.appendLine("Chat participant registered: piagent.agent");
}

export function deactivate() {
	outputChannel?.appendLine("PiAgent extension deactivated");
	currentSession = undefined;
}

// ============================================================================
// Status Bar
// ============================================================================

function updateStatusBar(): void {
	if (currentSession?.model) {
		const model = currentSession.model;
		statusBarItem.text = `$(robot) ${model.id}`;
		statusBarItem.show();
	} else {
		statusBarItem.text = "$(robot) PiAgent: No model";
		statusBarItem.show();
	}
}

// ============================================================================
// Chat Participant Handler
// ============================================================================

async function handleChatRequest(
	request: vscode.ChatRequest,
	_context: vscode.ChatContext,
	response: vscode.ChatResponseStream,
	token: vscode.CancellationToken,
): Promise<vscode.ChatResult> {
	const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
	outputChannel.appendLine(
		`Chat request received: command="${request.command ?? ""}" prompt="${request.prompt.slice(0, 50)}..."`,
	);

	// Handle slash commands
	if (request.command) {
		return handleSlashCommand(request.command, request.prompt, response, workspaceFolder);
	}

	// Show any pending session status from commands
	if (pendingSessionStatus) {
		response.markdown(`> ${pendingSessionStatus}\n\n`);
		pendingSessionStatus = undefined;
	}

	// Initialize session if needed
	if (!currentSession) {
		try {
			response.progress("Initializing PiAgent...");
			const result = await initSession(workspaceFolder);
			currentSession = result.session;
			currentWorkspaceFolder = workspaceFolder;
			updateStatusBar();
			response.markdown(`> **New session started** · ${result.model}\n\n`);
		} catch (err) {
			const errorMsg = err instanceof Error ? err.message : String(err);
			outputChannel.appendLine(`Error initializing session: ${errorMsg}`);
			response.markdown(`**Error initializing session:** ${errorMsg}`);
			return { metadata: { error: true } };
		}
	}

	// Handle cancellation
	let aborted = false;
	token.onCancellationRequested(() => {
		aborted = true;
		currentSession?.abort();
		outputChannel.appendLine("Request cancelled by user");
	});

	// Track streaming state
	const toolCallsInProgress = new Map<string, { name: string; args: string }>();

	// Subscribe to session events
	const unsubscribe = currentSession.subscribe((event: AgentSessionEvent) => {
		handleSessionEvent(event, response, toolCallsInProgress);
	});

	try {
		// Send prompt to agent
		await currentSession.prompt(request.prompt);
		outputChannel.appendLine("Prompt completed successfully");
		return { metadata: { success: true } };
	} catch (err) {
		if (aborted) {
			response.markdown("\n\n*Request cancelled*");
			return { metadata: { cancelled: true } };
		}
		const errorMsg = err instanceof Error ? err.message : String(err);
		outputChannel.appendLine(`Error during prompt: ${errorMsg}`);
		response.markdown(`\n\n**Error:** ${errorMsg}`);
		return { metadata: { error: true } };
	} finally {
		unsubscribe();
	}
}

// ============================================================================
// Slash Command Handling
// ============================================================================

async function handleSlashCommand(
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

async function slashNew(response: vscode.ChatResponseStream, workspaceFolder: string): Promise<vscode.ChatResult> {
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

		currentSession = session;
		currentWorkspaceFolder = workspaceFolder;
		updateStatusBar();
		const model = session.model ? `${session.model.provider}/${session.model.id}` : "no model";
		response.markdown(`> **New session started** · ${model}`);
		outputChannel.appendLine("New session started via /new");
		return { metadata: { success: true } };
	} catch (err) {
		const errorMsg = err instanceof Error ? err.message : String(err);
		response.markdown(`**Error:** ${errorMsg}`);
		return { metadata: { error: true } };
	}
}

async function slashResume(response: vscode.ChatResponseStream, workspaceFolder: string): Promise<vscode.ChatResult> {
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

		currentSession = session;
		currentWorkspaceFolder = workspaceFolder;
		updateStatusBar();
		const model = session.model ? `${session.model.provider}/${session.model.id}` : "no model";
		let status = `> **Resumed session** · ${selected.label} · ${selected.messageCount} messages · ${model}`;
		if (modelFallbackMessage) {
			status += `\n> ⚠️ ${modelFallbackMessage}`;
		}
		response.markdown(status);
		outputChannel.appendLine(`Resumed session via /resume: ${selected.sessionPath}`);
		return { metadata: { success: true } };
	} catch (err) {
		const errorMsg = err instanceof Error ? err.message : String(err);
		response.markdown(`**Error:** ${errorMsg}`);
		return { metadata: { error: true } };
	}
}

async function slashModel(response: vscode.ChatResponseStream): Promise<vscode.ChatResult> {
	if (!currentSession) {
		response.markdown("No active session. Send a message first to initialize.");
		return { metadata: { error: true } };
	}

	try {
		const models: Model<Api>[] = currentSession.modelRegistry.getAvailable();

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
		const currentModelId = currentSession.model?.id;
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

		await currentSession.setModel(selected.model);
		updateStatusBar();
		response.markdown(`> **Model changed** · ${selected.model.provider}/${selected.model.id}`);
		outputChannel.appendLine(`Model changed via /model to ${selected.model.provider}/${selected.model.id}`);
		return { metadata: { success: true } };
	} catch (err) {
		const errorMsg = err instanceof Error ? err.message : String(err);
		response.markdown(`**Error:** ${errorMsg}`);
		return { metadata: { error: true } };
	}
}

async function slashCompact(response: vscode.ChatResponseStream): Promise<vscode.ChatResult> {
	if (!currentSession) {
		response.markdown("No active session. Send a message first to initialize.");
		return { metadata: { error: true } };
	}

	try {
		response.progress("Compacting session context...");
		await currentSession.compact();
		response.markdown("> **Session compacted**");
		outputChannel.appendLine("Session compacted via /compact");
		return { metadata: { success: true } };
	} catch (err) {
		const errorMsg = err instanceof Error ? err.message : String(err);
		response.markdown(`**Error:** ${errorMsg}`);
		return { metadata: { error: true } };
	}
}

async function slashSession(response: vscode.ChatResponseStream): Promise<vscode.ChatResult> {
	if (!currentSession) {
		response.markdown("No active session. Send a message first to initialize.");
		return { metadata: { error: true } };
	}

	const model = currentSession.model ? `${currentSession.model.provider}/${currentSession.model.id}` : "no model";
	const messageCount = currentSession.messages.length;
	const sessionId = currentSession.sessionManager.getSessionId();

	let info = `## Session Info\n\n`;
	info += `- **Session ID:** \`${sessionId}\`\n`;
	info += `- **Model:** ${model}\n`;
	info += `- **Messages:** ${messageCount}\n`;
	info += `- **Working directory:** \`${currentWorkspaceFolder ?? "unknown"}\`\n`;

	response.markdown(info);
	return { metadata: { success: true } };
}

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
		outputChannel.appendLine(`Starting OAuth login for ${providerName}`);

		await authStorage.login(providerId as OAuthProviderId, {
			onAuth: (info) => {
				// Open browser automatically
				vscode.env.openExternal(vscode.Uri.parse(info.url));
				outputChannel.appendLine(`OAuth: opened browser for ${info.url}`);

				if (info.instructions) {
					outputChannel.appendLine(`OAuth instructions: ${info.instructions}`);
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
				outputChannel.appendLine(`OAuth progress: ${message}`);
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
		if (currentSession) {
			currentSession.modelRegistry.refresh();
		}

		const authPath = join(getAgentDir(), "auth.json");
		response.markdown(`> **Logged in to ${providerName}**\n>\n> Credentials saved to \`${authPath}\``);
		outputChannel.appendLine(`Successfully logged in to ${providerName}`);
		return { metadata: { success: true } };
	} catch (err) {
		const errorMsg = err instanceof Error ? err.message : String(err);
		if (errorMsg === "Login cancelled") {
			response.markdown("Login cancelled.");
			return { metadata: { cancelled: true } };
		}
		outputChannel.appendLine(`Login failed for ${providerName}: ${errorMsg}`);
		response.markdown(`**Error logging in to ${providerName}:** ${errorMsg}`);
		return { metadata: { error: true } };
	}
}

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
		if (currentSession) {
			currentSession.modelRegistry.refresh();
			updateStatusBar();
		}

		response.markdown(`> **Logged out of ${selected.label}**`);
		outputChannel.appendLine(`Logged out of ${selected.label}`);
		return { metadata: { success: true } };
	} catch (err) {
		const errorMsg = err instanceof Error ? err.message : String(err);
		response.markdown(`**Error logging out of ${selected.label}:** ${errorMsg}`);
		return { metadata: { error: true } };
	}
}

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

// ============================================================================
// Event Handling
// ============================================================================

function handleSessionEvent(
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
			response.markdown(`\n\n**Tool:** \`${toolName}\`\n`);
			outputChannel.appendLine(`[Tool Start] ${toolName}: ${JSON.stringify(args)}`);
			break;
		}

		case "tool_execution_update": {
			const { partialResult } = event;
			if (partialResult?.content) {
				for (const block of partialResult.content) {
					if (block.type === "text") {
						outputChannel.append(block.text);
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

			outputChannel.appendLine(`[Tool End] ${toolName}: ${isError ? "ERROR" : "OK"}`);
			outputChannel.appendLine(resultText);
			outputChannel.appendLine("");
			break;
		}

		case "auto_compaction_start": {
			response.progress(`Compacting context (${event.reason})...`);
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

// ============================================================================
// Session Management
// ============================================================================

interface InitSessionResult {
	session: AgentSession;
	model: string;
}

async function initSession(cwd: string): Promise<InitSessionResult> {
	const authStorage = AuthStorage.create();
	const modelRegistry = new ModelRegistry(authStorage);
	const settingsManager = SettingsManager.create(cwd);
	const sessionManager = SessionManager.create(cwd);

	const { session, modelFallbackMessage } = await createAgentSession({
		cwd,
		authStorage,
		modelRegistry,
		settingsManager,
		sessionManager,
	});

	if (modelFallbackMessage) {
		outputChannel.appendLine(`Model fallback: ${modelFallbackMessage}`);
	}

	const model = session.model ? `${session.model.provider}/${session.model.id}` : "no model";
	outputChannel.appendLine(`Session initialized in ${cwd}`);
	outputChannel.appendLine(`Model: ${model}`);

	return { session, model };
}

// ============================================================================
// Commands
// ============================================================================

async function cmdNewSession(): Promise<void> {
	const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();

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

		currentSession = session;
		updateStatusBar();
		const model = session.model ? `${session.model.provider}/${session.model.id}` : "no model";
		pendingSessionStatus = `**New session started** · ${model}`;
		outputChannel.appendLine("New session started");
	} catch (err) {
		const errorMsg = err instanceof Error ? err.message : String(err);
		vscode.window.showErrorMessage(`Failed to create session: ${errorMsg}`);
		outputChannel.appendLine(`Failed to create session: ${errorMsg}`);
	}
}

async function cmdResumeSession(): Promise<void> {
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

		const { session, modelFallbackMessage } = await createAgentSession({
			cwd: workspaceFolder,
			authStorage,
			modelRegistry,
			settingsManager,
			sessionManager,
		});

		currentSession = session;
		updateStatusBar();
		const model = session.model ? `${session.model.provider}/${session.model.id}` : "no model";
		const messageCount = sessions.find((s) => s.path === selected.sessionPath)?.messageCount ?? 0;
		pendingSessionStatus = `**Resumed session** · ${selected.label} · ${messageCount} messages · ${model}`;

		if (modelFallbackMessage) {
			pendingSessionStatus += ` · ⚠️ ${modelFallbackMessage}`;
		}

		outputChannel.appendLine(`Resumed session: ${selected.sessionPath}`);
	} catch (err) {
		const errorMsg = err instanceof Error ? err.message : String(err);
		vscode.window.showErrorMessage(`Failed to resume session: ${errorMsg}`);
		outputChannel.appendLine(`Failed to resume session: ${errorMsg}`);
	}
}

interface ModelQuickPickItem extends vscode.QuickPickItem {
	model?: Model<Api>;
}

async function cmdSelectModel(): Promise<void> {
	if (!currentSession) {
		vscode.window.showWarningMessage("No active session. Send a message first or resume a session.");
		return;
	}

	try {
		const models: Model<Api>[] = currentSession.modelRegistry.getAvailable();

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
		const currentModelId = currentSession.model?.id;

		// Sort providers alphabetically
		const sortedProviders = Array.from(modelsByProvider.keys()).sort();

		for (const provider of sortedProviders) {
			// Add separator for provider
			items.push({
				label: provider,
				kind: vscode.QuickPickItemKind.Separator,
			});

			// Add models for this provider
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

		await currentSession.setModel(selected.model);
		updateStatusBar();
		pendingSessionStatus = `**Model changed** · ${selected.model.provider}/${selected.model.id}`;
		outputChannel.appendLine(`Model changed to ${selected.model.provider}/${selected.model.id}`);
	} catch (err) {
		const errorMsg = err instanceof Error ? err.message : String(err);
		vscode.window.showErrorMessage(`Failed to select model: ${errorMsg}`);
		outputChannel.appendLine(`Failed to select model: ${errorMsg}`);
	}
}

async function cmdLogin(): Promise<void> {
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
						outputChannel.appendLine(`OAuth: opened browser for ${info.url}`);
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
						outputChannel.appendLine(`OAuth progress: ${message}`);
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

					signal: abortController.signal,
				});
			},
		);

		// Refresh model registry if session exists
		if (currentSession) {
			currentSession.modelRegistry.refresh();
			updateStatusBar();
		}

		const authPath = join(getAgentDir(), "auth.json");
		pendingSessionStatus = `**Logged in to ${providerName}** · Credentials saved to \`${authPath}\``;
		vscode.window.showInformationMessage(`Logged in to ${providerName}`);
		outputChannel.appendLine(`Successfully logged in to ${providerName}`);
	} catch (err) {
		const errorMsg = err instanceof Error ? err.message : String(err);
		if (errorMsg !== "Login cancelled") {
			vscode.window.showErrorMessage(`Failed to login to ${providerName}: ${errorMsg}`);
			outputChannel.appendLine(`Login failed for ${providerName}: ${errorMsg}`);
		}
	}
}

async function cmdLogout(): Promise<void> {
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

		if (currentSession) {
			currentSession.modelRegistry.refresh();
			updateStatusBar();
		}

		pendingSessionStatus = `**Logged out of ${selected.label}**`;
		vscode.window.showInformationMessage(`Logged out of ${selected.label}`);
		outputChannel.appendLine(`Logged out of ${selected.label}`);
	} catch (err) {
		const errorMsg = err instanceof Error ? err.message : String(err);
		vscode.window.showErrorMessage(`Failed to logout: ${errorMsg}`);
		outputChannel.appendLine(`Logout failed: ${errorMsg}`);
	}
}
