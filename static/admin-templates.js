(() => {
  const list = document.querySelector('#publicTemplateList');
  const search = document.querySelector('#publicTemplateSearch');
  const pageNotice = document.querySelector('#publicTemplateNotice');
  const editor = document.querySelector('#publicTemplateEditor');
  const editorForm = document.querySelector('#publicTemplateForm');
  const deleteDialog = document.querySelector('#publicTemplateDeleteDialog');
  const csrf = document.querySelector('meta[name="csrf-token"]')?.content || '';
  const items = new Map();
  let editingId = null;
  let deletingId = null;
  let opener = null;
  let requestRevision = 0;
  let searchTimer = null;

  const byId = id => document.getElementById(id);
  function showNotice(message, kind = 'notice') {
    pageNotice.textContent = message;
    pageNotice.className = kind;
    pageNotice.hidden = !message;
  }
  function formError(message) {
    const error = byId('publicTemplateFormError');
    error.textContent = message;
    error.hidden = !message;
  }
  function deleteError(message) {
    const error = byId('publicTemplateDeleteError');
    error.textContent = message;
    error.hidden = !message;
  }
  async function request(path, options = {}) {
    let response;
    try {
      response = await fetch(path, {
        ...options,
        headers: {
          ...(options.body ? { 'Content-Type': 'application/json' } : {}),
          ...(options.method && options.method !== 'GET' ? { 'X-CSRF-Token': csrf } : {}),
          ...(options.headers || {})
        }
      });
    } catch {
      throw new Error('网络连接失败，请检查连接后重试。');
    }
    if (response.status === 401) {
      window.location.assign('/login');
      throw new Error('登录已过期，正在返回登录页。');
    }
    if (response.redirected && new URL(response.url, window.location.href).pathname === '/login') {
      window.location.assign('/login');
      throw new Error('登录已过期，正在返回登录页。');
    }
    if (!response.ok) {
      let payload = {};
      try { payload = await response.json(); } catch {}
      throw new Error(payload.error || `请求失败（${response.status}）`);
    }
    if (response.status === 204) return null;
    const type = response.headers.get('content-type') || '';
    if (!type.includes('application/json')) return null;
    return response.json();
  }
  function formatDate(value) {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'short', day: 'numeric' }).format(date);
  }
  function render(rows) {
    items.clear();
    for (const item of rows) items.set(String(item.id), item);
    list.replaceChildren();
    if (!rows.length) {
      const empty = document.createElement('div');
      empty.className = 'public-template-empty';
      const title = document.createElement('b');
      title.textContent = search.value.trim() ? '没有匹配的模板' : '还没有公共模板';
      empty.append(title);
      list.append(empty);
      return;
    }
    const fragment = document.createDocumentFragment();
    for (const item of rows) fragment.append(makeCard(item));
    list.append(fragment);
  }
  function makeCard(item) {
    const card = document.createElement('article');
    card.className = 'public-template-card';
    card.dataset.templateId = String(item.id);
    const top = document.createElement('div');
    top.className = 'public-template-card-top';
    const heading = document.createElement('div');
    heading.className = 'public-template-card-heading';
    const icon = document.createElement('span');
    icon.className = 'public-template-card-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = '▤';
    const name = document.createElement('h2');
    name.textContent = item.name || '未命名模板';
    heading.append(icon, name);
    const actions = document.createElement('div');
    actions.className = 'public-template-card-actions';
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'secondary';
    edit.dataset.action = 'edit';
    edit.dataset.id = String(item.id);
    edit.textContent = '编辑';
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'public-template-delete';
    remove.dataset.action = 'delete';
    remove.dataset.id = String(item.id);
    remove.setAttribute('aria-label', `删除${item.name || '模板'}`);
    remove.textContent = '删除';
    actions.append(edit, remove);
    top.append(heading, actions);
    const preview = document.createElement('pre');
    preview.className = 'public-template-preview';
    preview.textContent = item.content || '';
    const meta = document.createElement('div');
    meta.className = 'public-template-meta';
    const label = document.createElement('span');
    label.textContent = '更新于';
    const date = document.createElement('time');
    date.dateTime = item.updated_at || item.created_at || '';
    date.textContent = formatDate(item.updated_at || item.created_at);
    meta.append(label, date);
    card.append(top, preview, meta);
    return card;
  }
  async function loadTemplates() {
    const revision = ++requestRevision;
    const query = new URLSearchParams({ q: search.value.trim() });
    try {
      const payload = await request(`/api/public-templates?${query}`);
      if (revision !== requestRevision) return;
      const rows = Array.isArray(payload) ? payload : (payload?.templates || []);
      render(rows);
      showNotice('');
    } catch (error) {
      if (revision !== requestRevision) return;
      list.replaceChildren();
      const failed = document.createElement('p');
      failed.className = 'public-template-load-error';
      failed.textContent = error.message;
      list.append(failed);
      showNotice(error.message, 'error');
    }
  }
  function openEditor(item = null, trigger = document.activeElement) {
    opener = trigger;
    editingId = item ? String(item.id) : null;
    byId('publicTemplateDialogTitle').textContent = item ? '编辑模板' : '新建模板';
    byId('publicTemplateName').value = item?.name || '';
    byId('publicTemplateContent').value = item?.content || '';
    byId('savePublicTemplate').textContent = item ? '保存更改' : '保存模板';
    formError('');
    if (!editor.open) editor.showModal();
    requestAnimationFrame(() => byId('publicTemplateName').focus());
  }
  function closeEditor() {
    if (editor.open) editor.close();
  }
  function openDelete(item, trigger) {
    deletingId = String(item.id);
    opener = trigger;
    byId('publicTemplateDeleteCopy').textContent = `将删除“${item.name || '未命名模板'}”。此操作无法撤销。`;
    deleteError('');
    if (!deleteDialog.open) deleteDialog.showModal();
    requestAnimationFrame(() => byId('confirmPublicTemplateDelete').focus());
  }
  function closeDelete() {
    if (deleteDialog.open) deleteDialog.close();
  }
  list.addEventListener('click', event => {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    const item = items.get(button.dataset.id);
    if (!item) return;
    if (button.dataset.action === 'edit') openEditor(item, button);
    if (button.dataset.action === 'delete') openDelete(item, button);
  });
  editorForm.addEventListener('submit', async event => {
    event.preventDefault();
    const name = byId('publicTemplateName').value.trim();
    const content = byId('publicTemplateContent').value;
    if (!name || !content.trim()) {
      formError('请填写模板名称和正文。');
      return;
    }
    if (name.length > 80 || content.length > 20000) {
      formError('模板名称最多 80 字，正文最多 20,000 字。');
      return;
    }
    const save = byId('savePublicTemplate');
    const wasEditing = Boolean(editingId);
    save.disabled = true;
    formError('');
    try {
      const path = editingId ? `/api/admin/public-templates/${encodeURIComponent(editingId)}` : '/api/admin/public-templates';
      await request(path, { method: editingId ? 'PATCH' : 'POST', body: JSON.stringify({ name, content }) });
      closeEditor();
      await loadTemplates();
      showNotice(wasEditing ? '模板已更新。' : '模板已创建。');
    } catch (error) {
      formError(error.message);
      save.disabled = false;
      return;
    }
    save.disabled = false;
  });
  byId('confirmPublicTemplateDelete').addEventListener('click', async event => {
    const button = event.currentTarget;
    if (!deletingId) return;
    button.disabled = true;
    deleteError('');
    try {
      await request(`/api/admin/public-templates/${encodeURIComponent(deletingId)}`, { method: 'DELETE' });
      closeDelete();
      await loadTemplates();
      showNotice('模板已删除。');
      deletingId = null;
    } catch (error) {
      deleteError(error.message);
    } finally {
      button.disabled = false;
    }
  });
  byId('createPublicTemplate').addEventListener('click', event => openEditor(null, event.currentTarget));
  document.querySelectorAll('[data-close-editor]').forEach(button => button.addEventListener('click', closeEditor));
  document.querySelectorAll('[data-close-delete]').forEach(button => button.addEventListener('click', closeDelete));
  editor.addEventListener('close', () => { if (opener?.isConnected) opener.focus(); editingId = null; });
  deleteDialog.addEventListener('close', () => { if (opener?.isConnected) opener.focus(); deletingId = null; });
  editor.addEventListener('click', event => { if (event.target === editor) closeEditor(); });
  deleteDialog.addEventListener('click', event => { if (event.target === deleteDialog) closeDelete(); });
  search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(loadTemplates, 180);
  });
  loadTemplates();
})();
