/**
 * Shared mutable state for the extension.
 *
 * Exported as a single object so every module that imports `state` reads and
 * writes the same reference — no setter functions needed, no ESM live-binding
 * gotchas.
 */

import type { AgentSession } from "@mariozechner/pi-coding-agent";
import * as vscode from "vscode";

// ── Per-conversation state ───────────────────────────────────────────────────

/**
 * Each VSCode chat tab gets its own ChatConversation, keyed by a generated
 * conversation ID that's stashed in ChatResult.metadata and recovered from
 * ChatContext.history on subsequent requests.
 */
export interface ChatConversation {
	id: string;
	session: AgentSession;
	workspaceFolder: string;
	activeResponse: vscode.ChatResponseStream | undefined;
	activeToolCalls: Map<string, { name: string; args: string }>;
	sessionUnsubscribe: (() => void) | undefined;
}

// ── Global extension state ───────────────────────────────────────────────────

export interface ExtensionState {
	// ── Core extension plumbing ──────────────────────────────────────────
	outputChannel: vscode.OutputChannel;
	extensionContext: vscode.ExtensionContext;

	// ── Conversations ────────────────────────────────────────────────────
	/** All active chat conversations, keyed by conversation ID. */
	conversations: Map<string, ChatConversation>;

	/**
	 * The conversation that most recently handled a request.
	 * Used by status bar and command-palette commands that need "the current session".
	 */
	activeConversationId: string | undefined;

	// ── Pending status ───────────────────────────────────────────────────
	//
	// Command-palette commands can't write to a ChatResponseStream directly
	// (they run outside of a chat request).  They stash a status string here
	// and the next handleChatRequest picks it up.
	pendingSessionStatus: string | undefined;
}

/**
 * The single mutable state object shared across all modules.
 *
 * `outputChannel` and `extensionContext` are set in `activate()` before
 * anything else runs, so the `as unknown as ExtensionState` cast is safe.
 */
export const state: ExtensionState = {
	outputChannel: undefined as unknown as vscode.OutputChannel,
	extensionContext: undefined as unknown as vscode.ExtensionContext,
	conversations: new Map(),
	activeConversationId: undefined,
	pendingSessionStatus: undefined,
};

// ── Convenience accessors ────────────────────────────────────────────────────

/** Get the currently active conversation (the one last used). */
export function getActiveConversation(): ChatConversation | undefined {
	if (!state.activeConversationId) return undefined;
	return state.conversations.get(state.activeConversationId);
}

/** Shorthand: get the AgentSession from the active conversation. */
export function getActiveSession(): AgentSession | undefined {
	return getActiveConversation()?.session;
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

/**
 * Clean up the event subscription for a specific conversation.
 */
export function cleanupConversationSubscription(conv: ChatConversation): void {
	if (conv.sessionUnsubscribe) {
		conv.sessionUnsubscribe();
		conv.sessionUnsubscribe = undefined;
	}
	conv.activeResponse = undefined;
	conv.activeToolCalls = new Map();
}

/**
 * Remove a conversation entirely.
 */
export function removeConversation(id: string): void {
	const conv = state.conversations.get(id);
	if (conv) {
		cleanupConversationSubscription(conv);
		state.conversations.delete(id);
		if (state.activeConversationId === id) {
			state.activeConversationId = undefined;
		}
	}
}

// ── Conversation ID extraction ───────────────────────────────────────────────

/**
 * Extract the conversation ID from the chat context history.
 *
 * We stash `{ conversationId }` in ChatResult.metadata on every response.
 * On subsequent requests in the same tab, VSCode replays the history so we
 * can recover the ID.
 */
export function getConversationIdFromHistory(
	context: vscode.ChatContext,
): string | undefined {
	// Walk history in reverse — latest response is most reliable
	for (let i = context.history.length - 1; i >= 0; i--) {
		const turn = context.history[i];
		if (turn instanceof vscode.ChatResponseTurn) {
			const meta = turn.result?.metadata;
			if (meta && typeof meta.conversationId === "string") {
				return meta.conversationId;
			}
		}
	}
	return undefined;
}

/** Generate a new unique conversation ID. */
export function newConversationId(): string {
	return `conv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
