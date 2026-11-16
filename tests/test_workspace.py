"""Isolated API contract checks for v1.3 workspace features.

Run with: /tmp/studio-qa-env/bin/python -m unittest tests.test_workspace -v
"""
import importlib.util
import json
import os
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

APP_PATH = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "app.py"))
APP_DIR = os.path.dirname(APP_PATH)
if APP_DIR not in sys.path:
    sys.path.insert(0, APP_DIR)
ROOT_TMP = tempfile.TemporaryDirectory(prefix="studio-workspace-tests-")
os.environ.setdefault("APP_DB", os.path.join(ROOT_TMP.name, "initial.sqlite3"))
os.environ.setdefault("APP_SECRET", "workspace-tests-only")
os.environ.setdefault("ASTRBOT_URL", "http://astrbot.invalid")
os.environ.setdefault("ASTRBOT_API_KEY", "test-key")
spec = importlib.util.spec_from_file_location("studio_workspace_app", APP_PATH)
appmod = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = appmod
spec.loader.exec_module(appmod)


def rows_or_wrapped(payload, key):
    if isinstance(payload, dict):
        return payload.get(key, payload.get("items", []))
    return payload


def resource_id(payload, key):
    if isinstance(payload, dict):
        nested = payload.get(key)
        if isinstance(nested, dict) and nested.get("id"):
            return nested["id"]
        return payload.get("id")
    return None


class WorkspaceApiTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="studio-workspace-case-")
        appmod.DB_PATH = os.path.join(self.tmp.name, "db.sqlite3")
        appmod.init_db()
        # Migration execution must be safe and idempotent on an initialized DB.
        appmod.init_db()
        with sqlite3.connect(appmod.DB_PATH) as conn:
            conn.executemany(
                "INSERT INTO users(id,username,password_hash,is_active,session_version,created_at) VALUES(?,?,?,?,?,?)",
                [(1, "alice", "unused", 1, 1, "2026-01-01"), (2, "bob", "unused", 1, 1, "2026-01-01")],
            )
        self.alice, self.alice_csrf = self.client(1)
        self.bob, self.bob_csrf = self.client(2)

    def tearDown(self):
        self.tmp.cleanup()

    def client(self, user_id):
        client = appmod.app.test_client()
        csrf = f"csrf-{user_id}"
        with client.session_transaction() as session:
            session["uid"] = user_id
            session["session_version"] = 1
            session["_csrf"] = csrf
        return client, {"X-CSRF-Token": csrf}

    def call_json(self, client, method, path, payload=None, headers=None):
        return getattr(client, method)(path, json=payload, headers=headers or {})

    def create_project(self, client=None, headers=None, name="Project", description="Workspace"):
        client, headers = client or (self.alice, self.alice_csrf)
        response = self.call_json(client, "post", "/api/projects", {"name": name, "description": description}, headers)
        self.assertIn(response.status_code, (200, 201), response.get_data(as_text=True))
        project_id = resource_id(response.json, "project")
        self.assertTrue(project_id, response.json)
        return project_id

    def create_template(self, client=None, headers=None, name="Explain", content="Explain step by step"):
        client, headers = client or (self.alice, self.alice_csrf)
        response = self.call_json(client, "post", "/api/templates", {"name": name, "content": content}, headers)
        self.assertIn(response.status_code, (200, 201), response.get_data(as_text=True))
        template_id = resource_id(response.json, "template")
        self.assertTrue(template_id, response.json)
        return template_id

    def seed_chat(self, chat_id="chat-a", owner_id=1, title="Legacy chat", project_id=None):
        with sqlite3.connect(appmod.DB_PATH) as conn:
            columns = {row[1] for row in conn.execute("PRAGMA table_info(chats)")}
            if "project_id" in columns:
                conn.execute(
                    "INSERT INTO chats(id,user_id,title,selected_provider,selected_model,created_at,updated_at,project_id) VALUES(?,?,?,?,?,?,?,?)",
                    (chat_id, owner_id, title, "", "", "2026-01-01", "2026-01-02", project_id),
                )
            else:
                conn.execute(
                    "INSERT INTO chats(id,user_id,title,selected_provider,selected_model,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
                    (chat_id, owner_id, title, "", "", "2026-01-01", "2026-01-02"),
                )
        return chat_id

    def test_project_crud_scope_and_delete_unassigns_but_preserves_chat_and_draft(self):
        project_id = self.create_project()
        # Project may own an existing chat; chat/project deletion must not delete history or draft.
        chat_id = self.seed_chat(project_id=project_id)
        patch_chat = self.call_json(self.alice, "patch", f"/api/chats/{chat_id}", {"project_id": project_id, "draft": "keep me"}, self.alice_csrf)
        self.assertEqual(patch_chat.status_code, 200, patch_chat.get_data(as_text=True))
        self.assertEqual(self.alice.get(f"/api/chats?project={project_id}").status_code, 200)
        self.assertEqual(self.bob.get(f"/api/projects/{project_id}").status_code, 404)
        self.assertEqual(self.call_json(self.bob, "patch", f"/api/projects/{project_id}", {"name": "stolen"}, self.bob_csrf).status_code, 404)
        self.assertEqual(self.bob.delete(f"/api/projects/{project_id}", headers=self.bob_csrf).status_code, 404)

        removed = self.alice.delete(f"/api/projects/{project_id}", headers=self.alice_csrf)
        self.assertIn(removed.status_code, (200, 204))
        detail = self.alice.get(f"/api/chats/{chat_id}")
        self.assertEqual(detail.status_code, 200, detail.get_data(as_text=True))
        self.assertIsNone(detail.json.get("project_id"))
        self.assertEqual(self.alice.get(f"/api/chats/{chat_id}/draft").json.get("draft"), "keep me")
        chats = rows_or_wrapped(self.alice.get("/api/chats?project=all").json, "chats")
        self.assertTrue(any(item.get("id") == chat_id for item in chats))

    def test_legacy_schema_migrates_twice_and_keeps_existing_records_usable(self):
        legacy_tmp = tempfile.TemporaryDirectory(prefix="studio-legacy-db-")
        legacy_db = os.path.join(legacy_tmp.name, "legacy.sqlite3")
        appmod.DB_PATH = legacy_db
        with sqlite3.connect(legacy_db) as conn:
            conn.executescript("""
                PRAGMA foreign_keys=ON;
                CREATE TABLE users (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
                    password_hash TEXT NOT NULL,
                    is_admin INTEGER NOT NULL DEFAULT 0,
                    is_active INTEGER NOT NULL DEFAULT 1,
                    created_at TEXT NOT NULL
                );
                CREATE TABLE chats (
                    id TEXT PRIMARY KEY,
                    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    title TEXT NOT NULL DEFAULT '新对话',
                    selected_provider TEXT NOT NULL DEFAULT '',
                    selected_model TEXT NOT NULL DEFAULT '',
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE messages (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
                    role TEXT NOT NULL CHECK(role IN ('user','assistant')),
                    content TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );
                CREATE TABLE attachments (
                    attachment_id TEXT PRIMARY KEY,
                    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    filename TEXT NOT NULL,
                    mimetype TEXT NOT NULL,
                    size INTEGER NOT NULL,
                    created_at TEXT NOT NULL
                );
                INSERT INTO users(id,username,password_hash,created_at) VALUES(1,'legacy-user','unused','2025-01-01');
                INSERT INTO chats(id,user_id,title,created_at,updated_at) VALUES('legacy-chat',1,'Legacy history','2025-01-01','2025-01-02');
                INSERT INTO messages(id,chat_id,role,content,created_at) VALUES(41,'legacy-chat','assistant','Legacy answer','2025-01-02');
                INSERT INTO attachments(attachment_id,user_id,filename,mimetype,size,created_at) VALUES('legacy-file',1,'old.txt','text/plain',4,'2025-01-01');
            """)

        appmod.init_db()
        appmod.init_db()
        columns = {row[1] for row in sqlite3.connect(legacy_db).execute("PRAGMA table_info(chats)")}
        self.assertIn("project_id", columns)
        client, csrf = self.client(1)
        detail = client.get("/api/chats/legacy-chat")
        self.assertEqual(detail.status_code, 200, detail.get_data(as_text=True))
        self.assertIsNone(detail.json.get("project_id"))
        history = client.get("/api/chats/legacy-chat/messages")
        self.assertEqual(history.status_code, 200)
        self.assertEqual(history.json[0].get("id"), 41)
        self.assertEqual(history.json[0].get("content"), "Legacy answer")

        created = self.call_json(client, "post", "/api/projects", {"name": "Migrated project"}, csrf)
        self.assertEqual(created.status_code, 201, created.get_data(as_text=True))
        project_id = created.json["id"]
        associated = self.call_json(client, "patch", "/api/chats/legacy-chat", {"project_id": project_id}, csrf)
        self.assertEqual(associated.status_code, 200, associated.get_data(as_text=True))
        self.assertEqual(client.get("/api/chats/legacy-chat").json.get("project_id"), project_id)

        bookmarked = self.call_json(client, "post", "/api/bookmarks", {"message_id": 41}, csrf)
        self.assertEqual(bookmarked.status_code, 200, bookmarked.get_data(as_text=True))
        messages_after_bookmark = client.get("/api/chats/legacy-chat/messages").json
        self.assertEqual(messages_after_bookmark[0].get("id"), 41)
        self.assertEqual(messages_after_bookmark[0].get("bookmark_id"), bookmarked.json.get("id"))
        with sqlite3.connect(legacy_db) as conn:
            self.assertEqual(conn.execute("SELECT filename FROM attachments WHERE attachment_id='legacy-file'").fetchone()[0], "old.txt")
        legacy_tmp.cleanup()

    def test_csrf_mutations_without_token_are_rejected(self):
        response = self.alice.post("/api/projects", json={"name": "No CSRF"})
        self.assertEqual(response.status_code, 400)
        listing = self.alice.get("/api/projects")
        self.assertEqual(listing.status_code, 200)
        self.assertEqual(rows_or_wrapped(listing.json, "projects"), [])

    def test_chat_project_filters_and_foreign_chat_detail_and_project_assignment(self):
        project_id = self.create_project()
        self.seed_chat("alice-chat", 1)
        self.seed_chat("bob-chat", 2)
        assigned = self.call_json(self.alice, "patch", "/api/chats/alice-chat", {"project_id": project_id}, self.alice_csrf)
        self.assertEqual(assigned.status_code, 200, assigned.get_data(as_text=True))
        detail = self.alice.get("/api/chats/alice-chat")
        self.assertEqual(detail.status_code, 200)
        self.assertEqual(detail.json.get("project_id"), project_id)
        self.assertEqual(self.alice.get("/api/chats?project=none").status_code, 200)
        self.assertEqual(self.alice.get("/api/chats?project=all").status_code, 200)
        self.assertEqual(self.alice.get(f"/api/chats?project={project_id}").status_code, 200)
        self.assertEqual(self.bob.get("/api/chats/alice-chat").status_code, 404)
        # A foreign project filter is rejected instead of revealing its contents.
        self.assertEqual(self.bob.get(f"/api/chats?project={project_id}").status_code, 404)
        self.assertEqual(self.call_json(self.bob, "patch", "/api/chats/bob-chat", {"project_id": project_id}, self.bob_csrf).status_code, 404)

    def test_templates_private_crud_validation_and_examples(self):
        template_id = self.create_template()
        listing = self.alice.get("/api/templates")
        self.assertEqual(listing.status_code, 200)
        self.assertTrue(any(item.get("id") == template_id for item in rows_or_wrapped(listing.json, "templates")))
        examples = self.alice.get("/api/template-examples")
        self.assertEqual(examples.status_code, 200)
        self.assertTrue(rows_or_wrapped(examples.json, "examples"))
        self.assertEqual(self.bob.get(f"/api/templates/{template_id}").status_code, 404)
        self.assertEqual(self.call_json(self.bob, "patch", f"/api/templates/{template_id}", {"name": "stolen"}, self.bob_csrf).status_code, 404)
        self.assertEqual(self.bob.delete(f"/api/templates/{template_id}", headers=self.bob_csrf).status_code, 404)
        bob_templates = self.bob.get("/api/templates")
        self.assertFalse(any(item.get("id") == template_id for item in rows_or_wrapped(bob_templates.json, "templates")))
        self.assertIn(self.call_json(self.alice, "post", "/api/templates", {"name": "  ", "content": "text"}, self.alice_csrf).status_code, (400, 422))
        self.assertIn(self.call_json(self.alice, "post", "/api/templates", {"name": "Too long", "content": "x" * 20001}, self.alice_csrf).status_code, (400, 422))
        updated = self.call_json(self.alice, "patch", f"/api/templates/{template_id}", {"content": "Edited body"}, self.alice_csrf)
        self.assertEqual(updated.status_code, 200, updated.get_data(as_text=True))
        self.assertIn(self.alice.delete(f"/api/templates/{template_id}", headers=self.alice_csrf).status_code, (200, 204))

    def test_bookmark_idempotency_snapshot_note_and_foreign_message_scope(self):
        chat_id = self.seed_chat("source-chat", 1, "Source title")
        with sqlite3.connect(appmod.DB_PATH) as conn:
            cursor = conn.execute("INSERT INTO messages(chat_id,role,content,created_at) VALUES(?,?,?,?)", (chat_id, "assistant", "Saved answer", "2026-01-02"))
            assistant_message_id = cursor.lastrowid
            user_cursor = conn.execute("INSERT INTO messages(chat_id,role,content,created_at) VALUES(?,?,?,?)", (chat_id, "user", "Question", "2026-01-01"))
            user_message_id = user_cursor.lastrowid
            conn.execute("INSERT INTO chats(id,user_id,title,selected_provider,selected_model,created_at,updated_at) VALUES(?,?,?,?,?,?,?)", ("bob-source", 2, "Bob", "", "", "2026-01-01", "2026-01-02"))
            foreign_cursor = conn.execute("INSERT INTO messages(chat_id,role,content,created_at) VALUES(?,?,?,?)", ("bob-source", "assistant", "Bob secret", "2026-01-02"))
            foreign_message_id = foreign_cursor.lastrowid

        first = self.call_json(self.alice, "post", "/api/bookmarks", {"message_id": assistant_message_id}, self.alice_csrf)
        self.assertIn(first.status_code, (200, 201), first.get_data(as_text=True))
        bookmark_id = resource_id(first.json, "bookmark")
        self.assertTrue(bookmark_id, first.json)
        second = self.call_json(self.alice, "post", "/api/bookmarks", {"message_id": assistant_message_id}, self.alice_csrf)
        self.assertIn(second.status_code, (200, 201), second.get_data(as_text=True))
        self.assertEqual(resource_id(second.json, "bookmark"), bookmark_id)
        bookmarks = rows_or_wrapped(self.alice.get("/api/bookmarks").json, "bookmarks")
        self.assertEqual(sum(1 for item in bookmarks if item.get("id") == bookmark_id), 1)
        item = next(item for item in bookmarks if item.get("id") == bookmark_id)
        for field in ("content", "note", "source_chat_id", "source_title", "source_available"):
            self.assertIn(field, item)
        self.assertEqual(item["content"], "Saved answer")
        self.assertEqual(item["source_chat_id"], chat_id)
        self.assertTrue(item["source_available"])
        message_rows = self.alice.get(f"/api/chats/{chat_id}/messages").json
        source_message = next(row for row in message_rows if row.get("id") == assistant_message_id)
        self.assertEqual(source_message.get("bookmark_id"), bookmark_id)
        self.assertIn(self.call_json(self.alice, "post", "/api/bookmarks", {"message_id": user_message_id}, self.alice_csrf).status_code, (400, 404, 422))
        self.assertIn(self.call_json(self.bob, "post", "/api/bookmarks", {"message_id": assistant_message_id}, self.bob_csrf).status_code, (400, 404))
        bob_bookmarks = self.bob.get("/api/bookmarks")
        self.assertEqual(bob_bookmarks.status_code, 200)
        self.assertFalse(any(item.get("id") == bookmark_id for item in rows_or_wrapped(bob_bookmarks.json, "bookmarks")))
        self.assertEqual(self.bob.get(f"/api/bookmarks/{bookmark_id}").status_code, 404)
        self.assertEqual(self.bob.patch(f"/api/bookmarks/{bookmark_id}", json={"note": "steal"}, headers=self.bob_csrf).status_code, 404)
        self.assertEqual(self.bob.delete(f"/api/bookmarks/{bookmark_id}", headers=self.bob_csrf).status_code, 404)
        note = self.call_json(self.alice, "patch", f"/api/bookmarks/{bookmark_id}", {"note": "remember this"}, self.alice_csrf)
        self.assertEqual(note.status_code, 200, note.get_data(as_text=True))
        with patch.object(appmod.requests, "delete", return_value=Mock(status_code=404, content=b"")):
            deleted = self.alice.delete(f"/api/chats/{chat_id}", headers=self.alice_csrf)
        self.assertIn(deleted.status_code, (200, 204))
        surviving = self.alice.get("/api/bookmarks")
        saved = next(item for item in rows_or_wrapped(surviving.json, "bookmarks") if item.get("id") == bookmark_id)
        self.assertEqual(saved["content"], "Saved answer")
        self.assertEqual(saved["note"], "remember this")
        self.assertEqual(saved["source_chat_id"], chat_id)
        self.assertEqual(saved["source_title"], "Source title")
        self.assertFalse(saved["source_available"])

    def test_stable_message_ids_and_persisted_assistant_id_in_sse_done(self):
        chat_id = self.seed_chat("message-chat", 1)
        upstream = Mock(status_code=200)
        upstream.__enter__ = Mock(return_value=upstream)
        upstream.__exit__ = Mock(return_value=False)
        # requests.iter_lines(decode_unicode=True) yields decoded text strings.
        upstream.iter_lines.return_value = ['data: {"type":"complete","data":"Assistant answer"}']
        with patch.object(appmod.requests, "post", return_value=upstream):
            response = self.call_json(self.alice, "post", f"/api/chats/{chat_id}/send", {"message": "Question"}, self.alice_csrf)
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        events = []
        for frame in response.get_data(as_text=True).split("\n\n"):
            if frame.startswith("data:"):
                events.append(json.loads(frame[5:].strip()))
        done = next(event for event in events if event.get("done"))
        assistant_id = done.get("assistant_message_id")
        self.assertIsNotNone(assistant_id, done)
        messages = self.alice.get(f"/api/chats/{chat_id}/messages")
        self.assertEqual(messages.status_code, 200)
        assistant_rows = [item for item in rows_or_wrapped(messages.json, "messages") if item.get("role") == "assistant"]
        user_rows = [item for item in rows_or_wrapped(messages.json, "messages") if item.get("role") == "user"]
        self.assertEqual(len(assistant_rows), 1)
        self.assertEqual(assistant_rows[0].get("id"), assistant_id)
        self.assertTrue(user_rows[0].get("id"))
        self.assertTrue(all(item.get("id") for item in assistant_rows + user_rows))
        self.assertEqual(self.bob.get(f"/api/chats/{chat_id}/messages").status_code, 404)


if __name__ == "__main__":
    unittest.main(verbosity=2)
