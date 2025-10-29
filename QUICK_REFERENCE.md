# Quick Reference Guide for Contributors

Fast reference for common tasks when contributing to CTFBot.

## Table of Contents
- [Getting Started](#getting-started)
- [Common Tasks](#common-tasks)
- [Code Examples](#code-examples)
- [Useful Commands](#useful-commands)
- [File Locations](#file-locations)

## Getting Started

```bash
# Clone and setup
git clone https://github.com/ucsits/ctfbot.git
cd ctfbot
pnpm install
cp .env.example .env
# Edit .env with your values

# Run in development
pnpm dev

# Check code style
pnpm run lint
pnpm run format:check
```

## Common Tasks

### Adding a New Command

1. Create `src/commands/mycommand.js`:
```javascript
const { Command } = require('@sapphire/framework');
const { getIdHints } = require('../lib/utils');

class MyCommand extends Command {
	constructor(context, options) {
		super(context, { ...options, name: 'mycommand', description: 'Does something cool' });
	}

	registerApplicationCommands(registry) {
		registry.registerChatInputCommand(
			(builder) => builder.setName(this.name).setDescription(this.description),
			{ idHints: getIdHints(this.name) }
		);
	}

	async chatInputRun(interaction) {
		await interaction.reply('Hello!');
	}
}

module.exports = { MyCommand };
```

2. Restart the bot - command appears automatically!

### Adding Database Operations

In `src/database.js`:

```javascript
// Add to appropriate operations object
myOperation: (param) => {
	const stmt = db.prepare('SELECT * FROM table WHERE id = ?');
	return stmt.get(param);
}
```

### Creating a Migration

```bash
# Create a new migration file
node -e "require('./src/lib/migrations').createMigration('add_my_feature')"

# Edit migrations/XXX_add_my_feature.sql
# Restart bot to apply
```

### Adding Constants

In `src/lib/constants/messages.js`:

```javascript
MY_ERROR: '❌ Something went wrong',
MY_SUCCESS: '✅ Success!'
```

Use in code:
```javascript
const { ERRORS, SUCCESS } = require('../lib/constants');
await interaction.reply(ERRORS.MY_ERROR);
```

### Adding a Validator

In `src/lib/validators/index.js`:

```javascript
function validateMyInput(input) {
	if (!input.match(/pattern/)) {
		throw new ValidationError('❌ Invalid format');
	}
	return true;
}

module.exports = { /* ... */, validateMyInput };
```

### Handling Errors

```javascript
const { ValidationError, DatabaseError } = require('../lib/errors');

try {
	validateMyInput(input);
	const result = await doSomething();
} catch (error) {
	if (error instanceof ValidationError) {
		return interaction.reply({ content: error.message, ephemeral: true });
	}
	throw error; // Let framework handle it
}
```

## Code Examples

### Creating an Embed

```javascript
const { EmbedBuilder } = require('discord.js');
const { COLORS, FIELDS } = require('../lib/constants');

const embed = new EmbedBuilder()
	.setColor(COLORS.SUCCESS)
	.setTitle('My Title')
	.setDescription('My description')
	.addFields(
		{ name: FIELDS.EVENT_TITLE, value: 'Value', inline: true }
	)
	.setTimestamp();

await interaction.reply({ embeds: [embed] });
```

### Database Query

```javascript
const { ctfOperations } = require('../database');

// Create
const id = ctfOperations.createCTF({
	guild_id: '123',
	channel_id: '456',
	// ... other fields
});

// Read
const ctf = ctfOperations.getCTFById(id);
const allCtfs = ctfOperations.getCTFsByGuild('123');

// Delete
ctfOperations.deleteCTF(id);
```

### Date Handling

```javascript
const { parseLocalDateToUTC, formatDiscordTimestamp } = require('../lib/utils');

// Parse user input
const date = parseLocalDateToUTC('31-12-2025 20:00', 'Asia/Jakarta');

// Display in Discord
const timestamp = formatDiscordTimestamp(date);
await interaction.reply(`Event starts ${timestamp}`);
```

### Permission Check

```javascript
const { COMMAND_PERMISSIONS, PERMISSION_NAMES } = require('../lib/constants');

if (!interaction.member.permissions.has(COMMAND_PERMISSIONS.CREATE_CTF)) {
	const permName = PERMISSION_NAMES[COMMAND_PERMISSIONS.CREATE_CTF];
	return interaction.reply({
		content: `❌ You need the "${permName}" permission.`,
		ephemeral: true
	});
}
```

## Useful Commands

```bash
# Development
pnpm dev                 # Run with auto-reload
pnpm start              # Run normally

# Code Quality
pnpm run lint           # Check for issues
pnpm run lint:fix       # Fix issues automatically
pnpm run format         # Format code
pnpm run format:check   # Check formatting

# Git
git checkout -b feature/my-feature
git add .
git commit -m "feat: add new feature"
git push origin feature/my-feature

# Database
sqlite3 ctfbot.db       # Open database
.tables                 # Show tables
.schema ctfs            # Show schema
SELECT * FROM migrations; # Check applied migrations
```

## File Locations

### Need to...

**Add a command?**
→ `src/commands/mycommand.js`

**Add a listener?**
→ `src/listeners/myevent.js`

**Add a utility function?**
→ `src/lib/utils/category.js`

**Add validation?**
→ `src/lib/validators/index.js`

**Add error message?**
→ `src/lib/constants/messages.js`

**Add configuration?**
→ `src/lib/constants/config.js`

**Add database operation?**
→ `src/database.js`

**Add migration?**
→ `migrations/XXX_description.sql`

**Update docs?**
→ `README.md` or `CONTRIBUTING.md`

**Add dependencies?**
→ `pnpm add package-name`

## Quick Debug Checklist

### Command not appearing?
- [ ] Check GUILD_ID in .env
- [ ] Restart bot
- [ ] Check bot has application.commands scope
- [ ] Check console for errors

### Command failing?
- [ ] Check console logs
- [ ] Add `console.log()` in chatInputRun
- [ ] Check permissions
- [ ] Verify environment variables

### Database issues?
- [ ] Check ctfbot.db exists
- [ ] Run `sqlite3 ctfbot.db` and query
- [ ] Check migrations applied
- [ ] Check foreign key constraints

### Timezone problems?
- [ ] Use IANA timezone names
- [ ] Check date format (DD-MM-YYYY HH:MM)
- [ ] Test with known timezone
- [ ] Check parseLocalDateToUTC logic

## Testing Checklist

Before submitting PR:

- [ ] Code follows style guide (run `pnpm run lint`)
- [ ] Code is formatted (run `pnpm run format`)
- [ ] Added JSDoc comments
- [ ] Tested command in Discord
- [ ] Verified database operations
- [ ] Updated documentation if needed
- [ ] No console errors
- [ ] Git commit message follows convention

## Getting Help

- **Discord:** Join our server
- **Issues:** [GitHub Issues](https://github.com/ucsits/ctfbot/issues)
- **Docs:** Check README.md and CONTRIBUTING.md
- **Code:** Read existing commands for examples

## Quick Tips

💡 **Copy existing commands** - They have all the patterns you need

💡 **Use constants** - Don't hardcode messages or config

💡 **Validate early** - Check input before processing

💡 **Handle errors** - Use try-catch and custom errors

💡 **Document code** - Add JSDoc comments

💡 **Test thoroughly** - Try edge cases

💡 **Keep it simple** - One function, one purpose

💡 **Ask questions** - Better to ask than guess!

---

Happy coding! 🚀
