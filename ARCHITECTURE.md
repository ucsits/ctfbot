# CTFBot Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                         Discord API                             │
└────────────────────────┬────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│                    src/index.js (Entry Point)                   │
│  • Initialize Database                                          │
│  • Create Sapphire Client                                       │
│  • Login to Discord                                             │
└───────────┬─────────────────────────────────────────────────────┘
            │
    ┌───────┴───────┐
    │               │
    ▼               ▼
┌────────────┐  ┌──────────────────────────────────┐
│ Listeners  │  │          Commands                │
│            │  │                                  │
│ • ready    │  │ • /ping       • /help           │
│ • message  │  │ • /schedule   • /createctf      │
│ • commands │  │ • /registerctf                  │
└──────┬─────┘  └────────┬─────────────────────────┘
       │                 │
       └────────┬────────┘
                │
    ┌───────────┴──────────────┐
    │                          │
    ▼                          ▼
┌────────────────────┐  ┌──────────────────────────┐
│   src/lib/         │  │   src/database.js        │
│                    │  │                          │
│ ┌────────────────┐ │  │ • initDatabase()         │
│ │ constants/     │ │  │ • ctfOperations          │
│ │ • messages     │ │  │ • registrationOperations │
│ │ • config       │ │  │                          │
│ │ • permissions  │ │  └──────────┬───────────────┘
│ └────────────────┘ │             │
│                    │             │
│ ┌────────────────┐ │             ▼
│ │ utils/         │ │  ┌──────────────────────────┐
│ │ • date         │ │  │   SQLite Database        │
│ │ • commandIds   │ │  │                          │
│ └────────────────┘ │  │ Tables:                  │
│                    │  │ • ctfs                   │
│ ┌────────────────┐ │  │ • ctf_registrations      │
│ │ validators/    │ │  │ • migrations             │
│ │ • URL          │ │  └──────────────────────────┘
│ │ • Date         │ │
│ │ • Timezone     │ │
│ └────────────────┘ │
│                    │
│ ┌────────────────┐ │
│ │ errors/        │ │
│ │ • Validation   │ │
│ │ • Permission   │ │
│ │ • Database     │ │
│ └────────────────┘ │
│                    │
│ ┌────────────────┐ │
│ │ ctfd/          │ │
│ │ • CTFdClient   │ │
│ └────────────────┘ │
│                    │
│ • migrations.js    │
└────────────────────┘


Data Flow Example: /createctf Command
═════════════════════════════════════

User → Discord → Bot
                  │
                  ▼
            [createctf.js]
                  │
          ┌───────┴───────┐
          │               │
          ▼               ▼
    [validators]    [constants]
    validateURL()   ERRORS.PERMISSION_DENIED
    validateDate()  COLORS.SUCCESS
          │               │
          └───────┬───────┘
                  │
                  ▼
            [utils/date]
        parseLocalDateToUTC()
                  │
                  ▼
         [Discord API]
      Create Channel & Event
                  │
                  ▼
          [database.js]
       ctfOperations.createCTF()
                  │
                  ▼
         [SQLite Database]
        Store CTF Details
                  │
                  ▼
        Success Response → User


Module Dependencies
═══════════════════

commands/        →  lib/utils
                 →  lib/constants
                 →  lib/validators
                 →  lib/errors
                 →  database

listeners/       →  lib/utils
                 →  lib/constants

database         →  lib/migrations

lib/validators   →  lib/errors

lib/ctfd         →  lib/errors


Configuration Flow
═════════════════

.env (Environment Variables)
  │
  ├─→ DISCORD_TOKEN      → src/index.js
  ├─→ GUILD_ID           → src/index.js
  ├─→ CTF_CATEGORY_ID    → commands/createctf.js
  └─→ CTFD_API_TOKEN     → lib/ctfd/index.js


Migration System
════════════════

migrations/*.sql
       │
       ▼
  migrations.js
   (Runner)
       │
       ▼
  migrations table
   (Tracking)
       │
       ▼
  Database Schema
  (Up to date)


Development Tools
════════════════

┌─────────────┐
│ .eslintrc   │──→ Code Linting
├─────────────┤
│ .prettierrc │──→ Code Formatting
├─────────────┤
│.editorconfig│──→ Editor Settings
└─────────────┘


Documentation Structure
══════════════════════

README.md           → User-facing docs
CONTRIBUTING.md     → Contributor guide
PROJECT_STRUCTURE.md→ Architecture docs
CHANGELOG.md        → Version history
migrations/README.md→ Migration guide
REFACTORING_SUMMARY.md→ This refactoring
```

## Key Design Patterns

### 1. Separation of Concerns
- Commands handle Discord interactions
- Database handles data persistence
- Validators handle input validation
- Utils handle shared logic

### 2. Dependency Injection
- Commands receive `context` and `options`
- Database operations are stateless
- Utils are pure functions

### 3. Error Handling
- Custom error classes with metadata
- Errors flow up to command handlers
- User-friendly error messages

### 4. Configuration Management
- Environment variables for secrets
- Constants for application config
- Easy to change without code edits

### 5. Database Abstraction
- Operations objects hide SQL details
- Prepared statements for security
- Transaction support where needed

## Future Architecture Plans

```
┌────────────────────────────────────┐
│         Web Dashboard              │
│     (Future Enhancement)           │
└──────────────┬─────────────────────┘
               │
               ▼
┌────────────────────────────────────┐
│        REST API Layer              │
│     (Future Enhancement)           │
└──────────────┬─────────────────────┘
               │
               ▼
    [Current Bot Architecture]
```

Planned additions:
- REST API for web dashboard
- WebSocket for real-time updates
- Redis for caching
- Bull for job queues
- Testing framework (Jest)
- CI/CD pipeline
