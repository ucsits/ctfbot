-- Migration 028. Proactive chat, channel memory and search cache
--
-- channel_chat_state holds the per-channel gate for proactive messages.
-- mute (until the next local midnight), adaptive backoff after being ignored,
-- the last time the bot spoke and whether anyone engaged with it. It also
-- hourly/daily send budget.
--
-- guild_chat_state caps the whole guild per day so a server with many busy
-- channels cannot run up an unbounded model bill.
--
-- channel_memory is what the bot knows about a channel. That covers its topic,
-- its recurring jargon, the house rules and the things it already said. It
-- therefore stops repeating itself. actor_memories (migration 027) keeps
-- covering individual people.
--
-- search_cache and search_spend make web search cheap. Identical queries are
-- served from cache for a day. A daily credit cap stops a loop from
-- draining the SerpBase account.

CREATE TABLE IF NOT EXISTS channel_chat_state (
    channel_id            TEXT PRIMARY KEY,
    guild_id              TEXT,
    muted_until           INTEGER,
    backoff_until         INTEGER,
    last_spoke_at         INTEGER,
    last_spoke_message_id TEXT,
    last_human_at         INTEGER,
    -- When the bot spoke and nobody has replied or reacted yet. NULL means
    -- the last message was engaged with (or there is nothing to judge).
    awaiting_since        INTEGER,
    ignored_streak        INTEGER NOT NULL DEFAULT 0,
    hour_bucket           INTEGER,
    hour_count            INTEGER NOT NULL DEFAULT 0,
    day_bucket            TEXT,
    day_count             INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS guild_chat_state (
    guild_id   TEXT PRIMARY KEY,
    day_bucket TEXT,
    day_count  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS channel_memory (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id        TEXT NOT NULL,
    note              TEXT NOT NULL,
    kind              TEXT NOT NULL DEFAULT 'topic',
    source_message_id TEXT,
    created_at        INTEGER NOT NULL,
    UNIQUE (channel_id, note)
);

CREATE INDEX IF NOT EXISTS idx_channel_memory_channel ON channel_memory (channel_id, created_at);

CREATE TABLE IF NOT EXISTS search_cache (
    query_key  TEXT PRIMARY KEY,
    payload    TEXT NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_search_cache_created ON search_cache (created_at);

CREATE TABLE IF NOT EXISTS search_spend (
    day_bucket TEXT PRIMARY KEY,
    credits    INTEGER NOT NULL DEFAULT 0
);
