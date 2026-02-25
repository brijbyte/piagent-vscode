/**
 * Session creation and initialisation helpers.
 */

import type { AgentSession } from "@mariozechner/pi-coding-agent";
import {
	AuthStorage,
	createAgentSession,
	ModelRegistry,
	SessionManager,
	SettingsManager,
} from "@mariozechner/pi-coding-agent";
import { state } from "./state.mjs";

export interface InitSessionResult {
	session: AgentSession;
	model: string;
}

export async function initSession(cwd: string): Promise<InitSessionResult> {
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
		state.outputChannel.appendLine(`Model fallback: ${modelFallbackMessage}`);
	}

	const model = session.model ? `${session.model.provider}/${session.model.id}` : "no model";
	state.outputChannel.appendLine(`Session initialized in ${cwd}`);
	state.outputChannel.appendLine(`Model: ${model}`);

	return { session, model };
}
