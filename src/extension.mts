import type { Api, Model, OAuthProviderId } from "@mariozechner/pi-ai";
import { getOAuthProviders } from "@mariozechner/pi-ai";
import {
	type AgentSession,
	type AgentSessionEvent,
	type ContextUsage,
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
let statusBarItem: vscode.StatusBarItem | undefined;
let extensionContext: vscode.ExtensionContext;

// Active response stream — events are routed to whichever stream is current.
// When a new request comes in, we swap the stream so events flow to the latest bubble.
let activeResponse: vscode.ChatResponseStream | undefined;
let activeToolCalls: Map<string, { name: string; args: string }> = new Map();
let sessionUnsubscribe: (() => void) | undefined;

// Pending status to show in next chat response
let pendingSessionStatus: string | undefined;

export function activate(context: vscode.ExtensionContext) {
	extensionContext = context;
	outputChannel = vscode.window.createOutputChannel("PiAgent");
	outputChannel.appendLine("PiAgent extension activated");

	// Register chat participant
	const participant = vscode.chat.createChatParticipant("piagent.agent", handleChatRequest);
	participant.iconPath = vscode.Uri.joinPath(context.extensionUri, "media", "icon.png");

	context.subscriptions.push(
		participant,
		outputChannel,
		vscode.commands.registerCommand("piagent.newSession", cmdNewSession),
		vscode.commands.registerCommand("piagent.resumeSession", cmdResumeSession),
		vscode.commands.registerCommand("piagent.selectModel", cmdSelectModel),
		vscode.commands.registerCommand("piagent.login", cmdLogin),
		vscode.commands.registerCommand("piagent.logout", cmdLogout),
		// Re-render status bar when the user changes piagent.statusBar.show
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration("piagent.statusBar.show")) {
				updateStatusBar();
			}
		}),
	);

	outputChannel.appendLine("Chat participant registered: piagent.agent");
}

export function deactivate() {
	outputChannel?.appendLine("PiAgent extension deactivated");
	cleanupSessionSubscription();
	currentSession = undefined;
}

/** Clean up the global event subscription when switching/replacing sessions. */
function cleanupSessionSubscription(): void {
	if (sessionUnsubscribe) {
		sessionUnsubscribe();
		sessionUnsubscribe = undefined;
	}
	activeResponse = undefined;
	activeToolCalls = new Map();
}

// ============================================================================
// Status Bar
// ============================================================================

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
type StatusBarItem =
	| "inputTokens"
	| "outputTokens"
	| "cacheRead"
	| "cacheWrite"
	| "cost"
	| "contextUsage";

function getStatusBarItemOrder(): StatusBarItem[] {
	const config = vscode.workspace.getConfiguration("piagent");
	return config.get<StatusBarItem[]>("statusBar.show", [
		"inputTokens",
		"outputTokens",
		"cacheRead",
		"cacheWrite",
		"cost",
		"contextUsage",
	]);
}

function ensureStatusBar(): vscode.StatusBarItem {
	if (!statusBarItem) {
		statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
		statusBarItem.command = "piagent.selectModel";
		statusBarItem.tooltip = "Click to change PiAgent model";
		extensionContext.subscriptions.push(statusBarItem);
	}
	return statusBarItem;
}

