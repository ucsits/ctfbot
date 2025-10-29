# Contributing to CTFBot

First off, thank you for considering contributing to CTFBot! 🎉

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [Development Workflow](#development-workflow)
- [Code Style Guidelines](#code-style-guidelines)
- [Commit Message Conventions](#commit-message-conventions)
- [Pull Request Process](#pull-request-process)
- [Project Structure](#project-structure)
- [Testing](#testing)
- [Need Help?](#need-help)

## Code of Conduct

This project and everyone participating in it is governed by our commitment to fostering an open and welcoming environment. Please be respectful and constructive in all interactions.

## Getting Started

### Prerequisites

- Node.js v18.0.0 or higher
- pnpm package manager
- A Discord Bot Token for testing
- Basic knowledge of Discord.js and JavaScript

### Setting Up Your Development Environment

1. **Fork the repository**
   
   Click the "Fork" button at the top right of the repository page.

2. **Clone your fork**
   ```bash
   git clone https://github.com/YOUR_USERNAME/ctfbot.git
   cd ctfbot
   ```

3. **Add upstream remote**
   ```bash
   git remote add upstream https://github.com/ucsits/ctfbot.git
   ```

4. **Install dependencies**
   ```bash
   pnpm install
   ```

5. **Set up environment variables**
   ```bash
   cp .env.example .env
   ```
   
   Fill in your Discord bot token and other required values in `.env`.

6. **Run the bot in development mode**
   ```bash
   pnpm dev
   ```

## Development Workflow

1. **Create a new branch**
   ```bash
   git checkout -b feature/your-feature-name
   # or
   git checkout -b fix/your-bug-fix
   ```

2. **Make your changes**
   - Write clean, readable code
   - Follow the code style guidelines
   - Add comments for complex logic
   - Test your changes thoroughly

3. **Commit your changes**
   ```bash
   git add .
   git commit -m "feat: add new feature description"
   ```

4. **Keep your branch up to date**
   ```bash
   git fetch upstream
   git rebase upstream/main
   ```

5. **Push to your fork**
   ```bash
   git push origin feature/your-feature-name
   ```

6. **Create a Pull Request**
   - Go to the original repository
   - Click "New Pull Request"
   - Select your fork and branch
   - Fill in the PR template with details

## Code Style Guidelines

### General Principles

- **Use tabs for indentation** (not spaces)
- Write descriptive variable and function names
- Keep functions small and focused (single responsibility)
- Add JSDoc comments for all exported functions and classes
- Handle errors gracefully with meaningful error messages

### JavaScript Style

```javascript
// ✅ Good
const { Command } = require('@sapphire/framework');

class MyCommand extends Command {
	/**
	 * Description of what this function does
	 * @param {Object} param - Parameter description
	 * @returns {Promise<void>}
	 */
	async chatInputRun(interaction) {
		// Implementation
	}
}

// ❌ Bad - spaces instead of tabs, no JSDoc
const { Command } = require('@sapphire/framework');
class MyCommand extends Command{
async chatInputRun(interaction){
// Implementation
}
}
```

### File Naming

- Use camelCase for file names: `myCommand.js`
- Use PascalCase for class names: `class MyCommand`
- Use SCREAMING_SNAKE_CASE for constants: `const DEFAULT_TIMEOUT = 5000`

### Command Structure

All commands should follow this structure:

```javascript
const { Command } = require('@sapphire/framework');
const { getIdHints } = require('../utils');

class YourCommand extends Command {
	constructor(context, options) {
		super(context, {
			...options,
			name: 'commandname',
			description: 'Brief description of what the command does'
		});
	}

	registerApplicationCommands(registry) {
		registry.registerChatInputCommand(
			(builder) =>
				builder
					.setName(this.name)
					.setDescription(this.description)
					// Add options here
			,
			{
				idHints: getIdHints(this.name)
			}
		);
	}

	async chatInputRun(interaction) {
		// Command implementation
	}
}

module.exports = { YourCommand };
```

## Commit Message Conventions

We follow the [Conventional Commits](https://www.conventionalcommits.org/) specification:

### Format

```
<type>(<scope>): <subject>

<body>

<footer>
```

### Types

- `feat`: A new feature
- `fix`: A bug fix
- `docs`: Documentation changes
- `style`: Code style changes (formatting, missing semicolons, etc.)
- `refactor`: Code refactoring without changing functionality
- `perf`: Performance improvements
- `test`: Adding or updating tests
- `chore`: Maintenance tasks, dependency updates

### Examples

```
feat(commands): add leaderboard command

Add a new command to display CTF leaderboards with rankings
and participant statistics.

Closes #123
```

```
fix(database): prevent duplicate registrations

Fixed an issue where users could register multiple times for
the same CTF by adding a UNIQUE constraint.

Fixes #456
```

## Pull Request Process

### Before Submitting

- [ ] Code follows the style guidelines
- [ ] All tests pass (if applicable)
- [ ] New code has JSDoc comments
- [ ] README is updated if needed
- [ ] Commit messages follow conventions
- [ ] Branch is up to date with main

### PR Title Format

Use the same format as commit messages:

```
feat: add new feature
fix: resolve bug with X
docs: update installation guide
```

### PR Description Template

```markdown
## Description
Brief description of the changes

## Type of Change
- [ ] Bug fix
- [ ] New feature
- [ ] Breaking change
- [ ] Documentation update

## Testing
Describe how you tested your changes

## Screenshots (if applicable)
Add screenshots here

## Checklist
- [ ] Code follows style guidelines
- [ ] Self-reviewed the code
- [ ] Added JSDoc comments
- [ ] Updated documentation
```

### Review Process

1. At least one maintainer must approve the PR
2. All CI checks must pass (when implemented)
3. Resolve all review comments
4. Keep discussions professional and constructive

## Project Structure

```
ctfbot/
├── src/
│   ├── commands/          # Command implementations
│   │   ├── createctf.js
│   │   ├── registerctf.js
│   │   └── ...
│   ├── listeners/         # Event listeners
│   │   ├── ready.js
│   │   └── ...
│   ├── database.js        # Database operations
│   ├── utils.js           # Utility functions
│   └── index.js           # Entry point
├── .env.example           # Environment template
├── .gitignore
├── package.json
├── README.md
├── CONTRIBUTING.md
└── LICENSE
```

### Adding a New Command

1. Create `src/commands/yourcommand.js`
2. Extend the `Command` class from `@sapphire/framework`
3. Implement `registerApplicationCommands()` and `chatInputRun()`
4. Use `getIdHints()` for command ID tracking
5. Add proper error handling
6. Test thoroughly in a development Discord server

### Adding Database Operations

1. Add your function to `src/database.js` in the appropriate section
2. Use prepared statements for SQL queries
3. Add JSDoc comments with parameter types and return values
4. Handle errors appropriately
5. Consider transaction safety for multi-step operations

## Testing

Currently, testing is done manually in a development Discord server.

### Manual Testing Checklist

- [ ] Command appears in Discord slash command menu
- [ ] All required parameters are validated
- [ ] Optional parameters work as expected
- [ ] Error messages are clear and helpful
- [ ] Permissions are checked correctly
- [ ] Database operations succeed
- [ ] Bot responds within reasonable time

### Future: Automated Testing

We plan to add:
- Unit tests with Jest
- Integration tests for commands
- Database migration tests

## Need Help?

- **Discord:** Join our server for real-time help
- **Issues:** Check [existing issues](https://github.com/ucsits/ctfbot/issues) or create a new one
- **Discussions:** Use [GitHub Discussions](https://github.com/ucsits/ctfbot/discussions) for questions

## Recognition

Contributors will be acknowledged in:
- README contributors section
- Release notes for significant contributions
- Our Discord server with special roles

Thank you for contributing to CTFBot! 🚀
