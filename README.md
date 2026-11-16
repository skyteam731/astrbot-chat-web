# astrbot-chat-web

Website for chatting via AstrBot API with multiple users.

Assistant messages render Markdown and LaTeX using the pinned browser libraries under `static/vendor/`. Their license files are included beside each package.

See [CHANGELOG.md](CHANGELOG.md) for release notes.

## Workspace

Project space is currently disabled; existing data and conversations are preserved. Administrators maintain public prompt templates through `/admin/templates`; signed-in users can use them or save private copies. Personal templates remain private. Each saved assistant response offers a template picker for follow-up drafts. Bookmarks keep answer snapshots and notes even when a source conversation is deleted. All resources are scoped to the signed-in account.

The app remains Flask + SQLite with browser JavaScript. `workspace.py` registers the workspace APIs. Existing databases migrate automatically at startup; back up the database and code before upgrading.

## Checks

Install `requirements.txt`, then run `python -m unittest discover -s tests -v`. Checks use temporary databases and mocked upstream responses; they do not contact production.

For deployment, include `app.py`, `workspace.py`, `requirements.txt`, `templates/` and `static/`. Keep the existing environment file, database and virtual environment.
