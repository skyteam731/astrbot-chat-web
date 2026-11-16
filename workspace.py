"""Account-owned workspace resources. Project descriptions are organizational only."""
import uuid
from flask import abort, g, jsonify, request
from werkzeug.exceptions import HTTPException


def register_workspace(app, db, login_required, now):
    @app.errorhandler(HTTPException)
    def api_http_error(error):
        if request.path.startswith('/api/'):
            return jsonify(error=error.description), error.code
        return error

    def owned_project(project_id):
        if not isinstance(project_id, str) or not db().execute(
            "SELECT id FROM projects WHERE id=? AND user_id=?", (project_id, g.user['id'])
        ).fetchone():
            abort(404)

    def body():
        value = request.get_json(silent=True)
        if not isinstance(value, dict):
            abort(400, description='请求内容必须是 JSON 对象。')
        return value

    def text(data, key, limit, required=False):
        value = data.get(key, '')
        if not isinstance(value, str) or len(value) > limit or (required and not value.strip()):
            abort(400, description=f'{key} 格式或长度不正确。')
        return value.strip() if key == 'name' else value

    def owned(table, ident):
        row = db().execute(f'SELECT * FROM {table} WHERE id=? AND user_id=?', (ident, g.user['id'])).fetchone()
        if row is None:
            abort(404)
        return row

    def search(sql, params, columns):
        query = request.args.get('q', '').strip()
        if query:
            pattern = '%' + query.replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_') + '%'
            sql += ' AND (' + ' OR '.join(f"{column} LIKE ? ESCAPE '\\'" for column in columns) + ')'
            params.extend([pattern] * len(columns))
        return sql, params

    @app.get('/api/projects')
    @login_required
    def projects_list():
        archived = request.args.get('archived', '0')
        if archived not in ('0', '1'):
            abort(400)
        sql, params = search('SELECT * FROM projects WHERE user_id=? AND archived=?', [g.user['id'], int(archived)], ['name', 'description'])
        return jsonify([dict(row) for row in db().execute(sql + ' ORDER BY updated_at DESC,id', params)])

    @app.post('/api/projects')
    @login_required
    def projects_create():
        data = body()
        name = text(data, 'name', 80, True)
        description = text(data, 'description', 2000)
        ident, stamp = str(uuid.uuid4()), now()
        db().execute('INSERT INTO projects(id,user_id,name,description,created_at,updated_at) VALUES(?,?,?,?,?,?)', (ident, g.user['id'], name, description, stamp, stamp))
        db().commit()
        return jsonify(dict(owned('projects', ident))), 201

    @app.route('/api/projects/<ident>', methods=['GET', 'PATCH', 'DELETE'])
    @login_required
    def projects_item(ident):
        row = owned('projects', ident)
        if request.method == 'DELETE':
            # Explicitly unlink to preserve conversations, including databases migrated from older versions.
            db().execute('UPDATE chats SET project_id=NULL WHERE project_id=? AND user_id=?', (ident, g.user['id']))
            db().execute('DELETE FROM projects WHERE id=? AND user_id=?', (ident, g.user['id']))
            db().commit()
            return '', 204
        if request.method == 'PATCH':
            data = body()
            values = dict(row)
            for key, limit in [('name', 80), ('description', 2000)]:
                if key in data:
                    values[key] = text(data, key, limit, key == 'name')
            if 'archived' in data:
                if type(data['archived']) is not bool:
                    abort(400)
                values['archived'] = int(data['archived'])
            db().execute('UPDATE projects SET name=?,description=?,archived=?,updated_at=? WHERE id=? AND user_id=?', (values['name'], values['description'], values['archived'], now(), ident, g.user['id']))
            db().commit()
            row = owned('projects', ident)
        return jsonify(dict(row))

    @app.get('/api/chats/<chat_id>')
    @login_required
    def chat_metadata(chat_id):
        row = db().execute('SELECT c.id,c.title,c.selected_provider,c.selected_model,c.pinned,c.archived,c.project_id,c.updated_at,p.name AS project_name FROM chats c LEFT JOIN projects p ON p.id=c.project_id AND p.user_id=c.user_id WHERE c.id=? AND c.user_id=?', (chat_id, g.user['id'])).fetchone()
        if row is None:
            abort(404)
        return jsonify(dict(row))

    @app.get('/api/template-examples')
    @login_required
    def template_examples():
        return jsonify([
            {'id':'polish','name':'文章润色','content':'请润色下面的文字，保留原意，让表达清晰自然，并说明主要修改：\n\n'},
            {'id':'summary','name':'内容总结','content':'请总结以下内容，提炼要点并列出待办事项：\n\n'},
            {'id':'explain','name':'解释题目','content':'请解释下面的题目，说明已知条件、解题步骤与容易出错的地方：\n\n'},
            {'id':'review','name':'代码检查','content':'请检查下面的代码，优先指出实际错误、边界条件和可验证的修复建议：\n\n'},
        ])

    @app.get('/api/templates')
    @login_required
    def templates_list():
        sql, params = search('SELECT * FROM prompt_templates WHERE user_id=?', [g.user['id']], ['name', 'content'])
        return jsonify([dict(row) for row in db().execute(sql + ' ORDER BY updated_at DESC,id', params)])

    @app.post('/api/templates')
    @login_required
    def templates_create():
        data = body()
        name, content = text(data, 'name', 80, True), text(data, 'content', 20000, True)
        ident, stamp = str(uuid.uuid4()), now()
        db().execute('INSERT INTO prompt_templates(id,user_id,name,content,created_at,updated_at) VALUES(?,?,?,?,?,?)', (ident, g.user['id'], name, content, stamp, stamp))
        db().commit()
        return jsonify(dict(owned('prompt_templates', ident))), 201

    @app.route('/api/templates/<ident>', methods=['GET', 'PATCH', 'DELETE'])
    @login_required
    def templates_item(ident):
        row = owned('prompt_templates', ident)
        if request.method == 'DELETE':
            db().execute('DELETE FROM prompt_templates WHERE id=? AND user_id=?', (ident, g.user['id']))
            db().commit()
            return '', 204
        if request.method == 'PATCH':
            data = body()
            name = text(data, 'name', 80, True) if 'name' in data else row['name']
            content = text(data, 'content', 20000, True) if 'content' in data else row['content']
            db().execute('UPDATE prompt_templates SET name=?,content=?,updated_at=? WHERE id=? AND user_id=?', (name, content, now(), ident, g.user['id']))
            db().commit()
            row = owned('prompt_templates', ident)
        return jsonify(dict(row))

    def bookmark(ident):
        row = db().execute('SELECT b.*, CASE WHEN c.id IS NOT NULL THEN c.title ELSE b.source_title END AS current_title,c.id IS NOT NULL AS source_available FROM bookmarks b LEFT JOIN chats c ON c.id=b.source_chat_id AND c.user_id=b.user_id WHERE b.id=? AND b.user_id=?', (ident, g.user['id'])).fetchone()
        if row is None:
            abort(404)
        result = dict(row)
        result['source_title'] = result.pop('current_title')
        result['source_available'] = bool(result['source_available'])
        return result

    @app.get('/api/bookmarks')
    @login_required
    def bookmarks_list():
        sql, params = search('SELECT id FROM bookmarks WHERE user_id=?', [g.user['id']], ['content', 'note', 'source_title'])
        return jsonify([bookmark(row['id']) for row in db().execute(sql + ' ORDER BY created_at DESC,id', params).fetchall()])

    @app.post('/api/bookmarks')
    @login_required
    def bookmarks_create():
        data = body()
        message_id = data.get('message_id')
        if type(message_id) is not int or message_id < 1:
            abort(400)
        row = db().execute("SELECT m.content,m.chat_id,c.title FROM messages m JOIN chats c ON c.id=m.chat_id WHERE m.id=? AND m.role='assistant' AND c.user_id=?", (message_id, g.user['id'])).fetchone()
        if row is None:
            abort(404)
        ident, stamp = str(uuid.uuid4()), now()
        # Unique(user_id,message_id) makes retries and double clicks idempotent.
        db().execute('INSERT OR IGNORE INTO bookmarks(id,user_id,message_id,source_chat_id,source_title,content,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)', (ident, g.user['id'], message_id, row['chat_id'], row['title'], row['content'], stamp, stamp))
        db().commit()
        saved = db().execute('SELECT id FROM bookmarks WHERE user_id=? AND message_id=?', (g.user['id'], message_id)).fetchone()
        return jsonify(bookmark(saved['id']))

    @app.route('/api/bookmarks/<ident>', methods=['GET', 'PATCH', 'DELETE'])
    @login_required
    def bookmarks_item(ident):
        owned('bookmarks', ident)
        if request.method == 'DELETE':
            db().execute('DELETE FROM bookmarks WHERE id=? AND user_id=?', (ident, g.user['id']))
            db().commit()
            return '', 204
        if request.method == 'PATCH':
            data = body()
            note = text(data, 'note', 10000) if 'note' in data else owned('bookmarks', ident)['note']
            db().execute('UPDATE bookmarks SET note=?,updated_at=? WHERE id=? AND user_id=?', (note, now(), ident, g.user['id']))
            db().commit()
        return jsonify(bookmark(ident))

    return owned_project
