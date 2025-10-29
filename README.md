# ctfbot
UCS's specialized Discord bot for CTF

This bot can:
- `/schedule <event_title:text> <event_description:text> <event_date:date> [event_banner:image_file]`: Schedule custom events (in user's own timezone stored as UTC)
- `/createctf <ctf_name:text> <ctf_date:date> <ctf_base_url:text> [event_description:text] [event_banner:image_file]`: Create specific CTF text channel and schedule its event in one go.
- For each competition:
  - `/registerctf <username:text>`: Register user participation for internal tracking by their `username` from the competition website
  - CTFd Integration:
    - Fetch user detail. This is atomic to `/registerctf` command such that users would be able to change their name afterwards because now tracking uses their CTFd userid.
	- Fetch team detail. Also atomic to `/registerctf` for the same reason.