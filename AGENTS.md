# PiAgent VSCode Extension - Agent Guide

AI coding agent for VSCode Chat using [pi-coding-agent](https://github.com/badlogic/pi-mono).

## Quick Reference

```bash
npm run build      # Build extension
npm run check      # TypeScript type check
npm run package    # Create .vsix package
```

## Architecture

```
src/
├── extension.mts      # Entry point: activate/deactivate, registers commands & chat participant
├── state.mts          # Shared mutable state (conversations, outputChannel, activeConversationId)
├── chat-handler.mts   # Main chat request handler, routes to slash commands or agent session
├── event-handler.mts  # AgentSessionEvent → ChatResponseStream rendering (tool output, markdown)
├── slash-commands.mts # /new, /resume, /model, /compact, /session, /login, /logout, /help, /settings
├── commands.mts       # Command palette commands (same functionality as slash commands)
├── session.mts        # Session creation helpers, VSCode-specific system prompt
├── settings.mts       # VSCode settings → AgentSession settings bridge
├── status-bar.mts     # Status bar formatting (model, tokens, cost, context usage)
└── references.mts     # Resolve VSCode chat references (files, selections, images)
```

## Key Concepts

### Conversations vs Sessions
- **Conversation**: Per-chat-tab state in VSCode (stored in `state.conversations` Map)
- **Session**: pi-coding-agent session persisted to disk (`~/.pi/agent/sessions/`)
- Each VSCode chat tab gets its own conversation, which wraps an AgentSession

### State Management (`state.mts`)
```typescript
state.conversations        // Map<conversationId, ChatConversation>
state.activeConversationId // Currently active chat tab
state.pendingSessionStatus // Status message for next chat request
state.outputChannel        // VSCode output channel for logs
state.extensionContext     // VSCode extension context
```

### Chat Flow
1. User sends message → `handleChatRequest()` in `chat-handler.mts`
2. If slash command → route to `slash-commands.mts`
3. Otherwise → get/create conversation, resolve references, call `session.prompt()`
4. Session events → `handleSessionEvent()` renders to `ChatResponseStream`

### Tool Rendering (`event-handler.mts`)
- `tool_execution_start`: Shows tool name + context (file path, command preview)
- `tool_execution_end`: Shows truncated result in fenced code block
- Results truncated to 500 chars in chat; full output was in output channel (now removed)

## Configuration

### Shared with pi CLI (`~/.pi/agent/`)
- `auth.json` - API keys and OAuth tokens
- `settings.json` - Global settings
- `models.json` - Custom model definitions
- `sessions/` - Persisted sessions

### VSCode-specific (`settings.mts`)
Settings are read from VSCode config and applied to all sessions immediately on change.

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `piagent.statusBar.show` | array | all | Stats to show in status bar |
| `piagent.autoCompaction` | boolean | true | Auto-compact when near token limit |
| `piagent.autoRetry` | boolean | true | Retry failed API requests |
| `piagent.blockImages` | boolean | false | Block image attachments |
| `piagent.thinkingLevel` | string | "medium" | Thinking level for reasoning models |

## Dependencies

- `@mariozechner/pi-coding-agent` - Core agent session, tools, model registry
- `@mariozechner/pi-ai` - LLM provider APIs, OAuth, model types

## Common Tasks

### Adding a new slash command
1. Add handler function in `slash-commands.mts`
2. Add case in `handleSlashCommand()` switch
3. Add command definition in `package.json` under `chatParticipants[0].commands`
4. Update `/help` command output in `slashHelp()`

### Adding a Quick Action (context menu)
1. Add handler function in `commands.mts` (use `openChatWithSelection()` helper)
2. Export and register in `extension.mts`
3. Add command definition in `package.json` under `contributes.commands`
4. Add to `piagent.submenu` in `package.json` menus

### Adding a new setting
1. Add to `package.json` under `contributes.configuration.properties`
2. Add to `PiAgentSettings` interface in `settings.mts`
3. Read in `getSettings()` and apply in `applySettingsToSession()`
4. Add config change listener in `extension.mts` if needed

### Adding a command palette command
1. Add handler function in `commands.mts`
2. Register in `extension.mts` via `vscode.commands.registerCommand()`
3. Add command definition in `package.json` under `contributes.commands`

### Modifying status bar display
Edit `status-bar.mts` - `updateStatusBar()` and `formatTokenStat()`

### Changing tool output rendering
Edit `event-handler.mts` - `handleSessionEvent()` cases for `tool_execution_*`

## Build Notes

- Uses esbuild with ESM → CJS conversion
- External: `vscode`, `koffi`, `@mariozechner/clipboard`
- Polyfill for `import.meta.url` in `import-meta-polyfill.js`
- Output: `dist/extension.js` (~7MB bundled)

## Logging

Minimal logging to output channel:
- Extension activated/deactivated (lifecycle)
- Reference resolution failures (errors only)

All user-facing feedback goes through `ChatResponseStream.markdown()` or `response.progress()`.

## CI/CD

### GitHub Actions Workflows

#### `.github/workflows/ci.yml`
Runs on every push and PR to `main`:
- Type check (`pnpm run check`)
- Build (`pnpm run build`)
- Package (`pnpm run package`)
- Upload `.vsix` as artifact

#### `.github/workflows/publish.yml`
Automatically publishes when local version is newer than marketplace:
1. Fetches current version from VS Code Marketplace API
2. Compares with local `package.json` version (semver comparison)
3. If local is newer: builds, publishes, and creates GitHub Release
4. If not newer: skips with summary message

Triggers on:
- Push to `main` branch
- Manual trigger via `workflow_dispatch`

### Setup Requirements

1. **Create a Personal Access Token (PAT)** for VS Code Marketplace:
   - Go to [Azure DevOps](https://dev.azure.com/)
   - User Settings → Personal Access Tokens → New Token
   - Set Organization to "All accessible organizations"
   - Set Scopes: Marketplace → Manage

2. **Add the token as a GitHub secret**:
   - Go to repo Settings → Secrets and variables → Actions
   - Add secret named `VSCE_PAT` with the token value

### Publishing a New Version

1. Update `version` in `package.json`
2. Commit and push to `main`
3. CI automatically publishes to marketplace and creates a GitHub release
