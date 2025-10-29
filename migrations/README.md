# Database Migrations

CTFBot uses a simple SQL-based migration system to manage database schema changes over time.

## What Are Migrations?

Migrations are versioned SQL files that describe changes to the database schema. Each migration is applied once and tracked in the `migrations` table.

## Migration Files

Migrations are stored in the `migrations/` directory with the naming format:

```
XXX_description.sql
```

- `XXX`: Three-digit sequential number (001, 002, 003, etc.)
- `description`: Brief description of the migration (lowercase, underscores)

Example:
- `001_initial_schema.sql`
- `002_add_user_preferences.sql`
- `003_add_ctf_tags.sql`

## Creating a New Migration

### Using the Migration Script (Recommended)

```bash
node scripts/create-migration.js add_user_preferences
```

This creates a new migration file with the correct number and template.

### Manual Creation

1. Check the last migration number in `migrations/`
2. Create a new file with the next number
3. Use this template:

```sql
-- Migration: XXX_description
-- Description: [What this migration does]
-- Date: YYYY-MM-DD

-- Add your SQL statements here

-- Record this migration
INSERT OR IGNORE INTO migrations (name) VALUES ('XXX_description');
```

## Running Migrations

Migrations are automatically run when the bot starts. They can also be run manually:

```javascript
const { runMigrations } = require('./src/lib/migrations');
const { db } = require('./src/database');

const result = runMigrations(db);
console.log('Applied:', result.applied);
console.log('Skipped:', result.skipped);
```

## Migration Best Practices

### Do's ✅

- **One Purpose Per Migration**: Each migration should do one thing
- **Idempotent Operations**: Use `IF NOT EXISTS`, `IF EXISTS` clauses
- **Test Before Committing**: Test migrations on a copy of the database
- **Include Rollback Info**: Add comments explaining how to reverse changes
- **Index Creation**: Create indexes after inserting data for better performance

### Don'ts ❌

- **Don't Modify Existing Migrations**: Once applied, never change a migration
- **Don't Delete Migrations**: Keep all migration files for history
- **Don't Skip Numbers**: Maintain sequential numbering
- **Avoid Breaking Changes**: Consider backwards compatibility

## Example Migrations

### Adding a Column

```sql
-- Migration: 002_add_ctf_difficulty
-- Description: Add difficulty level to CTFs
-- Date: 2025-10-30

ALTER TABLE ctfs ADD COLUMN difficulty TEXT DEFAULT 'medium';

-- Rollback: ALTER TABLE ctfs DROP COLUMN difficulty;

INSERT OR IGNORE INTO migrations (name) VALUES ('002_add_ctf_difficulty');
```

### Creating a New Table

```sql
-- Migration: 003_create_ctf_tags
-- Description: Add tagging system for CTFs
-- Date: 2025-10-30

CREATE TABLE IF NOT EXISTS ctf_tags (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	ctf_id INTEGER NOT NULL,
	tag TEXT NOT NULL,
	FOREIGN KEY (ctf_id) REFERENCES ctfs(id) ON DELETE CASCADE,
	UNIQUE(ctf_id, tag)
);

CREATE INDEX IF NOT EXISTS idx_ctf_tags_ctf_id ON ctf_tags(ctf_id);

-- Rollback: DROP TABLE IF EXISTS ctf_tags;

INSERT OR IGNORE INTO migrations (name) VALUES ('003_create_ctf_tags');
```

### Data Migration

```sql
-- Migration: 004_normalize_urls
-- Description: Ensure all CTF URLs have trailing slash removed
-- Date: 2025-10-30

-- Remove trailing slashes from URLs
UPDATE ctfs
SET ctf_base_url = RTRIM(ctf_base_url, '/')
WHERE ctf_base_url LIKE '%/';

INSERT OR IGNORE INTO migrations (name) VALUES ('004_normalize_urls');
```

## Checking Migration Status

List all migrations and their status:

```javascript
const { listMigrations } = require('./src/lib/migrations');
const { db } = require('./src/database');

const migrations = listMigrations(db);
migrations.forEach(m => {
	console.log(`${m.applied ? '✅' : '⏳'} ${m.name}`);
});
```

## Troubleshooting

### Migration Failed Partway Through

If a migration fails:

1. Check the error message
2. Fix the issue in the database manually if needed
3. Delete the failed migration record:
   ```sql
   DELETE FROM migrations WHERE name = 'XXX_description';
   ```
4. Fix the migration file
5. Run migrations again

### Migration Applied But Not Working

1. Check if the migration actually ran:
   ```sql
   SELECT * FROM migrations WHERE name = 'XXX_description';
   ```
2. Manually inspect the database schema
3. If needed, create a new migration to fix the issue

### Rolling Back a Migration

There's no automatic rollback system. To rollback:

1. Create a new migration that reverses the changes
2. Use the rollback SQL from the original migration comments
3. Apply the new migration

Example:
```sql
-- Migration: 005_rollback_user_preferences
-- Description: Remove user preferences table
-- Date: 2025-10-30

DROP TABLE IF EXISTS user_preferences;

INSERT OR IGNORE INTO migrations (name) VALUES ('005_rollback_user_preferences');
```

## Schema Versioning

The current schema version is determined by the last applied migration. To check:

```sql
SELECT name, applied_at
FROM migrations
ORDER BY applied_at DESC
LIMIT 1;
```

## Production Considerations

- **Backup First**: Always backup the database before running migrations in production
- **Test Thoroughly**: Test migrations on a copy of production data
- **Monitor Performance**: Some migrations (adding indexes, data updates) can be slow
- **Downtime Planning**: For breaking changes, plan for maintenance windows
- **Rollback Plan**: Always have a plan to rollback if something goes wrong

## Future Enhancements

Planned improvements to the migration system:

- [ ] Automatic database backups before migrations
- [ ] Migration dry-run mode
- [ ] Automatic rollback generation
- [ ] Migration dependencies
- [ ] Database versioning in the bot status
