# Changelog

## v1.4.0

- Redesign the chat window, login and account settings in light gray and white with a shared paper-plane identity.
- Place the composer next to the greeting in new conversations and dock it below the message list during a chat.
- Add quick template previews and a searchable picker grouped by shared, personal and example templates.
- Improve mobile drawer focus, short-viewport layouts and touch targets.

## v1.3.1

- Disable project space and remove all project controls while preserving existing data and conversations.
- Add administrator-managed public prompt templates alongside private templates.
- Add a template picker below each saved assistant response for follow-up messages.


## v1.3.0

- Rebuild all UI surfaces using the local apple-design and emil-design-eng skills: vertical navigation, unified typography, SVG icons, accessible dialogs and touch layouts.
- Explain the installed AstrBot session-deletion ownership limitation and retain local records on refusal.
- Add private project spaces with search, archive, conversation assignment and deletion that preserves conversations.
- Add editable prompt templates and copyable examples, with preview and explicit draft append/replace actions.
- Add persistent assistant-answer bookmarks, searchable snapshots, notes and source navigation. Snapshots remain readable after source deletion.
- Return stable message IDs and persisted assistant IDs in the stream completion event.
- Preserve user ownership and CSRF checks on every workspace resource, with idempotent database migrations.
- Consolidate glass appearance and drawer rules while retaining the mobile fixed-position fix.


## v1.2.2

- Set the login card, history sidebar and chat window to liquid glass surfaces with approximately 75% opacity.


## v1.2.1

- Add a macOS Tahoe inspired liquid glass visual refresh with layered translucent surfaces and tinted accents.


## v1.2.0

- Refresh typography, navigation and tablet/mobile drawers.
- Add message/code copying, account-scoped drafts, history search, renaming, pinning and archiving.
- Add upstream stop, non-disruptive scrolling, failed-input recovery and Chinese IME handling.
- Add paste/drop uploads, progress, cancellation/retry and attachment downloads.
- Synchronize deletion with AstrBot and enforce ownership on new routes.


## v1.1.0

- Prevent duplicate assistant replies by treating AstrBot's final `complete` event as the saved response instead of appending it to the streamed text again.
- Render assistant Markdown and common LaTeX delimiters, with HTML disabled and sanitized output.
- Surface AstrBot error events as request failures rather than saving them as assistant replies.
- Bundle pinned Markdown, DOMPurify, and KaTeX browser assets locally.

### Notes

The `gpt-5.6-luna` model returned a successful response during a live check for issue #1. The app now reports upstream SSE errors clearly; a recurring provider-side HTTP 400 still needs to be corrected in that AstrBot provider's model configuration.
