import json
import os
import re
import secrets
import sqlite3
import threading
import uuid
from datetime import datetime, timezone

import requests
from flask import Flask, Response, abort, flash, g, get_flashed_messages, jsonify, redirect, render_template, request, session, url_for
from werkzeug.security import check_password_hash, generate_password_hash

APP_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.environ.get("APP_DB", os.path.join(APP_DIR, "data.sqlite3"))
ASTRBOT_URL = os.environ.get("ASTRBOT_URL", "http://127.0.0.1:6185").rstrip("/")
ASTRBOT_API_KEY = os.environ.get("ASTRBOT_API_KEY", "")
APP_SECRET = os.environ.get("APP_SECRET", "")
BOOTSTRAP_PASSWORD = os.environ.get("BOOTSTRAP_PASSWORD", "")
app = Flask(__name__)
app.config["PROJECTS_ENABLED"] = False
app.secret_key = APP_SECRET or secrets.token_hex(32)
app.config["MAX_CONTENT_LENGTH"] = 25 * 1024 * 1024
app.config.update(SESSION_COOKIE_HTTPONLY=True, SESSION_COOKIE_SAMESITE="Lax", SESSION_COOKIE_SECURE=True, PERMANENT_SESSION_LIFETIME=60 * 60 * 24 * 7)
db_lock = threading.Lock()


def db():
    if "db" not in g:
        conn = sqlite3.connect(DB_PATH, timeout=30)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        g.db = conn
    return g.db


@app.teardown_appcontext
def close_db(_exc):
    conn = g.pop("db", None)
    if conn is not None:
        conn.close()


