/**
 * PiAgent VSCode extension entry point.
 *
 * Registers the chat participant, command palette commands, and configuration
 * listeners.  All logic lives in dedicated modules:
 *
 *   state.mts          – shared mutable state object
 *   session.mts        – session creation helpers
 *   status-bar.mts     – status bar formatting & updates
 *   event-handler.mts  – AgentSessionEvent → ChatResponseStream rendering
 *   chat-handler.mts   – chat participant request handler
 *   slash-commands.mts  – /new, /resume, /model, /compact, etc.
 *   commands.mts        – command-palette commands
 */

import * as vscode from "vscode";
import { handleChatRequest } from "./chat-handler.mjs";
import { cmdLogin, cmdLogout, cmdNewSession, cmdResumeSession, cmdSelectModel } from "./commands.mjs";
import { updateStatusBar } from "./status-bar.mjs";
import { cleanupSessionSubscription, state } from "./state.mjs";

export function activate(context: vscode.ExtensionContext) {
	state.extensionContext = context;
	state.outputChannel = vscode.window.createOutputChannel("PiAgent");
	state.outputChannel.appendLine("PiAgent extension activated");

	// Register chat participant
	const participant = vscode.chat.createChatParticipant("piagent.agent", handleChatRequest);
	participant.iconPath = vscode.Uri.joinPath(context.extensionUri, "media", "icon.png");

	context.subscriptions.push(
		participant,
		state.outputChannel,
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

	state.outputChannel.appendLine("Chat participant registered: piagent.agent");
}

export function deactivate() {
	state.outputChannel?.appendLine("PiAgent extension deactivated");
	cleanupSessionSubscription();
	state.currentSession = undefined;
}
