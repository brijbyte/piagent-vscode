# PiAgent - AI Coding Agent for VSCode

[![VSCode Marketplace](https://img.shields.io/visual-studio-marketplace/v/brijbyte.piagent-vscode?style=flat-square&label=marketplace)](https://marketplace.visualstudio.com/items?itemName=brijbyte.piagent-vscode)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](./LICENSE)

A full-featured AI coding agent that lives inside VSCode's Chat panel. Powered by [pi](https://pi.dev) ([source](https://github.com/badlogic/pi-mono)) — the same engine behind the [pi CLI](https://www.npmjs.com/package/@mariozechner/pi-coding-agent). Mention `@piagent` and let it read, write, edit files and execute bash commands to complete coding tasks autonomously.

## Why PiAgent?

- **Not locked to one model.** Use Claude, GPT-4, Gemini, DeepSeek, Mistral, or any of 15+ supported LLM providers. Switch models mid-conversation.
- **Real tools, not autocomplete.** The agent reads files, writes files, makes surgical edits, and runs shell commands — the same four tools the [pi CLI](https://pi.dev) uses.
- **No permission prompts.** There is no permission system. The agent executes tools directly without asking for approval on every file read or shell command. This is a deliberate design choice — it keeps the workflow fast and uninterrupted. You are in control of what you ask it to do.
- **Shared configuration with the [pi CLI](https://pi.dev).** API keys, settings, models, and auth are stored in `~/.pi/agent/`, not in VSCode settings. If you already use the pi CLI, PiAgent works out of the box with the same config. Nothing is VSCode-specific.
- **Session persistence.** Start a session, close VSCode, resume it later. Sessions are stored on disk and shared with the pi CLI.
- **Automatic context compaction.** When the conversation gets too long, PiAgent compacts the context automatically so you can keep working without hitting token limits.

## Quick Start

1. Install the extension from the [VSCode Marketplace](https://marketplace.visualstudio.com/items?itemName=brijbyte.piagent-vscode)
2. Authenticate with a provider — pick one:

   **Option A: OAuth login (recommended for subscriptions)**
   
   Open the Chat panel, type `@piagent /login`, and select your provider. PiAgent opens your browser to complete authentication. Supports Anthropic (Claude Pro/Max), OpenAI (ChatGPT Plus/Pro), GitHub Copilot, and Google (Gemini CLI / Antigravity).

   **Option B: API key via environment variable**
   ```bash
   export ANTHROPIC_API_KEY=sk-ant-...
   # or
   export OPENAI_API_KEY=sk-...
   # or
   export GEMINI_API_KEY=...
   ```

   **Option C: API key in auth file**
   
   Store keys in `~/.pi/agent/auth.json` (same file the pi CLI uses).

3. Open VSCode's Chat panel (`Ctrl+Shift+I` / `Cmd+Shift+I`)
4. Type `@piagent` followed by your prompt

That's it. PiAgent initializes a session, picks the best available model, and starts working.

## Features

### Chat Participant

Mention `@piagent` in VSCode's built-in Chat panel. PiAgent registers as a native chat participant — no separate webview, no sidecar process.

### Tool Execution

PiAgent has four tools:

| Tool | What it does |
|------|-------------|
| `read` | Read file contents (text and images) |
| `write` | Create or overwrite files |
| `edit` | Surgical find-and-replace edits |
| `bash` | Execute shell commands |

All tool output streams to the Chat panel in real time. Full output is available in the Output channel (`View → Output → PiAgent`).

### Multi-Provider LLM Support

PiAgent supports every provider that pi-coding-agent supports:

| Provider | Models |
|----------|--------|
| **Anthropic** | Claude 4 Sonnet, Claude 4 Opus, Claude 3.5 Sonnet, Claude 3.5 Haiku |
| **OpenAI** | GPT-4o, GPT-4.1, o3, o4-mini |
| **Google** | Gemini 2.5 Pro, Gemini 2.5 Flash |
| **Amazon Bedrock** | Claude, Mistral, and other Bedrock-hosted models |
| **Azure OpenAI** | GPT-4o, GPT-4.1 via Azure deployments |
| **DeepSeek** | DeepSeek V3, DeepSeek R1 |
| **Mistral** | Mistral Large, Codestral |
| **Groq** | LLaMA, Mixtral |
| **Cerebras** | LLaMA |
| **xAI** | Grok |
| **OpenRouter** | Any model available on OpenRouter |
| **Vercel AI Gateway** | Any model via Vercel |
| **Hugging Face** | Inference API models |
| **And more** | ZAI, OpenCode Zen, Kimi, MiniMax |

Switch models at any time with `/model` or `Cmd+Shift+M`.

### OAuth Login

Use `/login` to authenticate with subscription-based providers directly from VSCode — no need to manually edit JSON files or set environment variables. PiAgent opens your browser, completes the OAuth flow, and saves credentials to `~/.pi/agent/auth.json`.

Supported OAuth providers:
- **Anthropic** — Claude Pro / Max subscription
- **OpenAI** — ChatGPT Plus / Pro (Codex)
- **GitHub Copilot** — existing Copilot subscription
- **Google Gemini CLI** — Google Cloud authentication
- **Google Antigravity** — Gemini 3, Claude, GPT via Google Cloud

Use `/logout` to remove stored credentials for any provider.

### Session Management

- **`/new`** — Start a fresh session
- **`/resume`** — Pick from previous sessions (with message count and timestamp)
- **`/session`** — View current session ID, model, message count, and working directory
- **`/compact`** — Manually compact context to free up token space

Sessions are stored on disk at `~/.pi/agent/sessions/` and are fully compatible with the pi CLI. You can start a session in the terminal and resume it in VSCode, or vice versa.

### Automatic Context Compaction

When the conversation approaches the model's context window limit, PiAgent automatically compacts the history — summarizing earlier messages while preserving recent context. This happens transparently; you see a brief progress indicator and can keep working.

## Slash Commands

Type `@piagent /` to see all available commands:

| Command | Description |
|---------|-------------|
| `/new` | Start a new session |
| `/resume` | Resume a previous session |
| `/model` | Select a different model |
| `/compact` | Compact the session context |
| `/session` | Show session info and stats |
| `/login` | Login with an OAuth provider (Anthropic, OpenAI, GitHub Copilot, Google) |
| `/logout` | Logout from an OAuth provider |
| `/help` | Show available commands and shortcuts |

## Command Palette

Open the command palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) and search for:

| Command | Description |
|---------|-------------|
| `PiAgent: New Session` | Start a fresh session |
| `PiAgent: Resume Session` | Continue a previous session |
| `PiAgent: Select Model` | Choose a different model |
| `PiAgent: Login` | Login with an OAuth provider |
| `PiAgent: Logout` | Logout from an OAuth provider |

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Cmd+Shift+M` (Mac) / `Ctrl+Shift+M` (Win/Linux) | Select model |

## Configuration

PiAgent uses the same configuration as the [pi CLI](https://pi.dev). Nothing is stored in VSCode settings. This means your setup works identically whether you use PiAgent in VSCode, the pi CLI in a terminal, or any other tool built on [pi-coding-agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent).

### API Keys

Set environment variables before launching VSCode, or store them in `~/.pi/agent/auth.json`:

```bash
# Environment variables
export ANTHROPIC_API_KEY=sk-ant-...
export OPENAI_API_KEY=sk-...
export GEMINI_API_KEY=...
export DEEPSEEK_API_KEY=...
export MISTRAL_API_KEY=...
export GROQ_API_KEY=...
export XAI_API_KEY=...
```

### Settings

Global settings live at `~/.pi/agent/settings.json`. Project-local overrides go in `.pi/settings.json` at the project root.

### Custom Models

Add or override models via `~/.pi/agent/models.json`. Any provider that speaks the OpenAI, Anthropic, or Google API can be added as a custom provider. See the [pi documentation](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent#providers--models) for details.

## Output

- **Chat Panel** — Streaming markdown responses and inline tool call summaries
- **Output Channel** — Full untruncated tool output, useful for long bash output or large file reads. Access via `View → Output → PiAgent`
- **Status Bar** — Shows the currently active model. Click to switch models.

## Requirements

- VSCode **1.100.0** or later
- **Node.js 20.0.0** or later
- An API key for at least one [supported provider](#multi-provider-llm-support)

## FAQ

### How is this different from GitHub Copilot?

PiAgent is an autonomous coding agent with file system access and shell execution. It can read your codebase, make multi-file edits, run tests, and iterate on errors. Copilot is primarily an autocomplete and chat tool. PiAgent also lets you bring any model from any provider.

### Do I need the pi CLI installed?

No. PiAgent bundles `pi-coding-agent` as a dependency. However, if you already use the [pi CLI](https://pi.dev), they share the same configuration directory (`~/.pi/agent/`), so API keys, settings, sessions, and custom models work in both places.

### Can I use my Anthropic/OpenAI subscription instead of an API key?

Yes. Use `/login` directly in VSCode to authenticate with your existing subscription (Anthropic Claude Pro/Max, ChatGPT Plus/Pro, GitHub Copilot, or Google Gemini). PiAgent opens your browser, completes the OAuth flow, and saves credentials to `~/.pi/agent/auth.json`. If you've already authenticated via `pi /login` in the CLI, PiAgent picks up the stored credentials automatically.

### Does PiAgent ask for permission before running tools?

No. There is no permission system — no "allow/deny" dialogs for file edits or shell commands. The agent executes tools directly as requested. This matches the behavior of the [pi CLI](https://pi.dev). If you want to review changes before they happen, ask the agent to show you a plan first, or use git to review and revert.

### Where are sessions stored?

Sessions are stored at `~/.pi/agent/sessions/` and `<project>/.pi/sessions/`. They are plain JSON files and are fully portable between PiAgent and the pi CLI.

## License

[MIT](./LICENSE)

## Credits

Built on [pi](https://pi.dev) ([GitHub](https://github.com/badlogic/pi-mono)) by [Mario Zechner](https://github.com/badlogic).
