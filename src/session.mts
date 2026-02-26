/**
 * Session creation and initialisation helpers.
 */

import type { AgentSession } from "@mariozechner/pi-coding-agent";
import {
	AuthStorage,
	createAgentSession,
	DefaultResourceLoader,
	ModelRegistry,
	SessionManager,
	SettingsManager,
} from "@mariozechner/pi-coding-agent";
import { applySettingsToSession } from "./settings.mjs";

export interface InitSessionResult {
	session: AgentSession;
	model: string;
}

/**
 * Extra instructions appended to the system prompt for the VSCode chat context.
 *
 * These tell the model about the environment it's running in and how to format
 * output for the best experience in the VSCode Chat panel.
 */
export const VSCODE_SYSTEM_PROMPT = `
# VSCode Chat Environment

You are running inside the VSCode Chat panel as the @piagent chat participant.

## Response formatting

- Your responses are rendered as Markdown in the VSCode Chat panel.
- Keep responses concise and well-structured — the chat panel has limited width.
- Use code blocks with language identifiers for syntax highlighting.
- When referencing files, use inline code: \`path/to/file.ts\`.
- For file paths, prefer relative paths from the workspace root.

## Workspace context

Before starting work on a task, check for project context files that may contain important guidelines, conventions, or instructions. Common locations include:

- \`AGENTS.md\` or \`CLAUDE.md\` in the workspace root
- \`.github/copilot-instructions.md\`
- \`docs/CONTRIBUTING.md\` or \`CONTRIBUTING.md\`
- \`.cursorrules\` or \`.cursor/rules\`

Read these files when they exist and are relevant to your task. You don't need to read them for every request — use your judgment based on the task at hand.
`.trim();

/**
 * Create a ResourceLoader with the VSCode-specific system prompt appended.
 */
export async function createResourceLoader(cwd: string, settingsManager: SettingsManager) {
	const loader = new DefaultResourceLoader({
		cwd,
		settingsManager,
		appendSystemPrompt: VSCODE_SYSTEM_PROMPT,
	});
	await loader.reload();
	return loader;
}

export async function initSession(cwd: string): Promise<InitSessionResult> {
	const authStorage = AuthStorage.create();
	const modelRegistry = new ModelRegistry(authStorage);
	const settingsManager = SettingsManager.create(cwd);
	const sessionManager = SessionManager.create(cwd);
	const resourceLoader = await createResourceLoader(cwd, settingsManager);

	const { session } = await createAgentSession({
		cwd,
		authStorage,
		modelRegistry,
		settingsManager,
		sessionManager,
		resourceLoader,
	});

	// Apply VSCode settings to the new session
	applySettingsToSession(session);

	const model = session.model ? `${session.model.provider}/${session.model.id}` : "no model";

	return { session, model };
}
