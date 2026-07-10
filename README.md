# CTFBot 🚩

UCS's specialized Discord bot for managing Capture The Flag (CTF) competitions,
now with **blockchain-backed task tracking, reputation, and document anchoring**
powered by [Luce](https://github.com/ucsits/Luce).

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen)](https://nodejs.org/)
[![Discord.js](https://img.shields.io/badge/discord.js-v14-blue)](https://discord.js.org/)

## Features

- 📅 **Event Scheduling** — Schedule CTF events with timezone support
- 🏗️ **Channel Management** — Automatically create dedicated CTF channels
- 👥 **User Registration** — Track team member participation
- 🗄️ **Database Storage** — Persistent storage of CTF data and registrations
- 🔗 **CTFd Integration** — Ready for CTFd platform integration (coming soon)
- ⛓️ **Blockchain-Backed Tasks** — Create and track tasks with immutable audit trail
- 👍 **Reputation System** — Give +1/-1 rep via reactions, replies, or `/rep` command
- 📄 **Document Anchoring** — Permanently store documents on the blockchain
- ⏰ **Automatic Reminders** — Task deadline reminders sent to a dedicated channel

## Commands

### CTF Commands
- `/schedule` — Schedule custom events with timezone support
- `/createctf` — Create a CTF text channel and schedule its event
- `/registerctf` — Register your participation for the CTF in the current channel
- `/addchalctf` — Add challenges to a CTF
- `/solvectf` — Mark a challenge as solved
- `/archivectf` — Archive a completed CTF
- `/chalpts` — View challenge points
- `/summarizectf` — View CTF summary
- `/syncchallenges` — Sync challenges from CTFd
- `/pact` — Manage pacts

### Task Commands
- `/task add` — Create a new task (title, description, assignee, deadline)
- `/task list [period]` — View remaining tasks for this week/month/quarter/year
- `/task done` — Mark a task as completed

### Reputation Commands
- `/rep [downvote]` — Give +1 or -1 rep (must reply to someone's message; response is ephemeral)
- `/repleaderboard [limit]` — View the reputation leaderboard

You can also give rep by:
- Reacting with 👍 or 👎 to someone's message
- Replying to someone with `+1`, `-1`, 👍, or 👎

### Document Commands
- `/document add` — Anchor a document to the blockchain
- `/document get` — Retrieve an anchored document

### Utility Commands
- `/ping` — Check bot responsiveness
- `/help` — List all available commands

## Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) v18.0.0 or higher
- [pnpm](https://pnpm.io/) package manager
- A Discord Bot Token ([Create one here](https://discord.com/developers/applications))
- [Luce](https://github.com/ucsits/Luce) blockchain server running locally on port 5500

### Installation

1. **Clone the repository**
   ```bash
   git clone https://github.com/ucsits/ctfbot.git
   cd ctfbot
   ```

2. **Install dependencies**
   ```bash
   pnpm install
   ```

3. **Configure environment variables**
   ```bash
   cp .env.example .env
   ```
   
   Edit `.env` and fill in the required values:
   - `DISCORD_TOKEN` — Your Discord bot token
   - `GUILD_ID` — Your Discord server ID (for development)
   - `CTF_CATEGORY_ID` — Category ID where CTF channels will be created
   - `CTFD_API_TOKEN` — Your CTFd API token (optional)
   - `LUCE_PORT` — Luce blockchain RPC port (default: 5500)

4. **Run the bot**
   
   Development mode (with auto-reload):
   ```bash
   pnpm dev
   ```
   
   Production mode:
   ```bash
   pnpm start
   ```

### Setting Up Your Discord Server

1. **Create a CTF Category**
   - Right-click in your server's channel list
   - Select "Create Category"
   - Name it "CTF" or similar
   - Right-click the category → Copy ID
   - Paste the ID in `.env` as `CTF_CATEGORY_ID`

2. **Invite the Bot**
   - Go to Discord Developer Portal
   - Select your application
   - Go to OAuth2 → URL Generator
   - Select scopes: `bot`, `applications.commands`
   - Select permissions: `Manage Channels`, `Manage Events`, `Send Messages`, `Embed Links`, `Add Reactions`, `Read Message History`
   - Copy and visit the generated URL

## Architecture

```
src/
├── commands/              # Slash command implementations
│   ├── createctf.js       # Create CTF channels and events
│   ├── registerctf.js     # User registration for CTFs
│   ├── schedule.js        # Generic event scheduling
│   ├── task.js            # Blockchain-backed task management
│   ├── rep.js             # Reputation command (ephemeral)
│   ├── repleaderboard.js  # Reputation leaderboard
│   ├── document.js        # Document anchoring
│   ├── help.js            # List all commands
│   └── ping.js            # Health check
├── listeners/             # Event listeners
│   ├── ready.js           # Bot ready event (starts reminder service)
│   ├── messageCreate.js   # Detects reply-based +1/-1/👍/👎
│   ├── messageReactionAdd.js  # Detects 👍/👎 reaction rep
│   └── applicationCommandRegistriesRegistered.js
├── services/
│   └── reminder.js        # Background reminder poller (every 30s)
├── lib/
│   ├── luce/
│   │   └── index.js       # Luce blockchain RPC client
│   ├── constants/
│   ├── embeds/
│   ├── errors/
│   ├── helpers/
│   ├── middleware/
│   ├── utils/
│   └── validators/
├── database/
│   ├── repositories/
│   │   ├── task.repository.js       # Tasks + reminders queries
│   │   ├── reputation.repository.js # Reputation ledger queries
│   │   └── document.repository.js   # Document queries
│   ├── connection.js
│   ├── index.js
│   └── migrations.js
├── migrations/            # SQL migration files
└── index.js               # Main entry point
```

### Database Schema

**Core tables (existing):**
- `ctfs` — Stores CTF competition details
- `ctf_registrations` — Stores user registrations
- `ctf_challenges` — Stores CTF challenges
- `ctf_challenge_solves` — Tracks challenge solves
- `pacts` — Pact agreements
- `admins` — Admin user IDs

**Blockchain-backed tables (new):**
- `tasks` — Tasks with reference to blockchain block height
- `task_reminders` — Scheduled reminders for task deadlines
- `reputations` — Reputation ledger (one entry per giver per day)
- `documents` — Anchored documents with blockchain reference

---

## Blockchain Block Data Schema

Every block stored on the Luce blockchain has a `data` field containing a JSON
string. Below are the supported schemas with their `type` discriminator.

### 🔹 Task (`type: "task"`)

Created when a user runs `/task add`.

```json
{
  "type": "task",
  "v": 1,
  "taskId": "a1b2c3d4-...",
  "title": "Implement login page",
  "description": "Build the user authentication UI",
  "assignedTo": "123456789012345678",
  "createdBy": "987654321098765432",
  "deadline": 1740000000
}
```

| Field        | Type     | Description                       |
|-------------|----------|-----------------------------------|
| `type`      | `string` | Always `"task"`                   |
| `v`         | `number` | Schema version (currently `1`)    |
| `taskId`    | `string` | UUID v4                           |
| `title`     | `string` | Task title                        |
| `description` | `string` | Task description (may be empty) |
| `assignedTo` | `string` | Discord user ID of assignee       |
| `createdBy` | `string` | Discord user ID of creator        |
| `deadline`  | `number` | Unix timestamp (seconds)          |

### ✅ Task Completion (`type: "task_done"`)

Created when a user runs `/task done`.

```json
{
  "type": "task_done",
  "v": 1,
  "taskId": "a1b2c3d4-...",
  "completedBy": "123456789012345678"
}
```

| Field         | Type     | Description                   |
|---------------|----------|-------------------------------|
| `type`        | `string` | Always `"task_done"`          |
| `v`           | `number` | Schema version (currently `1`)|
| `taskId`      | `string` | UUID of the completed task    |
| `completedBy` | `string` | Discord user ID of completer  |

### 👍 Reputation (`type: "rep"`)

Created via reaction (👍/👎), reply (+1/-1/👍/👎), or `/rep` command.

```json
{
  "type": "rep",
  "v": 1,
  "toUser": "123456789012345678",
  "fromUser": "987654321098765432",
  "amount": 1,
  "reason": "reaction",
  "date": "2026-07-10"
}
```

| Field      | Type     | Description                              |
|-----------|----------|------------------------------------------|
| `type`    | `string` | Always `"rep"`                           |
| `v`       | `number` | Schema version (currently `1`)           |
| `toUser`  | `string` | Discord user ID of recipient             |
| `fromUser`| `string` | Discord user ID of giver                 |
| `amount`  | `number` | `1` (upvote) or `-1` (downvote)          |
| `reason`  | `string` | Trigger source: `"reaction"`, `"reply"`, or `""` (slash command) |
| `date`    | `string` | UTC date in `YYYY-MM-DD` format (enforces daily limit) |

**Daily limit:** A user may only give rep once per UTC calendar day, regardless
of target or sign. This is enforced at both the application and database level.

### 📄 Document (`type: "document"`)

Created when a user runs `/document add`.

```json
{
  "type": "document",
  "v": 1,
  "docId": "a1b2c3d4-...",
  "title": "Meeting Notes 2026-07-10",
  "content": "Discussed sprint goals for Q3...",
  "author": "123456789012345678",
  "mimeType": "text/plain"
}
```

| Field      | Type     | Description                               |
|-----------|----------|-------------------------------------------|
| `type`    | `string` | Always `"document"`                       |
| `v`       | `number` | Schema version (currently `1`)            |
| `docId`   | `string` | UUID v4                                   |
| `title`   | `string` | Document title                            |
| `content` | `string` | Document content (plain text; base64 for binary in future versions) |
| `author`  | `string` | Discord user ID of author                 |
| `mimeType`| `string` | MIME type (default: `"text/plain"`)       |

### Schema Versioning

The `v` field allows future schema evolution without breaking existing blocks.
When introducing a breaking change, increment `v` and handle both versions in
your parser.

---

## Reminder System

A background service (`src/services/reminder.js`) polls every 30 seconds for
unsent task reminders. When a reminder is due (set to 1 hour before the task
deadline), it sends a message to the channel ID `1524933314119467200`.

**Flow:**
1. `/task add` → creates blockchain block + DB row + reminder schedule
2. Reminder service polls `task_reminders` table every 30s
3. Due reminders are sent to channel `1524933314119467200`
4. Reminder is marked `sent = 1` to prevent duplicates

---

## Development

### Project Structure

The bot is built using the [@sapphire/framework](https://www.sapphirejs.dev/) which provides:
- Structured command handling
- Event listener system
- Plugin support
- TypeScript-ready architecture

### Running Tests

```bash
pnpm test
```

### Code Style

This project uses tabs for indentation. Please ensure your editor is configured accordingly.

## Contributing

Contributions are welcome! Please read our comprehensive guides:

- 📖 **[Contributing Guide](CONTRIBUTING.md)** — Detailed contribution guidelines
- 🏗️ **[Project Structure](PROJECT_STRUCTURE.md)** — Understanding the codebase
- 🚀 **[Quick Reference](QUICK_REFERENCE.md)** — Fast reference for common tasks
- 🏛️ **[Architecture](ARCHITECTURE.md)** — System design and patterns
- 📊 **[Changelog](CHANGELOG.md)** — Version history

### Quick Start for Contributors

1. Fork the repository
2. Clone your fork: `git clone https://github.com/YOUR_USERNAME/ctfbot.git`
3. Install dependencies: `pnpm install`
4. Create a branch: `git checkout -b feature/your-feature`
5. Make your changes
6. Run linting: `pnpm run lint:fix`
7. Commit: `git commit -m "feat: add your feature"`
8. Push: `git push origin feature/your-feature`
9. Open a Pull Request

See [CONTRIBUTING.md](CONTRIBUTING.md) for detailed guidelines.

## Roadmap

- [x] Blockchain-backed task management
- [x] Reputation system (+1/-1 with daily limit)
- [x] Document anchoring
- [ ] Additional rep triggers (message content, reactions on other platforms)
- [ ] Web dashboard for blockchain explorer
- [ ] Multi-chain support

## License

This project is licensed under the MIT License — see the [LICENSE](LICENSE) file for details.

## Support

- **Issues:** [GitHub Issues](https://github.com/ucsits/ctfbot/issues)
- **Discord:** Join our server for support and discussions

## Acknowledgments

- Built with [discord.js](https://discord.js.org/)
- Powered by [@sapphire/framework](https://www.sapphirejs.dev/)
- Database: [better-sqlite3](https://github.com/WiseLibs/better-sqlite3)
- Blockchain: [Luce](https://github.com/ucsits/Luce)

---

Made with ❤️ by UCS ITS
