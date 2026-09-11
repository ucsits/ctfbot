-- Migration 025: Record which CTF platform a channel is bound to
--
-- Until now the bot assumed CTFd everywhere: ctf_base_url was both the web URL
-- and the API URL, and the only credentials were a CTFd API token. Supporting a
-- second platform (noCTF) needs three pieces of per-CTF state:
--
--   platform            which adapter to use. Defaults to 'ctfd' so every
--                       existing row keeps its current behaviour.
--   api_base_url        the API origin when it differs from the web URL. noCTF
--                       serves its API from a separate host (for example
--                       https://api-k17ctf.secso.cc while the UI lives on
--                       https://scoreboard.k17ctf.secso.cc), and the two cannot
--                       be derived from one another. NULL means "same origin as
--                       ctf_base_url", which is correct for CTFd.
--   platform_division_id
--                       noCTF's scoreboard and solve endpoints are scoped to a
--                       division, and the deployment's /site/config does not
--                       always advertise a default. NULL means "resolve it".
--
-- The migration runner recovers gracefully when a column is already present on a
-- fresh database (the inline schema in src/database/index.js declares them too),
-- so this is safe to re-run.

ALTER TABLE ctfs ADD COLUMN platform TEXT DEFAULT 'ctfd';
ALTER TABLE ctfs ADD COLUMN api_base_url TEXT;
ALTER TABLE ctfs ADD COLUMN platform_division_id INTEGER;
