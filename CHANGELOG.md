# Changelog

All notable changes to CTFBot will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Comprehensive documentation (README.md, CONTRIBUTING.md, PROJECT_STRUCTURE.md)
- Structured library organization (`src/lib/`)
- Constants module for messages, config, and permissions
- Custom error classes for better error handling
- Input validators for URLs, dates, timezones, and usernames
- Date utility functions with timezone support
- CTFd client placeholder for future integration
- JSDoc comments throughout the codebase
- ESLint, Prettier, and EditorConfig for code style
- Enhanced .env.example with detailed comments
- Database migration system
- Migration documentation

### Changed
- Reorganized codebase into logical modules
- Moved utility functions to `src/lib/utils/`
- Improved error handling with custom error classes
- Better separation of concerns

### Deprecated
- `src/utils.js` now re-exports from `src/lib/utils/` for backwards compatibility

## [0.1.0] - 2025-10-29

### Added
- Initial bot scaffolding with @sapphire/framework
- `/ping` command for health checks
- `/help` command to list available commands
- `/schedule` command for generic event scheduling
- `/createctf` command to create CTF channels and events
- `/registerctf` command for user registration
- SQLite database with better-sqlite3
- Automatic command ID tracking
- Timezone conversion utilities
- Database tables for CTFs and registrations
- Event listeners for ready and command registration

### Fixed
- Timezone conversion issues with DD-MM-YYYY format
- Command registration with idHints for faster updates

[Unreleased]: https://github.com/ucsits/ctfbot/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/ucsits/ctfbot/releases/tag/v0.1.0
