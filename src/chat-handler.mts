/**
 * VSCode Chat Participant request handler.
 *
 * Routes incoming chat requests to slash-command handlers or the agent session.
 * Manages the global response-stream swapping so events always flow to the
 * latest chat bubble, even when the user sends follow-up messages while the
 * agent is still streaming.
 */

import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import * as vscode from "vscode";
import { handleSessionEvent } from "./event-handler.mjs";
import { handleSlashCommand } from "./slash-commands.mjs";
import { initSession } from "./session.mjs";
import { updateStatusBar } from "./status-bar.mjs";
import { cleanupSessionSubscription, state } from "./state.mjs";

export async function handleChatRequest(
	request: vscode.ChatRequest,
	_context: vscode.ChatContext,
	response: vscode.ChatResponseStream,
	token: vscode.CancellationToken,
): Promise<vscode.ChatResult> {
	const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
	state.outputChannel.appendLine(
		`Chat request received: command="${request.command ?? ""}" prompt="${request.prompt.slice(0, 50)}..."`,
	);

	// Handle slash commands
	if (request.command) {
		return handleSlashCommand(request.command, request.prompt, response, workspaceFolder);
	}

	// Show any pending session status from commands
	if (state.pendingSessionStatus) {
		response.markdown(`> ${state.pendingSessionStatus}\n\n`);
		state.pendingSessionStatus = undefined;
	}

	// Initialize session if needed
	if (!state.currentSession) {
		try {
			response.progress("Initializing PiAgent...");
			const result = await initSession(workspaceFolder);
			cleanupSessionSubscription();
			state.currentSession = result.session;
			state.currentWorkspaceFolder = workspaceFolder;
			updateStatusBar();
			response.markdown(`> **New session started** · ${result.model}\n\n`);
		} catch (err) {
			const errorMsg = err instanceof Error ? err.message : String(err);
			state.outputChannel.appendLine(`Error initializing session: ${errorMsg}`);
			response.markdown(`**Error initializing session:** ${errorMsg}`);
			return { metadata: { error: true } };
		}
	}

	const session = state.currentSession!;

	// If the agent is already streaming, queue the message as a follow-up and
	// redirect future events to this new response stream so the user sees output.
	if (session.isStreaming) {
		state.activeResponse = response;
		state.activeToolCalls = new Map();
		await session.prompt(request.prompt, { streamingBehavior: "followUp" });
		const queuedCount = session.pendingMessageCount;
		response.markdown(
			`> **Queued** · message will be sent after the current response completes (${queuedCount} in queue)\n\n`,
		);
		state.outputChannel.appendLine(
			`Message queued as follow-up (${queuedCount} in queue): "${request.prompt.slice(0, 50)}..."`,
		);

		// Wait for the agent to finish (including our queued follow-up).
		// This keeps the response stream alive so events can render into it.
		return new Promise<vscode.ChatResult>((resolve) => {
			const checkDone = () => {
				if (!state.currentSession?.isStreaming) {
					resolve({ metadata: { success: true } });
				} else {
					setTimeout(checkDone, 100);
				}
			};
			token.onCancellationRequested(() => {
				// New message came in while we're waiting — detach from this stream
				if (state.activeResponse === response) {
					state.activeResponse = undefined;
				}
				resolve({ metadata: { cancelled: true } });
			});
			checkDone();
		});
	}

	// This is the primary request — set up the global response stream and subscribe.
	state.activeResponse = response;
	state.activeToolCalls = new Map();

	// Ensure a single global subscription to session events.
	// If one already exists (shouldn't happen since isStreaming was false), clean it up.
	if (state.sessionUnsubscribe) {
		state.sessionUnsubscribe();
	}
	state.sessionUnsubscribe = session.subscribe((event: AgentSessionEvent) => {
		if (!state.activeResponse) return;
		handleSessionEvent(event, state.activeResponse, state.activeToolCalls);
	});

	token.onCancellationRequested(() => {
		// VSCode cancelled this request (user sent a new message).
		// Don't abort the session — just detach from this response stream.
		// The new request handler will attach the new response stream.
		if (state.activeResponse === response) {
			state.activeResponse = undefined;
		}
		state.outputChannel.appendLine(
			"Response stream closed by VSCode (user sent a new message or cancelled)",
		);
	});

	try {
		// Send prompt to agent — this awaits the full turn including tool calls and follow-ups
		await session.prompt(request.prompt);
		state.outputChannel.appendLine("Prompt completed successfully");
		return { metadata: { success: true } };
	} catch (err) {
		const errorMsg = err instanceof Error ? err.message : String(err);
		state.outputChannel.appendLine(`Error during prompt: ${errorMsg}`);
		if (state.activeResponse === response) {
			response.markdown(`\n\n**Error:** ${errorMsg}`);
		}
		return { metadata: { error: true } };
	} finally {
		// Only clean up the subscription if this response is still the active one.
		// If a newer request took over, it owns the subscription now.
		if (state.activeResponse === response) {
			state.activeResponse = undefined;
		}
	}
}
