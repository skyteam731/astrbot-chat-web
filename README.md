# astrbot-chat-web

Website for chatting via AstrBot API with multiple users.

Assistant messages render Markdown and LaTeX using the pinned browser libraries under `static/vendor/`. Their license files are included beside each package.

See [CHANGELOG.md](CHANGELOG.md) for release notes.

## Workspace

Projects organize each user's conversations. Project descriptions are labels for organization, not shared model context. Templates are editable user-message drafts. Bookmarks keep answer snapshots and notes even when a source conversation is deleted. All resources are scoped to the signed-in account.

The app remains Flask + SQLite with browser JavaScript. `workspace.py` registers the workspace APIs. Existing databases migrate automatically at startup; back up the database and code before upgrading.

## Checks

Install `requirements.txt`, then run `python -m unittest discover -s tests -v`. Checks use temporary databases and mocked upstream responses; they do not contact production.

For deployment, include `app.py`, `workspace.py`, `requirements.txt`, `templates/` and `static/`. Keep the existing environment file, database and virtual environment.
