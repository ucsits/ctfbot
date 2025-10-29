# Project Structure

This document explains the organization of the CTFBot codebase to help contributors navigate and understand the project.

## Directory Layout

```
ctfbot/
├── src/                          # Source code
│   ├── commands/                 # Slash command implementations
│   │   ├── createctf.js         # Create CTF channels and events
│   │   ├── registerctf.js       # User registration for CTFs
│   │   ├── schedule.js          # Generic event scheduling
│   │   ├── help.js              # Help command
│   │   └── ping.js              # Ping command
│   │
│   ├── listeners/                # Event listeners
│   │   ├── ready.js             # Bot ready event
│   │   ├── messageCreate.js     # Message events
│   │   └── applicationCommandRegistriesRegistered.js  # Auto-save command IDs
│   │
│   ├── lib/                      # Shared library code
│   │   ├── constants/           # Constants and configuration
│   │   │   ├── messages.js      # User-facing messages
│   │   │   ├── config.js        # Bot configuration
│   │   │   ├── permissions.js   # Permission constants
│   │   │   └── index.js         # Exports all constants
│   │   │
│   │   ├── utils/               # Utility functions
│   │   │   ├── date.js          # Date and timezone utilities
│   │   │   ├── commandIds.js    # Command ID management
│   │   │   └── index.js         # Exports all utils
│   │   │
│   │   ├── validators/          # Input validation
│   │   │   └── index.js         # All validation functions
│   │   │
│   │   ├── errors/              # Custom error classes
│   │   │   └── index.js         # Error class definitions
│   │   │
│   │   └── ctfd/                # CTFd API integration
│   │       └── index.js         # CTFd client (placeholder)
│   │
│   ├── database.js              # SQLite database operations
│   ├── utils.js                 # Backwards compatibility (deprecated)
│   ├── index.js                 # Entry point
│   └── commandIds.json          # Auto-generated command IDs
│
├── .env                         # Environment variables (not in git)
├── .env.example                 # Environment template
├── .gitignore                   # Git ignore rules
├── .editorconfig                # Editor configuration
├── .eslintrc.json               # ESLint configuration
├── .prettierrc.json             # Prettier configuration
├── package.json                 # Package manifest
├── pnpm-lock.yaml               # Package lock file
├── README.md                    # Project documentation
├── CONTRIBUTING.md              # Contribution guidelines
├── PROJECT_STRUCTURE.md         # This file
└── LICENSE                      # MIT License
```

## Module Descriptions

### Commands (`src/commands/`)

Each command file exports a class that extends `@sapphire/framework`'s `Command` class:

- **createctf.js** - Creates dedicated CTF channels, schedules events, and stores data in the database
- **registerctf.js** - Registers user participation in CTFs with optional CTFd integration
- **schedule.js** - Generic event scheduling with timezone support
- **help.js** - Lists all available commands
- **ping.js** - Simple health check command

### Listeners (`src/listeners/`)

Event handlers that respond to Discord events:

- **ready.js** - Triggered when the bot successfully connects to Discord
- **messageCreate.js** - Handles incoming messages (if needed)
- **applicationCommandRegistriesRegistered.js** - Automatically saves command IDs for faster updates

### Library (`src/lib/`)

Shared, reusable code organized by purpose:

#### Constants (`src/lib/constants/`)

Centralized configuration and static values:

- **messages.js** - All user-facing text (errors, success messages, embed descriptions)
- **config.js** - Bot configuration (durations, colors, rate limits)
- **permissions.js** - Permission bit flags and names

#### Utils (`src/lib/utils/`)

Helper functions used across the codebase:

- **date.js** - Date parsing, timezone conversion, Discord timestamp formatting
- **commandIds.js** - Command ID storage and retrieval for faster Discord updates

#### Validators (`src/lib/validators/`)

Input validation and sanitization:

- Functions to validate URLs, dates, timezones, usernames, etc.
- Throws `ValidationError` for invalid input