def init_db():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.executescript("""
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL UNIQUE COLLATE NOCASE,
            real_name TEXT NOT NULL DEFAULT '',
            password_hash TEXT NOT NULL,
            is_admin INTEGER NOT NULL DEFAULT 0,
            is_active INTEGER NOT NULL DEFAULT 1,
            session_version INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS chats (
            id TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            title TEXT NOT NULL DEFAULT '新对话',
            selected_provider TEXT NOT NULL DEFAULT '',
            selected_model TEXT NOT NULL DEFAULT '',
            pinned INTEGER NOT NULL DEFAULT 0,
            archived INTEGER NOT NULL DEFAULT 0,
            draft TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
            role TEXT NOT NULL CHECK(role IN ('user','assistant')),
            content TEXT NOT NULL,
            attachments_json TEXT NOT NULL DEFAULT '[]',
            created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS projects (
            id TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            archived INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS prompt_templates (
            id TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            content TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS public_prompt_templates (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            content TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS bookmarks (
            id TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            message_id INTEGER NOT NULL,
            source_chat_id TEXT NOT NULL,
            source_title TEXT NOT NULL,
            content TEXT NOT NULL,
            note TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE(user_id,message_id)
        );
        CREATE TABLE IF NOT EXISTS attachments (
            attachment_id TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            filename TEXT NOT NULL,
            mimetype TEXT NOT NULL,
            size INTEGER NOT NULL,
            created_at TEXT NOT NULL
        );
    """)
    conn.execute("BEGIN IMMEDIATE")
    migrations = {
        "users": {"real_name": "TEXT NOT NULL DEFAULT ''", "session_version": "INTEGER NOT NULL DEFAULT 1"},
        "chats": {"selected_provider": "TEXT NOT NULL DEFAULT ''", "selected_model": "TEXT NOT NULL DEFAULT ''", "pinned": "INTEGER NOT NULL DEFAULT 0", "archived": "INTEGER NOT NULL DEFAULT 0", "draft": "TEXT NOT NULL DEFAULT ''", "project_id": "TEXT REFERENCES projects(id) ON DELETE SET NULL"},
        "messages": {"attachments_json": "TEXT NOT NULL DEFAULT '[]'"},
    }
    for table, columns in migrations.items():
        existing = {row[1] for row in conn.execute(f"PRAGMA table_info({table})")}
        for column, definition in columns.items():
            if column not in existing:
                conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_chats_user_project ON chats(user_id,project_id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_projects_user ON projects(user_id,archived)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_templates_user ON prompt_templates(user_id)")
    count = conn.execute("SELECT COUNT(*) FROM users").fetchone()[0]
    if count == 0 and BOOTSTRAP_PASSWORD:
        conn.execute("INSERT OR IGNORE INTO users(username,password_hash,is_admin,created_at) VALUES(?,?,1,?)", ("admin", generate_password_hash(BOOTSTRAP_PASSWORD, method="scrypt"), datetime.now(timezone.utc).isoformat()))
    conn.commit()
    conn.close()


def now():
    return datetime.now(timezone.utc).isoformat()


def current_user():
    uid = session.get("uid")
    if not uid:
        return None
    row = db().execute("SELECT id,username,real_name,is_admin,is_active,session_version FROM users WHERE id=?", (uid,)).fetchone()
    if not row:
        session.clear()
        return None
    version = session.get("session_version")
    if version is None:
        session["session_version"] = row["session_version"]
    elif version != row["session_version"]:
        session.clear()
        return None
    return row


@app.before_request
def load_user():
    g.user = current_user()
    if "_csrf" not in session:
        session["_csrf"] = secrets.token_urlsafe(32)
    if request.method in {"POST", "PUT", "PATCH", "DELETE"}:
        supplied = request.headers.get("X-CSRF-Token") or request.form.get("_csrf", "")
        if not secrets.compare_digest(str(session.get("_csrf", "")), str(supplied)):
            if request.path.startswith("/api/"):
                return jsonify(error="请求校验失败，请刷新页面后重试。"), 400
            abort(400)


@app.context_processor
def inject_csrf_token():
    return {"csrf_token": lambda: session.get("_csrf", "")}


def login_required(fn):
    from functools import wraps
    @wraps(fn)
    def wrapped(*args, **kwargs):
        if not g.user or not g.user["is_active"]:
            session.clear()
            if request.path.startswith("/api/"):
                return jsonify(error="请先登录"), 401
            return redirect(url_for("login", next=request.path))
        return fn(*args, **kwargs)
    return wrapped


def admin_required(fn):
    from functools import wraps
    @wraps(fn)
    @login_required
    def wrapped(*args, **kwargs):
        if not g.user["is_admin"]:
            abort(403)
        return fn(*args, **kwargs)
    return wrapped


def valid_username(value):
    return bool(re.fullmatch(r"[A-Za-z0-9_.-]{3,32}", value or ""))


@app.get("/")
def index():
    if not g.user:
        return redirect(url_for("login"))
    return render_template("index.html", user=g.user)


@app.route("/profile", methods=["GET", "POST"])
@login_required
def profile():
    error = None
    if request.method == "POST":
        real_name = request.form.get("real_name", "").strip()
        if len(real_name) > 40:
            error = "姓名最多 40 个字符。"
        else:
            db().execute("UPDATE users SET real_name=? WHERE id=?", (real_name, g.user["id"]))
            db().commit()
            return redirect(url_for("index"))
    return render_template("profile.html", user=g.user, error=error, notices=get_flashed_messages(with_categories=True))


@app.post("/password")
@login_required
def change_own_password():
    current_password = request.form.get("current_password", "")
    new_password = request.form.get("new_password", "")
    confirm_password = request.form.get("confirm_password", "")
    row = db().execute("SELECT password_hash FROM users WHERE id=?", (g.user["id"],)).fetchone()
    if not row or not check_password_hash(row["password_hash"], current_password):
        flash("当前密码不正确。", "error")
        return redirect(url_for("profile"))
    if len(new_password) < 12:
        flash("新密码至少需要 12 位。", "error")
        return redirect(url_for("profile"))
    if new_password != confirm_password:
        flash("两次输入的新密码不一致。", "error")
        return redirect(url_for("profile"))
    db().execute("UPDATE users SET password_hash=?,session_version=session_version+1 WHERE id=?", (generate_password_hash(new_password, method="scrypt"), g.user["id"]))
    db().commit()
    session.clear()
    flash("密码已更新，请使用新密码重新登录。", "success")
    return redirect(url_for("login"))


@app.route("/login", methods=["GET", "POST"])
def login():
    if g.user:
        return redirect(url_for("index"))
    error = None
    if request.method == "POST":
        username = request.form.get("username", "").strip()
        password = request.form.get("password", "")
        row = db().execute("SELECT * FROM users WHERE username=? COLLATE NOCASE", (username,)).fetchone()
        if row and row["is_active"] and check_password_hash(row["password_hash"], password):
            session.clear()
            session["uid"] = row["id"]
            session["session_version"] = row["session_version"]
            session.permanent = True
            return redirect(url_for("index"))
        error = "用户名或密码不正确，或账号已停用。"
    return render_template("login.html", error=error, notices=get_flashed_messages(with_categories=True))


@app.post("/logout")
def logout():
    session.clear()
    return redirect(url_for("login"))


@app.get("/api/chats")
@login_required
def list_chats():
    archived = request.args.get("archived", "0")
    if archived not in ("0", "1"):
        return jsonify(error="archived 参数必须为 0 或 1。"), 400
    query = request.args.get("q", "").strip()
    if not isinstance(query, str):
        return jsonify(error="q 参数必须为字符串。"), 400
    sql = "SELECT c.id,c.title,c.selected_provider,c.selected_model,c.pinned,c.archived,c.updated_at,c.project_id,p.name AS project_name FROM chats c LEFT JOIN projects p ON p.id=c.project_id AND p.user_id=c.user_id WHERE c.user_id=? AND c.archived=?"
    params = [g.user["id"], int(archived)]
    project = request.args.get("project", "all")
    if project == "none":
        sql += " AND c.project_id IS NULL"
    elif project != "all":
        owned_project(project)
        sql += " AND c.project_id=?"
        params.append(project)
    if query:
        sql += " AND (c.title LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM messages m WHERE m.chat_id=c.id AND m.content LIKE ? ESCAPE '\\'))"
        escaped_query = query.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        pattern = f"%{escaped_query}%"
        params.extend((pattern, pattern))
    sql += " ORDER BY c.pinned DESC,c.updated_at DESC"
    rows = db().execute(sql, params).fetchall()
    return jsonify([dict(r) for r in rows])


@app.post("/api/chats")
@login_required
def create_chat():
    chat_id = str(uuid.uuid4())
    stamp = now()
    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        return jsonify(error="请求内容必须是 JSON 对象。"), 400
    project_id = body.get("project_id")
    if project_id is not None:
        owned_project(project_id)
    provider = str(body.get("selected_provider", ""))[:200]
    model = str(body.get("selected_model", ""))[:200]
    if provider or model:
        try:
            valid = any(item.get("enable", True) and item.get("provider_type") == "chat_completion" and item.get("id") == provider and item.get("model") == model for item in provider_records())
        except requests.RequestException:
            return jsonify(error="暂时无法读取可用模型。"), 502
        if not valid:
            return jsonify(error="所选模型当前不可用。"), 400
    db().execute("INSERT INTO chats(id,user_id,title,selected_provider,selected_model,created_at,updated_at,project_id) VALUES(?,?,?,?,?,?,?,?)", (chat_id, g.user["id"], "新对话", provider, model, stamp, stamp, project_id))
    db().commit()
    return jsonify(id=chat_id, title="新对话", selected_provider=provider, selected_model=model, project_id=project_id)


def provider_records():
    response = requests.get(f"{ASTRBOT_URL}/api/v1/providers", params={"enabled": "true"}, headers={"Authorization": f"Bearer {ASTRBOT_API_KEY}"}, timeout=15)
    response.raise_for_status()
    return ((response.json().get("data") or {}).get("providers") or [])


@app.get("/api/models")
@login_required
def list_models():
    if not ASTRBOT_API_KEY:
        return jsonify(error="AstrBot API Key 尚未配置"), 503
    try:
        models = []
        seen = set()
        for item in provider_records():
            if not item.get("enable", True) or item.get("provider_type") != "chat_completion":
                continue
            provider_id, model = str(item.get("id", "")), str(item.get("model", ""))
            if not provider_id or not model or (provider_id, model) in seen:
                continue
            seen.add((provider_id, model))
            models.append({"provider_id": provider_id, "model": model, "label": f"{item.get('provider', '模型')} · {model}"})
        return jsonify(models=models)
    except (requests.RequestException, ValueError) as exc:
        app.logger.warning("Unable to load model list: %s", type(exc).__name__)
        return jsonify(error="暂时无法读取可用模型。"), 502


@app.patch("/api/chats/<chat_id>")
@login_required
def update_chat(chat_id):
    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        return jsonify(error="请求内容必须是 JSON 对象。"), 400
    owner = db().execute("SELECT selected_provider,selected_model FROM chats WHERE id=? AND user_id=?", (chat_id, g.user["id"])).fetchone()
    if not owner:
        abort(404)

    updates = {}
    if "project_id" in body:
        project_id = body["project_id"]
        if project_id is not None:
            owned_project(project_id)
        updates["project_id"] = project_id
    if "title" in body:
        title = body["title"]
        if not isinstance(title, str) or not 1 <= len(title.strip()) <= 120:
            return jsonify(error="title 必须为 1 到 120 个字符。"), 400
        updates["title"] = title.strip()
    for field in ("pinned", "archived"):
        if field in body:
            if type(body[field]) is not bool:
                return jsonify(error=f"{field} 必须为布尔值。"), 400
            updates[field] = int(body[field])
    if "draft" in body:
        draft = body["draft"]
        if not isinstance(draft, str) or len(draft) > 20000:
            return jsonify(error="draft 必须为不超过 20000 个字符的字符串。"), 400
        updates["draft"] = draft

    provider, model = owner["selected_provider"], owner["selected_model"]
    if "selected_provider" in body:
        if not isinstance(body["selected_provider"], str) or len(body["selected_provider"]) > 200:
            return jsonify(error="selected_provider 必须为不超过 200 个字符的字符串。"), 400
        provider = body["selected_provider"]
        updates["selected_provider"] = provider
    if "selected_model" in body:
        if not isinstance(body["selected_model"], str) or len(body["selected_model"]) > 200:
            return jsonify(error="selected_model 必须为不超过 200 个字符的字符串。"), 400
        model = body["selected_model"]
        updates["selected_model"] = model
    if ("selected_provider" in body or "selected_model" in body) and (provider or model):
        try:
            valid = any(item.get("enable", True) and item.get("provider_type") == "chat_completion" and item.get("id") == provider and item.get("model") == model for item in provider_records())
        except requests.RequestException:
            return jsonify(error="暂时无法读取可用模型。"), 502
        if not valid:
            return jsonify(error="所选模型当前不可用。"), 400
    if not updates:
        return jsonify(ok=True)
    # Draft autosaves must not change the ordering timestamp of chat history.
    ordering_updates = set(updates) - {"draft"}
    if ordering_updates:
        updates["updated_at"] = now()
    assignments = ",".join(f"{column}=?" for column in updates)
    cur = db().execute(f"UPDATE chats SET {assignments} WHERE id=? AND user_id=?", (*updates.values(), chat_id, g.user["id"]))
    db().commit()
    if not cur.rowcount:
        abort(404)
    return jsonify(ok=True)


@app.get("/api/chats/<chat_id>/draft")
@login_required
def get_chat_draft(chat_id):
    row = db().execute("SELECT draft FROM chats WHERE id=? AND user_id=?", (chat_id, g.user["id"])).fetchone()
    if not row:
        abort(404)
    return jsonify(draft=row["draft"] or "")


@app.get("/api/chats/<chat_id>/messages")
@login_required
def list_messages(chat_id):
    owner = db().execute("SELECT id FROM chats WHERE id=? AND user_id=?", (chat_id, g.user["id"])).fetchone()
    if not owner:
        abort(404)
    rows = db().execute("SELECT m.id,m.role,m.content,m.attachments_json,m.created_at,b.id AS bookmark_id FROM messages m LEFT JOIN bookmarks b ON b.message_id=m.id AND b.user_id=? WHERE m.chat_id=? ORDER BY m.id", (g.user["id"], chat_id)).fetchall()
    result = []
    for row in rows:
        item = dict(row)
        item["attachments"] = json.loads(item.pop("attachments_json") or "[]")
        result.append(item)
    return jsonify(result)


@app.post("/api/upload")
@login_required
def upload_file():
    uploaded = request.files.get("file")
    if not uploaded or not uploaded.filename:
        return jsonify(error="请选择一个文件。"), 400
    if not ASTRBOT_API_KEY:
        return jsonify(error="AstrBot API Key 尚未配置"), 503
    filename = os.path.basename(uploaded.filename.replace("\\", "/"))[:255] or "upload"
    content = uploaded.read(25 * 1024 * 1024 + 1)
    if len(content) > 25 * 1024 * 1024:
        return jsonify(error="单个文件不能超过 25 MB。"), 413
    mime = uploaded.mimetype or "application/octet-stream"
    try:
        response = requests.post(f"{ASTRBOT_URL}/api/v1/file", headers={"Authorization": f"Bearer {ASTRBOT_API_KEY}"}, files={"file": (filename, content, mime)}, timeout=60)
        envelope = response.json()
        if response.status_code >= 400 or envelope.get("status") == "error":
            return jsonify(error=envelope.get("message") or f"AstrBot 上传失败 ({response.status_code})"), response.status_code if response.status_code >= 400 else 502
        data = envelope.get("data") or {}
        attachment_id = data.get("attachment_id") or data.get("id")
        if not attachment_id:
            return jsonify(error="AstrBot 没有返回附件编号。"), 502
        db().execute("INSERT OR REPLACE INTO attachments(attachment_id,user_id,filename,mimetype,size,created_at) VALUES(?,?,?,?,?,?)", (attachment_id, g.user["id"], filename, mime, len(content), now()))
        db().commit()
        if mime.startswith("image/"):
            kind = "image"
        elif mime.startswith("audio/"):
            kind = "record"
        elif mime.startswith("video/"):
            kind = "video"
        else:
            kind = "file"
        return jsonify(id=attachment_id, filename=filename, mimetype=mime, size=len(content), kind=kind)
    except (requests.RequestException, ValueError) as exc:
        app.logger.warning("File upload failed: %s", type(exc).__name__)
        return jsonify(error="文件上传失败，请稍后再试。"), 502


@app.get("/api/attachments/<attachment_id>")
@login_required
def preview_attachment(attachment_id):
    row = db().execute("SELECT mimetype FROM attachments WHERE attachment_id=? AND user_id=?", (attachment_id, g.user["id"])).fetchone()
    if not row:
        abort(404)
    try:
        response = requests.get(f"{ASTRBOT_URL}/api/v1/file", params={"attachment_id": attachment_id}, headers={"Authorization": f"Bearer {ASTRBOT_API_KEY}"}, timeout=30)
        if response.status_code >= 400:
            abort(response.status_code)
        return Response(response.content, mimetype=row["mimetype"], headers={"Cache-Control": "private, max-age=3600", "X-Content-Type-Options": "nosniff", "Content-Disposition": "inline" if row["mimetype"] in ("image/png", "image/jpeg", "image/gif", "image/webp") and not request.args.get("download") else "attachment"})
    except requests.RequestException:
        abort(502)


@app.post("/api/chats/<chat_id>/send")
@login_required
def send_message(chat_id):
    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        return jsonify(error="Invalid message payload"), 400
    message = str(body.get("message", "")).strip()
    requested_attachments = body.get("attachments", [])
    if (not message and not requested_attachments) or len(message) > 20000:
        return jsonify(error="请输入不超过 20000 字符的消息。"), 400
    if not isinstance(requested_attachments, list) or len(requested_attachments) > 8:
        return jsonify(error="一次最多添加 8 个文件。"), 400
    chat = db().execute("SELECT id,title,selected_provider,selected_model FROM chats WHERE id=? AND user_id=?", (chat_id, g.user["id"])).fetchone()
    if not chat:
        abort(404)
    attachments = []
    for item in requested_attachments:
        if not isinstance(item, dict):
            return jsonify(error="Invalid attachment payload"), 400
        attachment_id = str((item or {}).get("id", ""))
        row = db().execute("SELECT attachment_id,filename,mimetype FROM attachments WHERE attachment_id=? AND user_id=?", (attachment_id, g.user["id"])).fetchone()
        if not row:
            return jsonify(error="附件不存在或不属于当前账号。"), 400
        mime = row["mimetype"]
        kind = "image" if mime.startswith("image/") else "record" if mime.startswith("audio/") else "video" if mime.startswith("video/") else "file"
        attachments.append({"id": row["attachment_id"], "filename": row["filename"], "mimetype": mime, "kind": kind})
    user_message_id = db().execute("INSERT INTO messages(chat_id,role,content,attachments_json,created_at) VALUES(?,?,?,?,?)", (chat_id, "user", message, json.dumps(attachments, ensure_ascii=False), now())).lastrowid
    title = chat["title"]
    if title == "新对话" and message:
        title = message[:36].replace("\n", " ")
    elif title == "新对话" and attachments:
        title = attachments[0]["filename"][:36]
    db().execute("UPDATE chats SET title=?,updated_at=? WHERE id=?", (title, now(), chat_id))
    db().commit()
    # The AstrBot identity is derived only from the authenticated account ID.
    astrbot_username = f"mtu_{g.user['id']}"
    segments = ([{"type": "plain", "text": message}] if message else []) + [{"type": item["kind"], "attachment_id": item["id"]} for item in attachments]
    payload = {"message": segments, "username": astrbot_username, "session_id": chat_id, "enable_streaming": True, "selected_provider": chat["selected_provider"], "selected_model": chat["selected_model"]}
    headers = {"Authorization": f"Bearer {ASTRBOT_API_KEY}", "Content-Type": "application/json", "Accept": "text/event-stream"}

    def generate():
        collected = []
        try:
            if not ASTRBOT_API_KEY:
                raise RuntimeError("AstrBot API Key 尚未配置")
            with requests.post(f"{ASTRBOT_URL}/api/v1/chat", headers=headers, json=payload, stream=True, timeout=(10, 300)) as upstream:
                if upstream.status_code >= 400:
                    detail = upstream.text[:1000]
                    yield "data: " + json.dumps({"error": f"AstrBot 返回 {upstream.status_code}: {detail}"}, ensure_ascii=False) + "\n\n"
                    return
                streamed_parts = []
                final_answer = None
                for line in upstream.iter_lines(decode_unicode=True):
                    if not line:
                        continue
                    if line.startswith("data:"):
                        raw = line[5:].strip()
                        if raw == "[DONE]":
                            continue
                        try:
                            event = json.loads(raw)
                        except (TypeError, json.JSONDecodeError):
                            continue
                        event_type = event.get("type") if isinstance(event, dict) else None
                        if event_type == "plain":
                            if event.get("chain_type") in ("reasoning", "tool_call", "tool_call_result"):
                                continue
                            text = str(event.get("data") or "")
                            if text:
                                streamed_parts.append(text)
                                yield "data: " + json.dumps({"text": text}, ensure_ascii=False) + "\n\n"
                        elif event_type == "complete":
                            final_answer = str(event.get("data") or "") or "".join(streamed_parts)
                            yield "data: " + json.dumps({"final": final_answer}, ensure_ascii=False) + "\n\n"
                        elif event_type == "error":
                            detail = str(event.get("data") or "AstrBot 处理失败")
                            yield "data: " + json.dumps({"error": detail}, ensure_ascii=False) + "\n\n"
                            return
                collected = [final_answer if final_answer is not None else "".join(streamed_parts)]
        except Exception as exc:
            yield "data: " + json.dumps({"error": str(exc)}, ensure_ascii=False) + "\n\n"
            collected = []
        answer = "".join(collected)
        assistant_message_id = None
        with db_lock:
            with sqlite3.connect(DB_PATH, timeout=30) as conn:
                if answer:
                    assistant_message_id = conn.execute("INSERT INTO messages(chat_id,role,content,created_at) VALUES(?,?,?,?)", (chat_id, "assistant", answer, now())).lastrowid
                conn.execute("UPDATE chats SET updated_at=? WHERE id=?", (now(), chat_id))
                conn.commit()
        yield "data: " + json.dumps({"done": True, "user_message_id": user_message_id, "assistant_message_id": assistant_message_id}, ensure_ascii=False) + "\n\n"

    return Response(generate(), mimetype="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.post("/api/chats/<chat_id>/stop")
@login_required
def stop_chat(chat_id):
    if not db().execute("SELECT id FROM chats WHERE id=? AND user_id=?", (chat_id, g.user["id"])).fetchone():
        abort(404)
    try:
        response = requests.post(f"{ASTRBOT_URL}/api/v1/chat/sessions/{chat_id}/stop", params={"username": f"mtu_{g.user['id']}"}, headers={"Authorization": f"Bearer {ASTRBOT_API_KEY}"}, timeout=15)
        response.raise_for_status()
        result = response.json()
        if isinstance(result, dict) and result.get("status") == "error":
            return jsonify(error="停止请求未成功，请稍后重试。"), 502
        return jsonify(ok=True)
    except (requests.RequestException, ValueError):
        return jsonify(error="暂时无法停止上游任务，请稍后重试。"), 502


@app.delete("/api/chats/<chat_id>")
@login_required
def delete_chat(chat_id):
    if not db().execute("SELECT id FROM chats WHERE id=? AND user_id=?", (chat_id, g.user["id"])).fetchone():
        abort(404)
    try:
        response = requests.delete(f"{ASTRBOT_URL}/api/v1/chat/sessions/{chat_id}", params={"username": f"mtu_{g.user['id']}"}, headers={"Authorization": f"Bearer {ASTRBOT_API_KEY}"}, timeout=15)
        if response.status_code != 404:
            response.raise_for_status()
            if response.content:
                result = response.json()
                if result.get("status") == "error":
                    if str(result.get("message", "")).lower() == "permission denied":
                        return jsonify(error="当前 AstrBot 版本不支持清理此账号的会话，记录已保留。请先使用归档。"), 409
                    return jsonify(error="上游记录删除失败，请重试。"), 502
    except (requests.RequestException, ValueError):
        return jsonify(error="暂时无法删除上游记录，请稍后重试。"), 502
    db().execute("DELETE FROM chats WHERE id=? AND user_id=?", (chat_id, g.user["id"]))
    db().commit()
    return "", 204


@app.get("/admin")
@admin_required
def admin():
    rows = db().execute("SELECT id,username,real_name,is_admin,is_active,created_at FROM users ORDER BY id").fetchall()
    return render_template("admin.html", users=rows, user=g.user, error=None, notices=get_flashed_messages(with_categories=True))


@app.get("/admin/templates")
@admin_required
def public_template_admin():
    return render_template("public_templates.html", user=g.user, notices=[])


@app.post("/admin/users")
@admin_required
def add_user():
    username = request.form.get("username", "").strip()
    password = request.form.get("password", "")
    real_name = request.form.get("real_name", "").strip()[:40]
    is_admin = 1 if request.form.get("is_admin") == "1" else 0
    if not valid_username(username) or len(password) < 12:
        error = "用户名需为 3–32 位字母、数字、点、下划线或连字符；密码至少 12 位。"
    else:
        try:
            db().execute("INSERT INTO users(username,real_name,password_hash,is_admin,created_at) VALUES(?,?,?,?,?)", (username, real_name, generate_password_hash(password, method="scrypt"), is_admin, now()))
            db().commit()
            flash(f"账号 {username} 已创建。", "success")
            return redirect(url_for("admin"))
        except sqlite3.IntegrityError:
            error = "这个用户名已存在。"
    rows = db().execute("SELECT id,username,real_name,is_admin,is_active,created_at FROM users ORDER BY id").fetchall()
    return render_template("admin.html", users=rows, user=g.user, error=error, notices=[]), 400


@app.post("/admin/users/<int:user_id>/update")
@admin_required
def update_user(user_id):
    row = db().execute("SELECT id,is_admin,is_active FROM users WHERE id=?", (user_id,)).fetchone()
    if not row:
        abort(404)
    username = request.form.get("username", "").strip()
    real_name = request.form.get("real_name", "").strip()
    is_admin = 1 if request.form.get("is_admin") == "1" else 0
    is_active = 1 if request.form.get("is_active") == "1" else 0
    if not valid_username(username) or len(real_name) > 40:
        flash("请检查登录名和真实姓名：登录名需为 3–32 位，姓名不超过 40 位。", "error")
        return redirect(url_for("admin"))
    if row["is_admin"] and row["is_active"] and (not is_admin or not is_active):
        admin_count = db().execute("SELECT COUNT(*) FROM users WHERE is_admin=1 AND is_active=1").fetchone()[0]
        if admin_count <= 1:
            flash("至少保留一名可登录的管理员。", "error")
            return redirect(url_for("admin"))
    try:
        db().execute("UPDATE users SET username=?,real_name=?,is_admin=?,is_active=? WHERE id=?", (username, real_name, is_admin, is_active, user_id))
        db().commit()
    except sqlite3.IntegrityError:
        flash("该登录名已被其他账号使用。", "error")
        return redirect(url_for("admin"))
    flash(f"账号 {username} 的资料已保存。", "success")
    return redirect(url_for("admin"))


@app.post("/admin/users/<int:user_id>/password")
@admin_required
def reset_user_password(user_id):
    row = db().execute("SELECT id,username FROM users WHERE id=?", (user_id,)).fetchone()
    if not row:
        abort(404)
    password = request.form.get("password", "")
    confirm_password = request.form.get("confirm_password", "")
    if len(password) < 12 or password != confirm_password:
        flash("密码至少 12 位，并且两次输入必须一致。", "error")
        return redirect(url_for("admin"))
    db().execute("UPDATE users SET password_hash=?,session_version=session_version+1 WHERE id=?", (generate_password_hash(password, method="scrypt"), user_id))
    db().commit()
    if user_id == g.user["id"]:
        session.clear()
        flash("管理员密码已重设，请重新登录。", "success")
        return redirect(url_for("login"))
    flash(f"账号 {row['username']} 的密码已重设，旧登录会话已失效。", "success")
    return redirect(url_for("admin"))


@app.post("/admin/users/<int:user_id>/toggle")
@admin_required
def toggle_user(user_id):
    if user_id == g.user["id"]:
        abort(400)
    db().execute("UPDATE users SET is_active=1-is_active WHERE id=? AND is_admin=0", (user_id,))
    db().commit()
    return redirect(url_for("admin"))


@app.post("/admin/password")
@admin_required
def change_password():
    password = request.form.get("password", "")
    if len(password) < 12:
        return "密码至少需要 12 位。", 400
    db().execute("UPDATE users SET password_hash=?,session_version=session_version+1 WHERE id=?", (generate_password_hash(password, method="scrypt"), g.user["id"]))
    db().commit()
    session.clear()
    return redirect(url_for("login"))


@app.get("/healthz")
def healthz():
    return jsonify(ok=True)


from workspace import register_workspace
owned_project = register_workspace(app, db, login_required, now)

init_db()

