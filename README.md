# CTFBot 🚩

UCS's specialized Discord bot for managing Capture The Flag (CTF) competitions.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen)](https://nodejs.org/)
[![Discord.js](https://img.shields.io/badge/discord.js-v14-blue)](https://discord.js.org/)

## Features

- 📅 **Event Scheduling** - Schedule CTF events with timezone support
- 🏗️ **Channel Management** - Automatically create dedicated CTF channels
- 👥 **User Registration** - Track team member participation
- 🗄️ **Database Storage** - Persistent storage of CTF data and registrations
- 🔗 **CTFd Integration** - Ready for CTFd platform integration (coming soon)

## Commands

### `/schedule`
Schedule custom events with timezone support.

**Parameters:**
- `event_title` (required) - Title of the event
- `event_description` (required) - Description of the event
- `event_date` (required) - Date and time in DD-MM-YYYY HH:MM format
- `timezone` (required) - IANA timezone (e.g., Asia/Jakarta, Europe/London)
- `event_banner` (optional) - Banner image for the event

### `/createctf`
Create a CTF text channel and schedule its event in one go.

**Parameters:**
- `ctf_name` (required) - Name of the CTF competition
- `ctf_date` (required) - Start date in DD-MM-YYYY HH:MM format
- `ctf_base_url` (required) - Base URL of the CTF platform
- `timezone` (required) - IANA timezone
- `event_description` (optional) - Description of the CTF
- `event_banner` (optional) - Banner image

**Permissions Required:** Manage Channels

### `/registerctf`
Register your participation for the CTF in the current channel.

**Parameters:**
- `username` (required) - Your username on the CTF platform
- `ctfd_url` (optional) - CTFd instance URL (if different from CTF base URL)

**Note:** Can only be used in channels starting with `ctf-`

### Utility Commands
- `/ping` - Check bot responsiveness
- `/help` - List all available commands

## Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) v18.0.0 or higher
- [pnpm](https://pnpm.io/) package manager
- A Discord Bot Token ([Create one here](https://discord.com/developers/applications))

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
   - `DISCORD_TOKEN` - Your Discord bot token
   - `GUILD_ID` - Your Discord server ID (for development)
   - `CTF_CATEGORY_ID` - Category ID where CTF channels will be created
   - `CTFD_API_TOKEN` - Your CTFd API token (optional, for future integration)

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
   - Select permissions: `Manage Channels`, `Manage Events`, `Send Messages`, `Embed Links`
   - Copy and visit the generated URL

## Architecture

```
src/
├── commands/          # Slash command implementations
│   ├── createctf.js   # Create CTF channels and events
│   ├── registerctf.js # User registration for CTFs
│   ├── schedule.js    # Generic event scheduling
│   ├── help.js        # List all commands
│   └── ping.js        # Health check
├── listeners/         # Event listeners
│   ├── ready.js       # Bot ready event
│   ├── messageCreate.js
│   └── applicationCommandRegistriesRegistered.js
├── database.js        # SQLite database operations
├── utils.js           # Utility functions
└── index.js           # Main entry point
```

### Database Schema

**ctfs table:**
- Stores CTF competition details
- Tracks channel and event IDs
- Links to guild and creator

**ctf_registrations table:**
- Stores user registrations
- Links to CTF via foreign key
- Supports CTFd integration data

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

- 📖 **[Contributing Guide](CONTRIBUTING.md)** - Detailed contribution guidelines
- 🏗️ **[Project Structure](PROJECT_STRUCTURE.md)** - Understanding the codebase
- 🚀 **[Quick Reference](QUICK_REFERENCE.md)** - Fast reference for common tasks
- 🏛️ **[Architecture](ARCHITECTURE.md)** - System design and patterns
- 📊 **[Changelog](CHANGELOG.md)** - Version history

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

- [ ] CTFd API integration for automatic user/team fetching
- [ ] Commands to view CTF lists and registrations
- [ ] Leaderboard tracking
- [ ] Notification system for CTF reminders
- [ ] Support for multiple CTF platforms
- [ ] Web dashboard for management

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Support

- **Issues:** [GitHub Issues](https://github.com/ucsits/ctfbot/issues)
- **Discord:** Join our server for support and discussions

## Acknowledgments

- Built with [discord.js](https://discord.js.org/)
- Powered by [@sapphire/framework](https://www.sapphirejs.dev/)
- Database: [better-sqlite3](https://github.com/WiseLibs/better-sqlite3)

---

Made with ❤️ by UCS ITS