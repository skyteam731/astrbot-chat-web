# Next upgrades

## Completed in v1.2.0
Responsive navigation and typography; message/code copying; upstream stop; text drafts; history search, rename, pin and archive; paste/drop upload with progress, cancel and retry; failure recovery.

## Completed in v1.3.0
Private project organization, prompt templates and examples, assistant-answer bookmarks with searchable snapshots, notes and source navigation.

## Pending user selection
- Message editing, regeneration versions and quoted follow-up questions.
- Model favorites, capabilities and per-response model metadata.
- Background generation recovery and concurrent conversations.
- Document preview, export and revocable sharing.
- Web search with citations, private document retrieval and long-form editor.
- Voice input/output and generated images/files.
- Account quotas, device management and administrator audit logs.

## Constraints
Preserve account isolation. Confirm features against the installed AstrBot schema. Current generation blocks chat switching. Draft persistence covers text; attachments must be re-added after switching conversations.

## Known upstream compatibility limit
AstrBot 4.29.1 session deletion authenticates the API-key system identity, while website chat sessions use per-user identities. Single and batch deletion refuse those sessions. The website preserves history and reports the refusal; use archive until AstrBot provides a compatible deletion API.
