/**
 * VSCode Chat Participant request handler.
 *
 * Routes incoming chat requests to slash-command handlers or the agent session.
 * Each VSCode chat tab gets its own AgentSession (conversation). The
 * conversation ID is stashed in ChatResult.metadata and recovered from
 * ChatContext.history on subsequent requests in the same tab.
 */

import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import * as vscode from "vscode";
import { handleSessionEvent } from "./event-handler.mjs";
import { resolveReferences } from "./references.mjs";
import { handleSlashCommand } from "./slash-commands.mjs";
import { initSession } from "./session.mjs";
import { updateStatusBar } from "./status-bar.mjs";
import {
	getConversationIdFromHistory,
	newConversationId,
	state,
} from "./state.mjs";

export async function handleChatRequest(
	request: vscode.ChatRequest,
	context: vscode.ChatContext,
	response: vscode.ChatResponseStream,
	token: vscode.CancellationToken,
): Promise<vscode.ChatResult> {
	const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();

	// Recover or generate a conversation ID for this chat tab
	let conversationId = getConversationIdFromHistory(context);
	const isNewConversation = !conversationId || !state.conversations.has(conversationId);

	if (!conversationId) {
		conversationId = newConversationId();
	}

	// Track this as the active conversation (for status bar, command palette)
	state.activeConversationId = conversationId;

	// Handle slash commands — pass the conversation ID so they can find/create sessions
	if (request.command) {
		return handleSlashCommand(
			request.command,
			request.prompt,
			response,
			workspaceFolder,
			conversationId,
		);
	}

	// Show any pending session status from command-palette commands
	if (state.pendingSessionStatus) {
		response.markdown(`> ${state.pendingSessionStatus}\n\n`);
		state.pendingSessionStatus = undefined;
	}

	// Get or create the conversation for this chat tab
	let conv = state.conversations.get(conversationId);

	if (!conv) {
		try {
			response.progress("Initializing PiAgent...");
			const result = await initSession(workspaceFolder);

			conv = {
				id: conversationId,
				session: result.session,
				workspaceFolder,
				activeResponse: undefined,
				activeToolCalls: new Map(),
				sessionUnsubscribe: undefined,
				lastPrompt: undefined,
			};
			state.conversations.set(conversationId, conv);

			updateStatusBar();
			response.markdown(`> **New session started** · ${result.model}\n\n`);
		} catch (err) {
			const errorMsg = err instanceof Error ? err.message : String(err);
			response.markdown(`**Error initializing session:** ${errorMsg}`);
			return { metadata: { conversationId, error: true } };
		}
	}

	const session = conv.session;

	// Resolve attached references (files, selections, etc.) into text + images
	const { contextText, images } = await resolveReferences(
		request.references,
		workspaceFolder,
	);

	// Build the full prompt: attached context (if any) + user text
	const fullPrompt = contextText
		? `${contextText}\n\n${request.prompt}`
		: request.prompt;

	const promptOptions = images.length > 0 ? { images } : undefined;

	// If the agent is already streaming, queue the message as a follow-up and
	// redirect future events to this new response stream so the user sees output.
	if (session.isStreaming) {
		conv.activeResponse = response;
		conv.activeToolCalls = new Map();
		await session.prompt(fullPrompt, { ...promptOptions, streamingBehavior: "followUp" });
		const queuedCount = session.pendingMessageCount;
		response.markdown(
			`> **Queued** · message will be sent after the current response completes (${queuedCount} in queue)\n\n`,
		);

		// Wait for the agent to finish (including our queued follow-up).
		// This keeps the response stream alive so events can render into it.
		return new Promise<vscode.ChatResult>((resolve) => {
			const checkDone = () => {
				if (!session.isStreaming) {
					resolve({ metadata: { conversationId, success: true } });
				} else {
					setTimeout(checkDone, 100);
				}
			};
			token.onCancellationRequested(() => {
				if (conv!.activeResponse === response) {
					conv!.activeResponse = undefined;
				}
				resolve({ metadata: { conversationId, cancelled: true } });
			});
			checkDone();
		});
	}

	// This is the primary request — set up the response stream and subscribe.
	conv.activeResponse = response;
	conv.activeToolCalls = new Map();

	// Ensure a single subscription per conversation.
	if (conv.sessionUnsubscribe) {
		conv.sessionUnsubscribe();
	}
	conv.sessionUnsubscribe = session.subscribe((event: AgentSessionEvent) => {
		if (!conv!.activeResponse) return;
		handleSessionEvent(event, conv!.activeResponse, conv!.activeToolCalls);
	});

	token.onCancellationRequested(() => {
		if (conv!.activeResponse === response) {
			conv!.activeResponse = undefined;
		}
	});

	try {
		// Save the prompt for /retry support
		conv.lastPrompt = fullPrompt;
		await session.prompt(fullPrompt, promptOptions);
		return { metadata: { conversationId, success: true } };
	} catch (err) {
		const errorMsg = err instanceof Error ? err.message : String(err);
		if (conv.activeResponse === response) {
			response.markdown(`\n\n**Error:** ${errorMsg}`);
		}
		return { metadata: { conversationId, error: true } };
	} finally {
		if (conv.activeResponse === response) {
			conv.activeResponse = undefined;
		}
	}
}