function updateStatusBar(): void {
	if (!statusBarItem && !currentSession) {
		// Don't create the status bar until PiAgent has been used
		return;
	}

	const bar = ensureStatusBar();

	if (!currentSession?.model) {
		bar.text = "$(robot) PiAgent: No model";
		bar.tooltip = "Click to change PiAgent model";
		bar.show();
		return;
	}

	const model = currentSession.model;
	const itemOrder = getStatusBarItemOrder();

	// Calculate cumulative usage from ALL session entries
	let totalInput = 0;
	let totalOutput = 0;
	let totalCacheRead = 0;
	let totalCacheWrite = 0;
	let totalCost = 0;

	for (const entry of currentSession.sessionManager.getEntries()) {
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
	const availableParts = new Map<StatusBarItem, string>();

	if (hasUsage) {
		if (totalInput) availableParts.set("inputTokens", `↑${formatTokens(totalInput)}`);
		if (totalOutput) availableParts.set("outputTokens", `↓${formatTokens(totalOutput)}`);
		if (totalCacheRead) availableParts.set("cacheRead", `R${formatTokens(totalCacheRead)}`);
		if (totalCacheWrite) availableParts.set("cacheWrite", `W${formatTokens(totalCacheWrite)}`);

		const usingSubscription = currentSession.modelRegistry.isUsingOAuth(model);
		if (totalCost || usingSubscription) {
			availableParts.set("cost", `$${totalCost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`);
		}
	}

	// Context usage is available even before usage data (shows ?/window)
	const contextUsageData: ContextUsage | undefined = currentSession.getContextUsage();
	const contextWindow = contextUsageData?.contextWindow ?? model.contextWindow ?? 0;
	if (contextWindow > 0) {
		const autoIndicator = currentSession.autoCompactionEnabled ? " (auto)" : "";
		if (contextUsageData?.percent != null) {
			availableParts.set("contextUsage", `${contextUsageData.percent.toFixed(1)}%/${formatTokens(contextWindow)}${autoIndicator}`);
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

		const contextUsage: ContextUsage | undefined = currentSession.getContextUsage();
		if (contextUsage?.percent != null) {
			tooltipLines.push(`Context: ${contextUsage.percent.toFixed(1)}%`);
		}
	}
	tooltipLines.push("");
	tooltipLines.push("Click to change model");

	bar.tooltip = tooltipLines.join("\n");
	bar.show();
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
			cleanupSessionSubscription();
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

	// If the agent is already streaming, queue the message as a follow-up and
	// redirect future events to this new response stream so the user sees output.
	if (currentSession.isStreaming) {
		activeResponse = response;
		activeToolCalls = new Map();
		await currentSession.prompt(request.prompt, { streamingBehavior: "followUp" });
		const queuedCount = currentSession.pendingMessageCount;
		response.markdown(`> **Queued** · message will be sent after the current response completes (${queuedCount} in queue)\n\n`);
		outputChannel.appendLine(`Message queued as follow-up (${queuedCount} in queue): "${request.prompt.slice(0, 50)}..."`);

		// Wait for the agent to finish (including our queued follow-up).
		// This keeps the response stream alive so events can render into it.
		return new Promise<vscode.ChatResult>((resolve) => {
			const checkDone = () => {
				if (!currentSession?.isStreaming) {
					resolve({ metadata: { success: true } });
				} else {
					setTimeout(checkDone, 100);
				}
			};
			token.onCancellationRequested(() => {
				// New message came in while we're waiting — detach from this stream
				if (activeResponse === response) {
					activeResponse = undefined;
				}
				resolve({ metadata: { cancelled: true } });
			});
			checkDone();
		});
	}

	// This is the primary request — set up the global response stream and subscribe.
	activeResponse = response;
	activeToolCalls = new Map();

	// Ensure a single global subscription to session events.
	// If one already exists (shouldn't happen since isStreaming was false), clean it up.
	if (sessionUnsubscribe) {
		sessionUnsubscribe();
	}
	sessionUnsubscribe = currentSession.subscribe((event: AgentSessionEvent) => {
		if (!activeResponse) return;
		handleSessionEvent(event, activeResponse, activeToolCalls);
	});

	token.onCancellationRequested(() => {
		// VSCode cancelled this request (user sent a new message).
		// Don't abort the session — just detach from this response stream.
		// The new request handler will attach the new response stream.
		if (activeResponse === response) {
			activeResponse = undefined;
		}
		outputChannel.appendLine("Response stream closed by VSCode (user sent a new message or cancelled)");
	});

	try {
		// Send prompt to agent — this awaits the full turn including tool calls and follow-ups
		await currentSession.prompt(request.prompt);
		outputChannel.appendLine("Prompt completed successfully");
		return { metadata: { success: true } };
	} catch (err) {
		const errorMsg = err instanceof Error ? err.message : String(err);
		outputChannel.appendLine(`Error during prompt: ${errorMsg}`);
		if (activeResponse === response) {
			response.markdown(`\n\n**Error:** ${errorMsg}`);
		}
		return { metadata: { error: true } };
	} finally {
		// Only clean up the subscription if this response is still the active one.
		// If a newer request took over, it owns the subscription now.
		if (activeResponse === response) {
			activeResponse = undefined;
		}
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

		cleanupSessionSubscription();
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

		cleanupSessionSubscription();
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

		cleanupSessionSubscription();
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

		cleanupSessionSubscription();
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
