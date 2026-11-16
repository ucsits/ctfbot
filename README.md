# CTFBot

UCS's specialized Discord bot for managing Capture The Flag (CTF) competitions,
now with **blockchain-backed task tracking, reputation, and document anchoring**
powered by [Luce](https://github.com/ucsits/Luce).

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen)](https://nodejs.org/)
[![Discord.js](https://img.shields.io/badge/discord.js-v14-blue)](https://discord.js.org/)

## Features

- **Event Scheduling** for CTF events with timezone support
- **Channel Management** that creates dedicated CTF channels automatically
- **User Registration** for tracking team member participation
- **Database Storage** for persistent CTF data and registrations
- **CTFd Integration** ready for platform integration (coming soon)
- **Blockchain-Backed Tasks** with an immutable audit trail
- **Reputation System** with +1/-1 rep via reactions, replies, or the `/rep` command
- **Document Anchoring** that stores documents on the blockchain permanently
- **Activity Points Economy** with admin-granted points, a leaderboard, and a merchandise store (AP or Rp)
- **Automatic Reminders** sent to a dedicated channel for task deadlines
- **Proactive Chat** that lets the bot join conversations on its own, with web search, channel memory and server-wide personality memory, within a per-channel budget

## Commands

### CTF Commands
- `/schedule` schedules custom events with timezone support
- `/createctf` creates a CTF text channel and schedules its event
- `/registerctf` registers your participation for the CTF in the current channel
- `/addchalctf` adds challenges to a CTF
- `/solvectf` marks a challenge as solved
- `/archivectf` archives a completed CTF
- `/chalpts` shows challenge points
- `/summarizectf` shows the CTF summary
- `/syncchallenges` syncs challenges and solves from the configured platform
- `/setctfplatform` selects the CTF platform for this channel and sets its API details
- `/pact` manages pacts

### Task Commands
- `/task add` creates a new task (title, description, assignee, deadline, optional timezone)
- `/task list [period]` shows remaining tasks for this week/month/quarter/year
- `/task done <task_id | task>` marks a task as completed (by UUID or fuzzy title search)
- `/task cancel <task_id | task>` confirms and cancels a pending task (by UUID or fuzzy title search), removing its reminders

Task reports use Asia/Jakarta calendar boundaries. Large lists are split into multiple responses.

**Completing or cancelling by title.** Pass the task title, or a distinctive part of it, as the `task` option. The bot fuzzy-searches all pending tasks. A fuzzy match can be wrong. Every title-based completion or cancellation therefore requires an ephemeral confirmation with Confirm and Deny buttons before anything is recorded. Nothing is written to the blockchain or the database until you confirm. If several tasks match closely, a picker shows one button per candidate. UUID-based completion and cancellation also ask for confirmation for consistency. Cancellation additionally removes the task's reminders.

### Reputation Commands
- `/rep [downvote]` gives +1 or -1 rep. It must reply to someone's message, and the response is ephemeral.
- `/repleaderboard [limit]` shows the reputation leaderboard

You can also give rep by reacting or replying.
- Reacting with 👍 or 👎 to someone's message
- Replying to someone with `+1`, `-1`, 👍, or 👎

### Document Commands
- `/document add` anchors a document to the blockchain
- `/document get` retrieves an anchored document

### Activity Points Commands
- `/activitypoints [user]` shows your activity points balance, or another user's
- `/activityleaderboard [limit]` shows the activity points leaderboard
- `/giveap <user|role> <points>` grants activity points to a user or every member of a role (admin only)
- `/giveapbulk <csv>` grants activity points to many users from a CSV with `discord_id` and `points` columns (admin only)
- `/store` browses and buys from the merchandise store with AP or Rp (no subcommand)
- `/store-confirm <purchase_id>` confirms a pending Rp purchase once offline payment arrives (admin only)

### Utility Commands
- `/ping` checks bot responsiveness
- `/help` lists all available commands

## CTF Platform Support

Every CTF channel is bound to exactly one platform. The binding is stored on the
`ctfs` row, which commands read instead of guessing.

| Column | Purpose |
| --- | --- |
| `platform` | Adapter id, either `ctfd` or `noctf`. Defaults to `ctfd` for every pre-existing row. |
| `api_base_url` | API origin to talk to. Needed because noCTF serves its API from a different origin than its web UI. Falls back to the CTF URL when unset. |
| `platform_division_id` | Scoreboard division, required by noCTF and unused by CTFd. |

The token is still stored in `ctfs.api_token`. CTFd sends it as
`Authorization: Token <api_token>`, while noCTF sends it as
`Authorization: Bearer <token>` and expects a copied session token. A noCTF
session token lasts 7 days and has no refresh endpoint. Replace it
periodically with `/setctfplatform`.

### Choosing a platform

```
/setctfplatform platform:noctf api_base_url:https://api-k17ctf.secso.cc api_token:<token> division_id:2
/setctfplatform show:true
```

`/setctfplatform` needs the Manage Channels permission, and admins and
governance users bypass that check like every other privileged command. The
command probes the platform before it persists anything, and it reports whether
the API answered, whether the CTF is currently active, and which division it
used.

### Behaviour differences

| Concern | CTFd | noCTF |
| --- | --- | --- |
| Challenge listing | `/api/v1/challenges` | `/challenges`, gated on the competition being active unless the token carries admin policies |
| Category | `category` field | Derived from `tags.categories`, taking the first comma separated entry, falling back to `uncategorized` |
| Solve attribution | Per user via `/api/v1/challenges/:id/solves` | Team scoped. `/challenges/:id/solves` returns only a team id. The scoreboard endpoint recovers the user id. |
| Scoreboard | `/api/v1/scoreboard` | `/scoreboard/divisions/:id`. A division id is required. |
| Bulk solve listing | Not available | `/scoreboard/divisions/:id` carries every solve in the division, not just the bot's teams |

When noCTF reports a solve for a team, the sync attributes it to a registered
member of that team. If no member is registered yet, the solve is parked under a
per-platform synthetic user id (`noctf:<id>` or `ctfd:<id>`) and `/registerctf`
claims it later. The prefix is per platform, which prevents a registration on
one platform from claiming a numeric id from the other.

The noCTF bulk listing is division-wide and the token cannot narrow it. The
platform serves the scoreboard and `/users/query` publicly and never filters by
the caller's membership. Scope therefore comes from the registrations in the
channel. A solve belonging to a registered Discord user is always recorded. An
unregistered solver is only parked when their team matches a team someone has
already registered. A sync therefore never imports the rest of the division.
Because scope is the registered teams, a solve is only parked once at least one
teammate has run `/registerctf`. The first member of a team to register has
nothing waiting to be claimed.

### Adding another platform

1. Add an entry to `PLATFORMS` in `src/lib/constants/platforms.js`. The `id` is
   persisted in `ctfs.platform` and must stay stable.
2. Add a factory to `FACTORIES` in `src/lib/platform/index.js` that returns the
   normalized client interface documented at the top of that file.
3. Add a prefix to `PREFIX_BY_PLATFORM` in `src/lib/platform/syntheticUser.js`.

Commands only ever call `createPlatformClient`. They pick the new platform up
without further changes.

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
   
   Edit `.env` and fill in the required values.
   - `DISCORD_TOKEN` holds your Discord bot token
   - `GUILD_ID` holds your Discord server ID (for development)
   - `CTF_CATEGORY_ID` holds the category ID where CTF channels will be created
   - `CTFD_API_TOKEN` holds your CTFd API token (optional)
   - `LUCE_PORT` holds the Luce blockchain RPC port (default 5500)

4. **Run the bot**
   
   Development mode (with auto-reload).
   ```bash
   pnpm dev
   ```
   
   Production mode.
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
   - Select the `bot` and `applications.commands` scopes
   - Select the `Manage Channels`, `Manage Events`, `Send Messages`, `Embed Links`, `Add Reactions`, `Read Message History` permissions
   - Copy and visit the generated URL

## Architecture

```
src/
├── commands/              # Slash command implementations
│   ├── createctf.js       # Create CTF channels and events
│   ├── registerctf.js     # User registration for CTFs
│   ├── setctfplatform.js  # Pick the CTF platform for a channel
│   ├── syncchallenges.js  # Sync challenges and solves from the platform
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
│   ├── platform/          # Platform registry and normalized client interface
│   │   ├── index.js       # createPlatformClient and platform lookup
│   │   ├── ctfd.adapter.js  # Wraps the existing CTFd client
│   │   └── syntheticUser.js  # Pending-solve user id prefixes per platform
│   ├── noctf/
│   │   └── index.js       # noCTF client (separate API origin, Bearer auth)
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

**Core tables (existing)**
- `ctfs` stores CTF competition details
- `ctfs.platform`, `ctfs.api_base_url`, `ctfs.platform_division_id` record which platform a CTF channel syncs from, and how to reach it
- `ctf_registrations` stores user registrations
- `ctf_challenges` stores CTF challenges
- `ctf_challenge_solves` tracks challenge solves
- `pacts` stores pact agreements
- `admins` stores admin user IDs

**Blockchain-backed tables (new)**
- `tasks` stores tasks with a reference to the blockchain block height
- `task_reminders` stores scheduled reminders for task deadlines
- `reputations` stores the reputation ledger (one entry per giver per day)
- `documents` stores anchored documents with a blockchain reference
- `activity_ledger` stores an append-only ledger of AP value movements (grants and spends)
- `activity_balances` stores the current AP balance per user
- `store_items` stores the merchandise catalog (Sticker, Keychain, Shirt, Jacket)
- `purchases` stores purchase records (AP completed, Rp pending and then confirmed)

---

## Blockchain Block Data Schema

Every block stored on the Luce blockchain has a `data` field containing a JSON
string. Below are the supported schemas with their `type` discriminator.

### Task (`type: "task"`)

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

### Task Completion (`type: "task_done"`)

Created when a user runs `/task done`.

```json
{
  "type": "task_done",
  "v": 1,
  "taskId": "a1b2c3d4-...",
  "title": "Implement login page",
  "assignedTo": "123456789012345678",
  "completedBy": "123456789012345678"
}
```

| Field         | Type     | Description                   |
|---------------|----------|-------------------------------|
| `type`        | `string` | Always `"task_done"`          |
| `v`           | `number` | Schema version (currently `1`)|
| `taskId`      | `string` | UUID of the completed task    |
| `completedBy` | `string` | Discord user ID of completer  |
| `title` | `string` | Task title, for recognizable audit events |
| `assignedTo` | `string` | Discord user ID of assignee |

### Task Cancellation (`type: "task_cancel"`)

Created when a user runs `/task cancel confirm:True`.

```json
{
  "type": "task_cancel",
  "v": 1,
  "taskId": "a1b2c3d4-...",
  "title": "Implement login page",
  "assignedTo": "123456789012345678",
  "cancelledBy": "987654321098765432"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | `string` | Always `"task_cancel"` |
| `v` | `number` | Schema version (currently `1`) |
| `taskId` | `string` | UUID of the cancelled task |
| `title` | `string` | Task title |
| `assignedTo` | `string` | Discord user ID of assignee |
| `cancelledBy` | `string` | Discord user ID of canceller |

### Reputation (`type: "rep"`)

Created via a 👍 or 👎 reaction, a reply of +1, -1, 👍 or 👎, or the `/rep`
command.

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
| `reason`  | `string` | Trigger source, one of `"reaction"`, `"reply"`, or `""` for the slash command |
| `date`    | `string` | UTC date in `YYYY-MM-DD` format (enforces daily limit) |

**Daily limit.** A user may only give rep once per UTC calendar day, regardless
of target or sign. This is enforced at both the application and database level.

### Document (`type: "document"`)

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
| `content` | `string` | Document content. Plain text, with base64 for binary in future versions |
| `author`  | `string` | Discord user ID of author                 |
| `mimeType`| `string` | MIME type (default `"text/plain"`)        |

### Activity Points Grant (`type: "ap_grant"`)

Created by `/giveap` (single user) and `/giveapbulk` or `/giveap <role>` (batch).

Single grant (`v: 1`).

```json
{
  "type": "ap_grant",
  "v": 1,
  "grantedTo": "123456789012345678",
  "grantedBy": "987654321098765432",
  "amount": 50
}
```

Batch grant (`v: 2`) uses one block for the whole batch. It is used by
`/giveapbulk` and `/giveap <role>`.

```json
{
  "type": "ap_grant",
  "v": 2,
  "grantedBy": "987654321098765432",
  "entries": [
    { "discord_id": "123456789012345678", "points": 50 },
    { "discord_id": "876543210987654321", "points": 50 }
  ],
  "count": 2,
  "total": 100
}
```

| Field      | Type     | Description                              |
|-----------|----------|------------------------------------------|
| `type`    | `string` | Always `"ap_grant"`                      |
| `v`       | `number` | `1` (single) or `2` (batch)              |
| `grantedTo`| `string` | Discord user ID of recipient (v1 only)   |
| `grantedBy`| `string` | Discord user ID of the granting admin    |
| `amount`  | `number` | Points granted (v1 only)                 |
| `entries` | `array`  | `{discord_id, points}` list (v2 only)    |
| `count`   | `number` | Number of recipients (v2 only)          |
| `total`   | `number` | Total points granted (v2 only)           |

### Store Purchase (`type: "ap_purchase"`)

Created when a user buys an item from the store. AP purchases complete
immediately. Rp purchases start `pending` and are confirmed later.

```json
{
  "type": "ap_purchase",
  "v": 1,
  "user": "123456789012345678",
  "itemName": "Shirt",
  "paymentMethod": "ap",
  "costAp": 200,
  "status": "completed"
}
```

| Field          | Type     | Description                              |
|---------------|----------|------------------------------------------|
| `type`        | `string` | Always `"ap_purchase"`                  |
| `v`           | `number` | Schema version (currently `1`)           |
| `user`        | `string` | Discord user ID of buyer                 |
| `itemName`    | `string` | Name of the purchased item               |
| `paymentMethod`| `string` | `"ap"` or `"rp"`                       |
| `costAp`      | `number` | AP cost (when `paymentMethod` is `"ap"`) |
| `costRp`      | `number` | Rp cost (when `paymentMethod` is `"rp"`) |
| `status`      | `string` | `"completed"` (AP) or `"pending"` (Rp)  |

### Purchase Confirmation (`type: "ap_confirm"`)

Created when an admin confirms a pending Rp purchase via `/store-confirm`.

```json
{
  "type": "ap_confirm",
  "v": 1,
  "user": "123456789012345678",
  "confirmedBy": "987654321098765432",
  "itemName": "Shirt",
  "paymentMethod": "rp"
}
```

| Field          | Type     | Description                              |
|---------------|----------|------------------------------------------|
| `type`        | `string` | Always `"ap_confirm"`                    |
| `v`           | `number` | Schema version (currently `1`)           |
| `user`        | `string` | Discord user ID of buyer                 |
| `confirmedBy` | `string` | Discord user ID of confirming admin      |
| `itemName`    | `string` | Name of the purchased item               |
| `paymentMethod`| `string` | `"rp"` (or `"ap"` for completeness)    |

### Schema Versioning

The `v` field allows future schema evolution without breaking existing blocks.
When introducing a breaking change, increment `v` and handle both versions in
your parser.

---

## Reminder System

A background service (`src/services/reminder.js`) polls every 30 seconds for
unsent task reminders. Reminders are sent to `1524933314119467200` one hour
before the deadline and at 09:00 Asia/Jakarta on the day before the deadline
when those times are still in the future. Failed sends remain retryable.

Daily digests run after 04:00 Asia/Jakarta. Weekly digests run Monday after
05:00 Asia/Jakarta. Monday sends avoid redundant notifications. Digest ranges
and task reports use Asia/Jakarta calendar boundaries, and empty results are
explicitly reported.

**Flow**
1. `/task add` → creates blockchain block + DB row + reminder schedule
2. Reminder service polls `task_reminders` table every 30s
3. Due reminders are sent to channel `1524933314119467200`
4. Reminder is marked `sent = 1` to prevent duplicates

---

## Task Suggestions from Conversation

The bot can watch governance channels (the `GOVERNANCE_CATEGORIES` where
`/task` is allowed) and, when admins decide to do something in the future,
reply with a suggestion card offering to create a task with reminders. It can
also offer to cancel a task the conversation just dropped or rescheduled.

- Messages are buffered per channel. After 60 seconds of quiet (and at most
  once every 2 minutes per channel) the new messages are sent to an
  [OI]-compatible model, along with the channel's last 20 messages read
  from Discord history, which keeps context across a bot restart, the
  suggestion cards that are still open, and the pending tasks of the people
  in the conversation.
- The model works through tools, not a one-shot JSON reply. It can call
  `list_pending_tasks`, `create_task_card`, `cancel_task_card`,
  `update_task_card`, `remember_person` and (on unprompted passes)
  `stay_silent`. Tools only validate and queue. The service posts the chat
  first and the cards after, so a failed pass never leaves a half-written
  conversation. Parallel tool calls in one model turn all land.
- One message can produce several cards. "Ganti LPJ ke hari ini dan esok"
  becomes two create cards with different deadlines, and a reschedule can
  produce a cancellation card plus a replacement card in the same pass.
- A message that corrects an open suggestion ("not Sunday, make it Friday")
  updates that card in place instead of creating a new one, and the bot
  replies with what changed and a link to the card.
- Mentioning the bot (`@ctfbot remind us to ...`) skips the wait. It analyses
  right away, shows "typing..." until the model answers, and always replies,
  even when it finds nothing or the model call fails.
- Requests ask for `reasoning_effort: "low"`, which [OI] and DeepSeek both
  read. Decision spotting does not need deep reasoning.
- Only admin follow-up work becomes a card. That means an explicit "ingetin aku
  / buatin task" request, or admins agreeing that one of them will do something
  later. Assignments or homework given to members, announcements and "siap"
  replies do not. Unprompted cards need higher model confidence (0.85) than
  answers to a mention (0.7), and dismissed cards are shown to the model as
  things this channel does not want tracked.
- Each new task becomes a card with **Create task**, **Edit & create**
  (pre-filled form with title, assignee, deadline and description) and
  **Dismiss**. Nothing is created until someone clicks.
- A cancellation card has **Cancel task** and **Keep**. Cancelling runs the
  same path as `/task cancel`, with blockchain anchoring, reminder removal and
  Google Calendar sync. Nothing is cancelled until someone clicks, and **Keep**
  closes the card without touching the task.
- Accepted suggestions go through the same path as `/task add`, with blockchain
  anchoring, reminders and Google Calendar sync.
- Only governance-channel messages are ever sent to the model.
- Suggestions are stored in the `task_suggestions` table (migration 026, extended
  by 029 with `kind` and `target_task_id`). A card keeps working across
  restarts, with no time limit, until someone handles it. Clicking a card that
  was already handled says who handled it.
- **Dismiss** deletes the card to keep the channel clean. The dismissal is
  still recorded, and the model then knows the channel did not want it.
- The bot remembers people. When someone states a lasting fact or preference
  ("aku biasanya baru bisa malam", "Budi pegang sponsor", "pakai bahasa
  Inggris aja ke aku"), the model saves it as a note or a language
  preference (migration 027) and the bot reacts with a brain emoji on that
  message. Later passes see these notes. Assignees and deadlines then follow
  each person's preferences.
- The model writes in Indonesian by default (set in its system prompt) for
  card titles, descriptions, notes and its answer to a mention. A person
  with a saved language gets that language instead.
- Deleted messages are forgotten. A deleted chat message is never sent to the
  model again, a deleted open card is dropped, and notes learned from a deleted
  message are removed. Cards deleted while the bot was offline are dropped on
  the next pass. Cards that already became a task are kept.
- The model is told to chat like a classmate in the group chat, in everyday
  Indonesian slang, and to stay serious by default. Humor is off unless the
  moment is clearly safe and never aims at a person.
- The bot never insults, mocks or judges a member. The prompt forbids it and
  the service drops a reply that attacks someone instead of posting it.
- When a member says it got something wrong, the bot apologises for real: one
  or two short sentences naming the mistake and the correct answer, without
  defending itself. A plain "diem aja" is still obeyed with silence.
- No emojis in anything the bot writes. The prompt forbids them, and the
  output is stripped of Unicode and custom Discord emojis before it is posted,
  so chat messages, card titles, descriptions and memory notes stay plain
  text. Reaction controls (👍, 👎, 🔇, 🧠) are not affected.
- When mentioned, the bot shows "typing..." while the model thinks, then
  sends one to three short chat messages, one per line. The first is a quick
  acknowledgment that fits the message ("wait" for a request, "hmm" for a
  question) sent as a reply. The rest and any cards follow as plain channel
  messages, e.g. "wait", "oke ini ya", then the card.
- If a queued card fails to post, the bot names it instead of pretending it
  arrived. A duplicate is refused at tool time, with a link to the existing
  card, so the model can point at it rather than say the card is missing.
- `/memory view` shows what the bot remembers about you (Manage Messages can
  view others). `/memory remember`, `/memory forget <number>`,
  `/memory language` and `/memory clear` edit or delete it.
- `/memory global` is the server-wide layer, not tied to a person or a channel.
  `/memory global view` lists the notes, `add` teaches one, `remove` deletes
  your own note (an admin may remove any), and `clear` wipes them all and is
  admin only. Anyone may teach the bot, capped at 5 notes per member per day
  and 60 notes in total. A note is refused if it contains a link, a mention,
  a credential or a prompt injection. Global notes are advisory: they shape
  tone and house rules but can never override the safety or silence rules.

### Setup

```env
TASK_SUGGESTIONS_ENABLED=true
OPENAI_BASE_URL=https://api.openai.com/v1   # any [OI]-compatible endpoint
OPENAI_API_KEY=your_api_key
OPENAI_MODEL=gpt-4o-mini                    # model name as your provider spells it
OPENAI_TIMEOUT_MS=300000                    # optional, default 5 min for reasoning models
```

If the log shows `No reply from ... within Ns`, the endpoint answered too
slowly. Raise `OPENAI_TIMEOUT_MS`, pick a faster (non-reasoning) model, or
check that `OPENAI_BASE_URL` is reachable from the bot's host. Messages from a
failed pass are retried when the next message arrives in that channel.

The suggestion model must support tool calling, since the pass reads tasks and
queues cards through tools. A provider that rejects tool schemas fails the
pass, and the mention gets the model-error reply.

The **Message Content** privileged intent must be enabled for the bot in the
Discord Developer Portal.

## Proactive Chat

`src/services/chat.js` lets the bot join a conversation on its own, the way a
member of the server would. Examples include "gimana kalau...", "menurutku...",
a question worth thinking about, or a fact it just checked. There is no command
and no allowlist. It can speak in any channel it can post in.

The service enforces when not to speak in code.

- **Silence is a tool.** The model calls `stay_silent` to decline. An empty
  reply is treated as silence too. A broken response can never become a
  message.
- **The bot never triggers itself.** A pass only runs when a human spoke after
  the bot's last message. Its own messages are never buffered. It cannot
  talk itself into a monologue.
- **Speaking only when asked is a switch.** `CHAT_UNPROMPTED_ENABLED=false`
  makes the bot answer only a mention, a reply, or a direct question. On, it
  may still join a busy conversation, but rarely.
- **Joining a busy channel is the rarest path.** It needs six messages from
  three people in fifteen minutes, a 2% chance, and no ignored streak in that
  channel. A channel that already let the bot talk to itself does not get
  another unprompted try.
- **A correction is answered immediately.** A reply that says the bot got
  something wrong (`kamu salah`, `ngaco`, `jangan ngasal`) triggers a pass even
  during the cooldown or a backoff, because a wrong answer left standing is
  worse than one more message.
- **Cost is gated before the model is called.** A cheap check looks for a
  question, a link, an error, a verifiable claim, or a channel with at least
  six messages from three people in the last 15 minutes. With no signal, no
  model call happens at all.
- **Being ignored is a signal.** Two unanswered messages lengthen the
  cooldown to 20 minutes. Four silence the channel until the next day.
- **Budget per channel and per guild.** Defaults are 5 messages per hour and
  20 per day per channel, 200 per day for the whole guild.
- **Mute is per channel and lifts by itself.** React with 🔇 on one of the
  bot's messages, or reply to it with "diem aja", and that channel stays quiet
  until the next local midnight. Other channels are unaffected.

### How it writes

The bot answers the question that was asked, not the most interesting thing on
screen. A few rules in the prompt do the work.

- **The question, not a summary.** A mention names the message it came from and
  the message that one replies to, so "cek posternya" can be traced back to the
  question it corrects. Asked a duration, the number comes first.
- **The meaning, not the poster's wording.** "Mahasiswa aktif D3/D4 dan S1-S2
  dari kampus manapun" becomes "semua kampus". Reading a form field back is not
  an answer.
- **No invented rules.** A consequence the poster never states ("bisa batal
  isi") is treated the same as a made-up number.
- **Not the organizer.** It does not tell people to pick an option or sort
  something out. When two sources disagree it points at the disagreement and
  stops.
- **It can take a correction.** Its own recent messages are in the prompt with
  their ids, so a member saying "cek posternya" can be met with "oh iya deng"
  followed by the fact, instead of a fresh lecture.
- **It apologises when scolded.** A correction from a member gets one or two
  short sentences that name the mistake and the right answer. The one-sentence
  filter allows a second sentence only in that case, so the apology is not cut
  to "maaf".
- **It is never rude.** No insults, no sarcasm aimed at a person, no judgment
  about someone's ability. The prompt forbids it, and a generated reply that
  attacks a member is dropped instead of posted.
- **Serious by default.** Humor is off unless the moment is clearly safe and
  the joke is not about anyone.
- **A plain "diem aja" is still silence.** Being told to be quiet mutes the
  channel without a reply.
- **One sentence, enforced in code.** A second sentence is dropped, and so is
  everything after a non-list comma. "sentence 1, sentence 2" is not how anyone
  chats, and neither is a reply that answers the question and then adds a
  thought nobody asked for ("oh iya deng. di poster nggak ada daftar prodi").
  Only the first surviving sentence is posted, so the model has to lead with the
  part that matters. A list ("elektro, komputer, elektronika"), a decimal
  ("1,5 menit") and a URL are left alone. A reply that is nothing but filler
  after filtering is not posted at all.
- **No absence claims.** It does not report what a picture does not contain.
  Nobody asked.

### Tools

The model can call four tools, plus one more only on a pass that answers
someone. None of them can send a message, create a thread or touch a task. The
service alone decides to post.

| Tool | What it does |
| --- | --- |
| `search_web` | Google via [SerpBase](https://serpbase.dev/docs). Five organic results and three "people also ask" questions, compacted to a few hundred characters. |
| `remember` | Save a note about the channel (topic, jargon, house rules) or about a person (a lasting preference or role). |
| `remember_global` | Save a server-wide note that tunes personality or a house rule. Only offered when answering a person, never on an unprompted pass, and capped per member per day. |
| `recall` | Read back what is already remembered globally, about the channel, and about the people in it. |
| `stay_silent` | Decline to speak, with a reason. |

Search results are wrapped in a `<search_results>` block and labelled as
untrusted data, because a snippet is text someone else wrote. The prompt tells
the model never to follow instructions found there, and to only cite URLs the
tool actually returned. Identical queries are cached for a day and charged
against a daily credit cap. A model that likes a phrase cannot drain the
account.

### Global memory

Three layers of memory exist. `actor_memories` is per person, `channel_memory`
is per channel, and `global_memory` (migration 030) applies to the whole
server. The global layer is what lets a member tune the bot's personality
without repeating themselves in every channel.

- Anyone may teach it with `/memory global add`, or by telling the bot directly
  when it answers them. The model gets `remember_global` on that pass only.
- A note is capped at 300 characters and refused if it contains a link, a
  mention, a credential or a prompt injection.
- Writes are capped at 5 per member per day and 60 notes in total.
  `/memory global remove` deletes your own note; an admin may remove any and
  may `clear` everything.
- The prompt marks the notes as advice from members, not system instructions.
  They shape tone and house rules, but can never override the safety rules,
  the no-rudeness rule, or the decision to stay silent.
- A scold from a member also reaches the prompt as a correction. The bot
  apologises whether or not the scolder is staff, and it may save the lesson
  globally when the scold is really about how it should behave.

### Pictures, GIFs and link previews

`src/lib/media` puts more than text in front of the model.

- **Images are read, not guessed.** An image attachment is downloaded from the
  Discord CDN, downscaled to `CHAT_VISION_MAX_WIDTH` and sent as an image part.
  A message that is only a picture is buffered and counts as a signal on its
  own, so a poster with no question still gets looked at.
- **A GIF is four frames.** It is sampled at the first frame, 25%, 50% and the
  last one. Each sample is labelled with its place in the animation, and the
  prompt says those frames are one animation over time, not four pictures.
- **A link preview is text.** Embeds are rendered as `[embed]` lines under the
  message with the title, description, fields and URLs, so a Google Docs card
  or a news preview is in context. The prompt marks them as third party data,
  not something a member wrote.
- **Embed and thumbnail pictures are never downloaded.** Their URLs point at
  arbitrary hosts, so fetching them is a tracking pixel and SSRF vector, and
  their text is already in the transcript.
- **Everything is bounded.** Attachment size, image width, image parts per pass
  and the download timeout. A download that fails costs the picture, not the
  reply. The same attachment is downloaded once and cached.
- **A text-only provider still works.** If the provider rejects image parts,
  the service detects it once and retries the pass without pictures.

```env
CHAT_VISION_ENABLED=true        # false keeps the model text only
CHAT_VISION_MAX_IMAGES=6        # image parts per pass, a GIF spends up to 4
CHAT_VISION_MAX_WIDTH=1024
CHAT_VISION_MAX_BYTES=8388608   # skip larger attachments
```

### Setup

```env
CHAT_ENABLED=true
SERPBASE_API_KEY=your_serpbase_key   # optional, without it the bot talks without search

CHAT_QUIET_MS=20000                  # wait this long after the last message
CHAT_COOLDOWN_MS=360000              # never speak twice faster than this per channel
CHAT_MAX_PER_HOUR=5
CHAT_MAX_PER_DAY=20
CHAT_GUILD_MAX_PER_DAY=200
CHAT_UNPROMPTED_ENABLED=true         # false = only mentions, replies, and questions
CHAT_SPARK_PROBABILITY=0.02          # chance of joining a busy channel unprompted
CHAT_DENY_CHANNEL_IDS=               # announcements, logs, ...
CHAT_GLOBAL_MEMORY_MAX=60            # server-wide personality notes kept
CHAT_GLOBAL_MEMORY_PER_DAY=5         # notes one member may add per day
SERPBASE_DAILY_CREDITS=100
```

Keep `SERPBASE_API_KEY` in `.env` only. It is sent as the `X-API-Key` header,
never in a URL, and never logged. Rotate it if it ever appears in a transcript
or a commit.

The service degrades instead of failing. If the provider rejects tool schemas,
it falls back to a JSON reply (`{"say": ""}` means silence) once, and keeps
working.

## Google Calendar Sync (Option A)

A background service (`src/services/calendarSync.js`) pushes bot tasks to a
shared Google Calendar and reconciles bot-owned calendar events back into the
task DB. This lets the team see task deadlines on their calendar and edit them
there, with changes reflected back in Discord.

**Push direction (bot → Calendar)**
- `/task add` creates a new Calendar event (1 hour before the deadline).
- `/task done` deletes the event from the calendar.
- `/task cancel` patches the event status to `cancelled`.

**Pull direction (Calendar → bot)**
- Incremental sync using Google's `syncToken` to reduce API quota.
- Only processes events with the private `x-ctfbot-task` extended property
  marker. Foreign events are never imported as tasks.
- Detects title changes, deadline changes, and event cancellation or deletion.
- A reconciliation cycle runs every 60 seconds when enabled.

### Setup

1. **Google Cloud Project**. Create one at https://console.cloud.google.com/,
   and enable the **Google Calendar API**.

2. **OAuth 2.0 credentials**. Create an OAuth 2.0 Client ID (Desktop app
   type). Copy the client ID and client secret.

3. **Shared Calendar ID**. Create or choose a Google Calendar that the bot
   will own. Copy its ID (find it in Calendar settings → Integrate calendar →
   Calendar ID).

4. **Refresh token**. Put the client ID and secret in `.env`, then run the
   helper.

   ```bash
   pnpm google:auth
   ```

   Open the printed URL, approve access, and copy the printed
   `GOOGLE_REFRESH_TOKEN` into `.env`. The script listens on a local
   `127.0.0.1` port to receive the code. Google no longer supports the old
   copy-paste (`urn:ietf:wg:oauth:2.0:oob`) flow. Run it on the machine whose
   browser you approve in (with WSL, `127.0.0.1` from the Windows browser
   reaches WSL by default).

   If the OAuth consent screen is still in **Testing** status, add your Google
   account as a test user. Google expires refresh tokens for Testing apps after
   7 days. Publish the app to **In production** for a token that doesn't expire.

5. **Configure `.env`**.

   ```env
   GOOGLE_CALENDAR_ENABLED=true
   GOOGLE_CLIENT_ID=your_client_id
   GOOGLE_CLIENT_SECRET=your_client_secret
   GOOGLE_REFRESH_TOKEN=your_refresh_token
   GOOGLE_CALENDAR_ID=your_calendar_id
   ```

### Architecture

- `src/lib/google/oauth.js` handles OAuth 2.0 token refresh (fetch-based, no
  extra dependencies).
- `src/lib/google/calendar.js` holds the Google Calendar API v3 REST wrappers
  and mapper functions (`taskToCalendarEvent`, `calendarEventToTaskPatch`).
- `src/services/calendarSync.js` runs the poll loop (60s interval), push logic,
  and incremental pull reconciliation.
- `migrations/019_add_calendar_sync.sql` adds `calendar_event_id`,
  `calendar_synced_at`, `calendar_source` columns to `tasks`, plus
  `google_credentials` and `calendar_sync_state` tables.

---

## Development

### Project Structure

The bot is built on [@sapphire/framework](https://www.sapphirejs.dev/), which
provides the following.
- Structured command handling
- Event listener system
- Plugin support
- TypeScript-ready architecture

### Running Tests

```bash
pnpm test
```

The suite is fully offline. The platform adapters are exercised against the real
clients with only `globalThis.fetch` faked. No credentials and no network are
needed.

There is also an opt-in live probe that talks to a real noCTF deployment. It is
read-only (it never registers, solves or writes) and skipped by default.

```bash
K17_LIVE=1 \
K17_API_TOKEN=<session token> \
K17_DIVISION_ID=2 \
K17_API_USERNAME=<username> \
pnpm test:live
```

`K17_API_BASE_URL` defaults to `https://api-k17ctf.secso.cc`. The token is
optional. While the competition is active, anonymous reads are enough for every
assertion. Set `K17_API_TOKEN` when the deployment gates the routes (before the
start, or when hidden challenges matter), and `K17_API_USERNAME` to exercise the
user lookup.

### Code Style

This project uses tabs for indentation.

## Logging

The bot includes a unified logging system built on top of the Sapphire framework's logger.

### Log Levels

Set the `LOG_LEVEL` environment variable to control verbosity.

| Level   | Usage                                              |
|---------|----------------------------------------------------|
| `error` | Fatal errors and exceptions only                   |
| `warn`  | Warnings + errors                                  |
| `info`  | Normal operational messages (default)              |
| `debug` | Detailed debugging information                     |
| `trace` | Everything, including individual HTTP request logs |

```env
LOG_LEVEL=info
```

The task-suggestion bot (`[TaskSuggest]`, `[LLM]`) logs at these levels.
- `info` logs one summary per pass that did something or answered a mention (what the model returned, what was posted, updated, dropped and remembered), plus dropped proposals with the reason
- `debug` logs each step of a pass, including mention received or queued, prompt inputs, model request size, latency and token usage, the model's reply (first 2000 chars), every chat message, card, update and memory change
- `trace` logs every buffered message, scheduling, history reads, and the full prompt and model reply

### Where Logs Go

All logs are output to stdout (info/debug/trace) and stderr (error/warn).
There is no file-based logging. Use your process manager (e.g., systemd,
Docker, PM2) to capture and rotate stdout/stderr.

### Logger Architecture

The logger (`src/lib/logger.js`) works in two modes.

1. **Pre-init mode**. Before the bot has logged into Discord, the logger
   falls back to raw `console` calls with ISO timestamps.
2. **Post-init mode**. Once the SapphireClient is ready, the logger
   delegates to Sapphire's structured logger for consistent formatting
   across all commands and listeners.

### Context Prefixes

Child loggers with a context prefix are used throughout the codebase.

| Prefix          | Module                            |
|-----------------|-----------------------------------|
| `[ErrorHandler]`| `src/lib/errorHandler.js`         |
| `[CTFd]`        | `src/lib/ctfd/index.js`           |
| `[DB]`          | `src/database/index.js`           |
| `[Migration]`   | `src/database/migrations.js`      |
| `[Luce]`        | `src/lib/luce/index.js`           |

### Adding Logging to a New Module

```js
const { logger } = require('./lib/logger');
const myLog = logger.child('MyModule');

myLog.info('Operation completed successfully');
myLog.error('Something went wrong', error);
myLog.debug('Detailed info: %s', detail);
```

Logger methods follow the same signature as `console.log`, for example
`logger.info(message, ...optionalArgs)`.

## Contributing

Contributions are welcome. Read these guides.
- **[Contributing Guide](CONTRIBUTING.md)** covers detailed contribution guidelines
- **[Project Structure](PROJECT_STRUCTURE.md)** explains the codebase
- **[Quick Reference](QUICK_REFERENCE.md)** lists common tasks
- **[Architecture](ARCHITECTURE.md)** covers system design and patterns
- **[Changelog](CHANGELOG.md)** records version history

### Quick Start for Contributors

1. Fork the repository
2. Clone your fork with `git clone https://github.com/YOUR_USERNAME/ctfbot.git`
3. Install dependencies with `pnpm install`
4. Create a branch with `git checkout -b feature/your-feature`
5. Make your changes
6. Run linting with `pnpm run lint:fix`
7. Commit with `git commit -m "feat: add your feature"`
8. Push with `git push origin feature/your-feature`
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

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.

## Support

- **Issues** at [GitHub Issues](https://github.com/ucsits/ctfbot/issues)
- **Discord** for support and discussions on our server

## Acknowledgments

- Built with [discord.js](https://discord.js.org/)
- Powered by [@sapphire/framework](https://www.sapphirejs.dev/)
- Database: [better-sqlite3](https://github.com/WiseLibs/better-sqlite3)
- Blockchain: [Luce](https://github.com/ucsits/Luce)

---

Made by UCS ITS
