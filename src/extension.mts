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
import {
	cmdLogin,
	cmdLogout,
	cmdNewSession,
	cmdResumeSession,
	cmdSelectModel,
	cmdExplainCode,
	cmdRefactorCode,
	cmdWriteTests,
	cmdFindBugs,
	cmdAddDocs,
	cmdOptimizeCode,
	getQuickActionConfig,
} from "./commands.mjs";
import { applySettingsToAllSessions } from "./settings.mjs";
import { updateStatusBar } from "./status-bar.mjs";
import { removeConversation, state } from "./state.mjs";

// ── Code Action Provider ─────────────────────────────────────────────────────

/**
 * Provides PiAgent quick actions in the lightbulb menu when code is selected.
 */
class PiAgentCodeActionProvider implements vscode.CodeActionProvider {
	public static readonly providedCodeActionKinds = [
		vscode.CodeActionKind.RefactorRewrite,
		vscode.CodeActionKind.QuickFix,
	];

	provideCodeActions(
		_document: vscode.TextDocument,
		range: vscode.Range | vscode.Selection,
	): vscode.CodeAction[] {
		// Only show actions when there's a selection
		if (range.isEmpty) return [];

		const actions: vscode.CodeAction[] = [];

		// Explain Code
		if (getQuickActionConfig("explainCode").enabled) {
			const explainAction = new vscode.CodeAction(
				"PiAgent: Explain Code",
				vscode.CodeActionKind.RefactorRewrite,
			);
			explainAction.command = {
				command: "piagent.explainCode",
				title: "Explain Code",
			};
			actions.push(explainAction);
		}

		// Find Bugs
		if (getQuickActionConfig("findBugs").enabled) {
			const findBugsAction = new vscode.CodeAction(
				"PiAgent: Find Bugs",
				vscode.CodeActionKind.QuickFix,
			);
			findBugsAction.command = {
				command: "piagent.findBugs",
				title: "Find Bugs",
			};
			actions.push(findBugsAction);
		}

		// Refactor Code
		if (getQuickActionConfig("refactorCode").enabled) {
			const refactorAction = new vscode.CodeAction(
				"PiAgent: Refactor",
				vscode.CodeActionKind.RefactorRewrite,
			);
			refactorAction.command = {
				command: "piagent.refactorCode",
				title: "Refactor Code",
			};
			actions.push(refactorAction);
		}

		// Optimize Code
		if (getQuickActionConfig("optimizeCode").enabled) {
			const optimizeAction = new vscode.CodeAction(
				"PiAgent: Optimize",
				vscode.CodeActionKind.RefactorRewrite,
			);
			optimizeAction.command = {
				command: "piagent.optimizeCode",
				title: "Optimize Code",
			};
			actions.push(optimizeAction);
		}

		// Add Documentation
		if (getQuickActionConfig("addDocs").enabled) {
			const addDocsAction = new vscode.CodeAction(
				"PiAgent: Add Docs",
				vscode.CodeActionKind.RefactorRewrite,
			);
			addDocsAction.command = {
				command: "piagent.addDocs",
				title: "Add Documentation",
			};
			actions.push(addDocsAction);
		}

		// Write Tests
		if (getQuickActionConfig("writeTests").enabled) {
			const writeTestsAction = new vscode.CodeAction(
				"PiAgent: Write Tests",
				vscode.CodeActionKind.RefactorRewrite,
			);
			writeTestsAction.command = {
				command: "piagent.writeTests",
				title: "Write Tests",
			};
			actions.push(writeTestsAction);
		}

		return actions;
	}
}

export function activate(context: vscode.ExtensionContext) {
	state.extensionContext = context;
	state.outputChannel = vscode.window.createOutputChannel("PiAgent");
	state.outputChannel.appendLine("PiAgent extension activated");

	// Register chat participant
	const participant = vscode.chat.createChatParticipant("piagent.agent", handleChatRequest);
	participant.iconPath = vscode.Uri.joinPath(context.extensionUri, "media", "icon.png");

	// Register Code Action Provider for lightbulb menu
	const codeActionProvider = vscode.languages.registerCodeActionsProvider(
		{ scheme: "file" }, // All file-based documents
		new PiAgentCodeActionProvider(),
		{
			providedCodeActionKinds: PiAgentCodeActionProvider.providedCodeActionKinds,
		},
	);

	context.subscriptions.push(
		participant,
		state.outputChannel,
		codeActionProvider,
		vscode.commands.registerCommand("piagent.newSession", cmdNewSession),
		vscode.commands.registerCommand("piagent.resumeSession", cmdResumeSession),
		vscode.commands.registerCommand("piagent.selectModel", cmdSelectModel),
		vscode.commands.registerCommand("piagent.login", cmdLogin),
		vscode.commands.registerCommand("piagent.logout", cmdLogout),
		// Quick Actions (context menu)
		vscode.commands.registerCommand("piagent.explainCode", cmdExplainCode),
		vscode.commands.registerCommand("piagent.refactorCode", cmdRefactorCode),
		vscode.commands.registerCommand("piagent.writeTests", cmdWriteTests),
		vscode.commands.registerCommand("piagent.findBugs", cmdFindBugs),
		vscode.commands.registerCommand("piagent.addDocs", cmdAddDocs),
		vscode.commands.registerCommand("piagent.optimizeCode", cmdOptimizeCode),
		// React to settings changes
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration("piagent.statusBar.show")) {
				updateStatusBar();
			}
			// Apply agent settings changes to all active sessions
			if (
				e.affectsConfiguration("piagent.autoCompaction") ||
				e.affectsConfiguration("piagent.autoRetry") ||
				e.affectsConfiguration("piagent.blockImages") ||
				e.affectsConfiguration("piagent.thinkingLevel")
			) {
				applySettingsToAllSessions();
			}
		}),
	);


}

export function deactivate() {
	state.outputChannel?.appendLine("PiAgent extension deactivated");
	// Clean up all conversations
	for (const id of Array.from(state.conversations.keys())) {
		removeConversation(id);
	}
}
