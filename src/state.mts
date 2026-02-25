/**
 * Shared mutable state for the extension.
 *
 * Exported as a single object so every module that imports `state` reads and
 * writes the same reference — no setter functions needed, no ESM live-binding
 * gotchas.
 */

import type { AgentSession } from "@mariozechner/pi-coding-agent";
import * as vscode from "vscode";

export interface ExtensionState {
	// ── Core extension plumbing ──────────────────────────────────────────
	outputChannel: vscode.OutputChannel;
	extensionContext: vscode.ExtensionContext;

	// ── Session ──────────────────────────────────────────────────────────
	currentSession: AgentSession | undefined;
	currentWorkspaceFolder: string | undefined;

	// ── Active response stream ───────────────────────────────────────────
	//
	// Events from the agent session are routed to whichever ChatResponseStream
	// is currently active.  When the user sends a new message while the agent
	// is streaming, the stream is swapped so output flows into the latest chat
	// bubble.
	activeResponse: vscode.ChatResponseStream | undefined;
	activeToolCalls: Map<string, { name: string; args: string }>;
	sessionUnsubscribe: (() => void) | undefined;

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
	currentSession: undefined,
	currentWorkspaceFolder: undefined,
	activeResponse: undefined,
	activeToolCalls: new Map(),
	sessionUnsubscribe: undefined,
	pendingSessionStatus: undefined,
};

/** Clean up the global event subscription when switching / replacing sessions. */
export function cleanupSessionSubscription(): void {
	if (state.sessionUnsubscribe) {
		state.sessionUnsubscribe();
		state.sessionUnsubscribe = undefined;
	}
	state.activeResponse = undefined;
	state.activeToolCalls = new Map();
}
