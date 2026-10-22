# Yumina

An open-source engine for AI-native interactive fiction. Yumina is a toolset that allows creators to use AI as a gameplay itself and integrate it into all entertainment mediums including but not limited to games, books, visual novels, and movies.

Yumina started as a personal project - a fork of [SillyTavern](https://github.com/SillyTavern/SillyTavern), integrated with the Godot game engine, that let AI control not just text, but also 2d/3d visuals, variables, and even sound. But SillyTavern’s original architecture was built in the era of pure text simulation. Despite the countless open-source contributors who built plugins over the years, its foundational structure was always going to limit how far it could evolve toward AI-native games and interactive cinema. Today, Yumina has its own independent AI-native game engine, multiplayer support, and multi-agent worlds. Just as SillyTavern’s greatest extensions came from its open-source community, we believe Yumina belongs to the community too, and only the community can make it better.

This is Yumina's open-source version where your local service handles everything. The hosted service at [yumina.io](https://yumina.io) runs this same engine and adds discovery, a creator revenue share, and community. This repository is the engine, the editor, and the player. Why both exist is in the [vision](https://docs.yumina.io/vision/).

## What the engine controls

Everything below is data in a world file. The model never executes code; it emits directives, and the engine applies them.

| Area | What a world can declare |
|---|---|
| Story | `entries[]`: prompt and lore units with a role (system, character, scenario, lore, greeting, example), a section (system presets, examples, chat history, post-history), insertion depth, keyword and secondary-keyword logic, conditions on state, and grouping into activatable worldbooks. Multiple greetings, each with its own starting state. |
| State | `variables[]`: typed `number`, `string`, `boolean`, `json` with min/max, default, behavior rules the model reads, and per-variable AI access (write, read, none). The model changes state with `[variable: op value]` directives; nine operations including `merge`, `push`, `delete` on dot paths like `inventory.weapons[0].durability`. |
| Rules | `rules[]` and `reactions[]`: triggers (state change, threshold crossed, turn count, keyword, action, every turn, session start), conditions with AND/OR, and effects (modify variables, inject or remove directives, send context, toggle entries or rules, notify the player, play audio). Reactions add dice and weighted random, cooldowns, and chained events. |
| Systems | `systems[]`: opt-in engine modules. Spatial (scenes, zones, exits), timer, turn-based combat, a social simulator for multi-agent worlds. |
| Interface | `components[]`: stat bars, text displays, image panels, inventory grids, web panels. `uiBlueprint`: a declarative layout with bindings and triggers. `rootComponent`: a multi-file React app in TypeScript that runs in a sandboxed iframe and talks to the engine through `useYumina()`. It can render anything the browser can, including WebGL scenes. |
| Audio | `audioTracks[]`, playlists, and conditional background music. The model can cue tracks with `[audio: track play]`. |
| Memory | Session summaries and a first-party session-memory extension keep long stories coherent. Branches, rewind, and checkpoints are built in. |

The full schema is in [`docs/world-spec`](docs/world-spec/) and online at [docs.yumina.io/world-spec](https://docs.yumina.io/world-spec/). It is written to be handed to an AI coding tool: paste the spec, describe the world, get valid JSON.

## Architecture

```
packages/
  shared/   Zod schemas, types, constants
  engine/   framework-free TypeScript: state manager, rules and reactions,
            prompt builder, lorebook matcher, response parser, migrations,
            validation. Depends only on zod and js-tiktoken.
  server/   Hono API. Drizzle ORM on embedded PostgreSQL (PGlite) or a real
            Postgres. Providers for OpenRouter, Anthropic, OpenAI, Google,
            Ollama and any OpenAI-compatible endpoint. SSE streaming. Better Auth.
  app/      React 19, Vite, TanStack Router, Zustand. The player, the editor,
            the Studio agent, and the sandbox that runs creator interfaces.
docs/       world spec, creator guide, player guide
```

One turn: the client sends a message, the server builds the prompt (system presets, activated lore within a token budget, memory blocks, game state), streams the model's reply, parses directives out of the stream, applies effects through the state manager, runs reactions and systems, persists, and pushes the new state into the sandbox where the world's interface re-renders.

## Run it

Requirements: Node.js 22 or newer, and pnpm (`corepack enable` gives you pnpm).

```
git clone https://github.com/lovetimo0421/yumina-oss.git
cd yumina-oss
pnpm install
pnpm start
```

The first `pnpm start` builds the app, which takes a few minutes. Then open http://localhost:3000. There is no login: the local edition signs you into one local account. Open Profile or Settings, add a key for your provider, and create or import a world.

Data lives in `packages/server/data` by default: the embedded PostgreSQL database and every image and audio file you upload. Back that folder up and you have everything.

### Connecting a model

Keys are added in the app, not in config files. Supported: OpenRouter, Anthropic, OpenAI, Google, Ollama (local, default `http://localhost:11434`), and any OpenAI-compatible URL such as DeepSeek, LM Studio, KoboldCpp, TabbyAPI or vLLM. Keys are encrypted at rest with AES-256-GCM using a key derived from `BETTER_AUTH_SECRET`.

### Using your Antigravity Google sign-in

Install the official [Antigravity CLI](https://antigravity.google/docs/getting-started?tab=cli) and run `agy` once to sign in with Google. Yumina can reuse its cached OAuth session on this computer. Open **Settings → AI config → Use Antigravity on this computer**, choose **Check connection**, select a model from your account, then choose **Use Antigravity**. Gemini, Claude and other models appear according to your account's current catalog and access limits.

This connection requires the local edition bound to localhost. Yumina calls the official CLI, stores only a connection marker and model preference, and leaves token storage and refresh to Antigravity. **Disconnect from Yumina** keeps Antigravity signed in. If needed, set `YUMINA_ANTIGRAVITY_PATH` to the absolute path of `agy`. API-key and ADC billing configurations must be switched to personal Google sign-in in the official CLI first.

The integration supports text conversations and streams responses. Images, application tool calls and JSON Schema side completions need another provider. Antigravity controls generation settings and may save conversation history in its own data directory. Each reply runs in a temporary workspace with a conversation-only agent that excludes shell, file, browser and MCP tools.

### Using your Claude Code subscription

For a personal installation, install the official [Claude Code CLI](https://code.claude.com/docs/en/setup), run `claude auth login` in Terminal, and sign in with your Claude subscription. In Yumina, open **Settings → AI config → Use Claude Code on this computer**, choose **Check connection**, then select Sonnet, Opus or Haiku and choose **Use Claude Code**. Model aliases follow the CLI's current versions; access and usage limits depend on your account.

Yumina must run on the same computer, bound to `localhost` or `127.0.0.1`. This connection uses the unmodified official CLI's `--print` streaming mode and its existing login. Yumina stores only a connection marker and model preference. **Disconnect from Yumina** removes that marker; it leaves your CLI signed in. To sign out of Claude Code itself, run `claude auth logout`. If the binary is outside PATH and `~/.local/bin`, set `YUMINA_CLAUDE_CODE_PATH` to its absolute path before starting Yumina.

This connection currently supports text conversations, including their ordered history and world instructions. Images, tool calling and JSON Schema side completions require another provider. Coding tools, MCP servers, hooks, project settings and CLI session persistence are disabled for these requests. One reply runs at a time. CLI model defaults apply to sampling and output length. CLI startup and replaying conversation history can add latency. Requests use your Claude plan's limits and remain subject to [Anthropic's authentication and integration conditions](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use).

### Using your ChatGPT plan

On the computer running Yumina, open **Settings → AI config → Use your ChatGPT plan** and choose **Continue with ChatGPT**. Complete browser sign-in and authorize plan usage, then choose an available model. The connection becomes the active provider. No OpenAI API key or Ollama installation is required for this option.

This integration uses OpenAI's [OAuth flow for local and open-source apps](https://developers.openai.com/siwc/token-sharing-open-source) and the Responses API. Requests count against your ChatGPT plan or credits, subject to account/workspace permissions and shared usage limits. Use **Manage usage** to review limits in ChatGPT settings. Model availability is account-specific; a successful request confirms access.

Connect through `localhost` on the same computer as the server. Sign-in temporarily opens a callback listener bound to `127.0.0.1` on an available port. Tokens are encrypted in the existing provider-profile database and refresh automatically. The stable host identifier is stored in `chatgpt-host-id` under the data directory. Keep the data directory and encryption secret when moving or backing up an installation. Multiple accounts are stored separately. **Disconnect** attempts remote session revocation and clears local tokens while retaining the registration for another sign-in. If revocation cannot be confirmed, disconnect Yumina in ChatGPT settings too.

Text chat, tool calls, and compatible image inputs are supported. This flow does not provide image generation or audio APIs. Its current preview also omits sampling and output-token-limit parameters. Ollama and API-key providers remain available in the same settings page.

### Cards

Import: Yumina `.png` or `.json` cards, plus character cards and worldbooks in the community [V2](https://github.com/malfoyslastname/character-card-spec-v2) and [V3](https://github.com/kwaroran/character-card-spec-v3) formats. Export: any world as a Yumina PNG card (JSON embedded in a `tEXt` chunk) or plain JSON.

### Environment

`pnpm start` writes a `.env` with a generated `BETTER_AUTH_SECRET` on first run. Everything else is optional.

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `3000` | Port to listen on |
| `HOST` | `127.0.0.1` | Bind address. Single-user mode has no login, so only bind `0.0.0.0` on a network you trust, or switch to multi-user mode. |
| `YUMINA_DATA_DIR` | `./data` (under `packages/server`) | Database and uploaded assets |
| `YUMINA_STORAGE_DIR` | `<data dir>/assets` | Uploaded files, when no S3 bucket is configured |
| `YUMINA_AUTH_MODE` | `single-user` | `multi-user` turns on email and password accounts |
| `PUBLIC_ORIGIN` | derived from `BETTER_AUTH_URL` | The origin browsers use to reach this server |
| `BETTER_AUTH_SECRET` | generated | Signs sessions and encrypts stored API keys. Keep it. |
| `DATABASE_URL` | unset | Set to use a real PostgreSQL instead of the embedded one. An empty database is provisioned on first start. |
| `AWS_S3_BUCKET_NAME`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_ENDPOINT_URL` | unset | Store uploads in any S3-compatible bucket instead of on disk |

### Docker

```
docker build -t yumina .
docker run -d --name yumina -p 127.0.0.1:3000:3000 -v yumina-data:/data \
  -e BETTER_AUTH_SECRET=$(openssl rand -hex 32) yumina
```

## Development

```
pnpm dev         # server + app with hot reload
pnpm typecheck
pnpm test
pnpm build
```

Rules that keep the engine portable: `packages/engine` never imports React or the server; the model never executes code, it only emits directives the engine applies from structured data. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Documentation

- [World spec](docs/world-spec/) — the schema, written for AI coding tools and advanced creators
- [Creator guide](docs/creator/) — entries, variables, rules, visuals and audio, Studio
- [Player guide](docs/guide/)
- Online: [docs.yumina.io](https://docs.yumina.io)
- Community: [Discord](https://discord.gg/gPhncrugz3), [Reddit](https://www.reddit.com/r/yuminaAI/)

## Security

Report vulnerabilities privately through the repository's Security tab, or to `support@yumina.io`. Details and the threat model are in [SECURITY.md](SECURITY.md).

## License

Code: [AGPL-3.0-only](LICENSE). Documentation under `docs/`: [CC BY 4.0](LICENSE-DOCS.md). "Yumina" and the logo are trademarks and not covered by either license; see [TRADEMARK.md](TRADEMARK.md).
