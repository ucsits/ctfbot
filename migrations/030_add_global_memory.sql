-- Migration 030. Server-wide memory for personality and house rules
--
-- actor_memories (027) is per person and channel_memory (028) is per channel.
-- Neither can hold something that applies to every channel and every member,
-- such as "kalau ditegur, minta maaf dulu" or "jangan pernah bahas politik".
--
-- global_memory is that layer. A note is advisory context for the model, not a
-- system instruction, so the prompt still wraps it with the rule that it may
-- never override the safety rules or the silence rules.
--
-- kind separates what the note is for:
--   personality  tone and manner, e.g. "jangan sotoy, kalau ragu bilang nggak tau"
--   rule         a house rule for the whole server
--   correction   a specific thing the bot got wrong and should not repeat
--   fact         a lasting fact about the server, e.g. its name or its people
--
-- added_by is the member who taught it, so a note can be traced and removed.

CREATE TABLE IF NOT EXISTS global_memory (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    note              TEXT NOT NULL,
    kind              TEXT NOT NULL DEFAULT 'personality',
    added_by          TEXT,
    source_message_id TEXT,
    created_at        INTEGER NOT NULL,
    UNIQUE (note)
);

CREATE INDEX IF NOT EXISTS idx_global_memory_created ON global_memory (created_at);