#### Errors (`src/lib/errors/`)

Custom error classes for better error handling:

- `CTFBotError` - Base error class
- `ValidationError` - Invalid user input
- `PermissionError` - Permission issues
- `DatabaseError` - Database failures
- `ExternalAPIError` - External API failures (e.g., CTFd)
- `ConfigurationError` - Configuration problems

#### CTFd (`src/lib/ctfd/`)

CTFd platform integration (work in progress):

- **index.js** - CTFd API client for fetching user and team data

### Database (`src/database.js`)

SQLite database operations using `better-sqlite3`:

- **Schema Management** - Creates and maintains database tables
- **ctfOperations** - CRUD operations for CTF data
- **registrationOperations** - CRUD operations for user registrations

### Main Entry (`src/index.js`)

Application entry point:

1. Loads environment variables
2. Initializes database
3. Creates Sapphire client
4. Logs in to Discord

## Design Patterns

### Command Pattern

All commands follow a consistent structure:

```javascript
class MyCommand extends Command {
	constructor(context, options) {
		super(context, { ...options, name: 'mycommand', description: '...' });
	}

	registerApplicationCommands(registry) {
		// Define slash command options
	}

	async chatInputRun(interaction) {
		// Handle command execution
	}
}
```

### Error Handling

Use custom error classes that indicate how errors should be displayed:

```javascript
throw new ValidationError('Invalid input', { ephemeral: true });
```

### Validation Before Processing

Always validate input before processing:

```javascript
validateURL(url);
validateDateFormat(dateStr);
validateTimezone(timezone);
// Then proceed with processing
```

### Database Operations

Use the exported operations objects:

```javascript
const { ctfOperations, registrationOperations } = require('./database');

const ctfId = ctfOperations.createCTF(data);
registrationOperations.registerUser({ ctf_id: ctfId, ... });
```

## File Naming Conventions

- **Commands:** `commandname.js` (lowercase)
- **Listeners:** `eventname.js` (camelCase)
- **Utilities:** `purpose.js` (lowercase)
- **Classes:** PascalCase in code, lowercase filenames
- **Constants:** SCREAMING_SNAKE_CASE in code

## Adding New Features

### Adding a New Command

1. Create `src/commands/yourcommand.js`
2. Extend the `Command` class
3. Import utilities from `src/lib/utils`
4. Use constants from `src/lib/constants`
5. Use validators from `src/lib/validators`
6. Handle errors with custom error classes

### Adding Database Tables

1. Add schema creation in `initDatabase()` function in `src/database.js`
2. Create operation functions (create, read, update, delete)
3. Export operations in a namespace object
4. Document with JSDoc comments

### Adding Utility Functions

1. Determine the appropriate category (date, validation, etc.)
2. Add function to the relevant file in `src/lib/`
3. Export from the category's `index.js`
4. Add comprehensive JSDoc comments
5. Consider writing tests (future)

## Code Style

- **Indentation:** Tabs (not spaces)
- **Quotes:** Single quotes for strings
- **Semicolons:** Always use semicolons
- **Comments:** JSDoc for all exported functions
- **Error Handling:** Use try-catch with custom errors
- **Async/Await:** Prefer over promises

## Testing

Currently manual testing in a development Discord server. Automated testing coming soon.

## Documentation

All exported functions should have JSDoc comments:

```javascript
/**
 * Brief description
 * 
 * @param {Type} paramName - Parameter description
 * @returns {ReturnType} Return value description
 * @throws {ErrorType} When error occurs
 * 
 * @example
 * const result = myFunction('value');
 */
```

## Future Structure Plans

- `tests/` - Unit and integration tests
- `docs/` - Generated API documentation
- `scripts/` - Utility scripts (migration, backup)
- `migrations/` - Database migration files

## Questions?

- Check [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines
- Open an issue for questions or suggestions
- Join our Discord for real-time help
