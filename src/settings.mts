/**
 * Settings management for PiAgent VSCode extension.
 *
 * Reads VSCode configuration and applies it to AgentSession instances.
 * Settings changes are applied immediately to all active sessions.
 */

import * as vscode from "vscode";
import { state } from "./state.mjs";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high";

export interface PiAgentSettings {
	autoCompaction: boolean;
	autoRetry: boolean;
	blockImages: boolean;
	thinkingLevel: ThinkingLevel;
}

/**
 * Read current PiAgent settings from VSCode configuration.
 */
export function getSettings(): PiAgentSettings {
	const config = vscode.workspace.getConfiguration("piagent");
	return {
		autoCompaction: config.get<boolean>("autoCompaction", true),
		autoRetry: config.get<boolean>("autoRetry", true),
		blockImages: config.get<boolean>("blockImages", false),
		thinkingLevel: config.get<ThinkingLevel>("thinkingLevel", "medium"),
	};
}

/**
 * Apply current VSCode settings to all active sessions.
 * Called when settings change via the configuration listener.
 */
export function applySettingsToAllSessions(): void {
	const settings = getSettings();

	for (const conv of state.conversations.values()) {
		const session = conv.session;

		// Apply compaction setting
		session.settingsManager.setCompactionEnabled(settings.autoCompaction);

		// Apply retry setting
		session.settingsManager.setRetryEnabled(settings.autoRetry);

		// Apply block images setting
		session.settingsManager.setBlockImages(settings.blockImages);

		// Apply thinking level
		session.settingsManager.setDefaultThinkingLevel(settings.thinkingLevel);
	}
}

/**
 * Apply current VSCode settings to a single session.
 * Called when creating a new session.
 */
export function applySettingsToSession(session: {
	settingsManager: {
		setCompactionEnabled(enabled: boolean): void;
		setRetryEnabled(enabled: boolean): void;
		setBlockImages(blocked: boolean): void;
		setDefaultThinkingLevel(level: ThinkingLevel): void;
	};
}): void {
	const settings = getSettings();
	session.settingsManager.setCompactionEnabled(settings.autoCompaction);
	session.settingsManager.setRetryEnabled(settings.autoRetry);
	session.settingsManager.setBlockImages(settings.blockImages);
	session.settingsManager.setDefaultThinkingLevel(settings.thinkingLevel);
}
