const listEl = document.querySelector('#chatList');
const messagesEl = document.querySelector('#messages');
const welcomeEl = document.querySelector('#welcome');
const inputEl = document.querySelector('#messageInput');
const deleteButton = document.querySelector('#deleteChat');
const modelSelect = document.querySelector('#modelSelect');
const pendingEl = document.querySelector('#pendingFiles');
const fileInput = document.querySelector('#fileInput');
let activeChat = null;
let busy = false;
let modelOptions = [];
let selectedModel = { provider_id: '', model: '' };
let pendingFiles = [];
const csrfToken = document.querySelector('meta[name="csrf-token"]')?.content || '';
const markdown = window.markdownit({ html: false, linkify: true, breaks: true, typographer: false });

markdown.renderer.rules.link_open = (tokens, index, options, env, self) => {
  tokens[index].attrSet('target', '_blank');
  tokens[index].attrSet('rel', 'noopener noreferrer');
  return self.renderToken(tokens, index, options);
};

function esc(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      'X-CSRF-Token': csrfToken,
      ...(options.body && !(options.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {})
    }
  });
  if (response.status === 401) {
    location.href = '/login';
    throw new Error('登录已过期');
  }
  if (!response.ok) {
    let payload = {};
    try { payload = await response.json(); } catch {}
    throw new Error(payload.error || `请求失败 (${response.status})`);
  }
  return response.status === 204 ? null : response.json();
}

function protectMath(source) {
  const formulas = [];
  const delimited = /\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\)|\$[^$\n]+?\$/g;
  let protectedSource = String(source || '').replace(delimited, (raw, offset, full) => {
    if (full[offset - 1] === '\\') return raw;
    const display = raw.startsWith('$$') || raw.startsWith('\\[');
    const value = display ? raw.slice(2, -2) : raw.slice(1, -1);
    const token = `ASTROMATHTOKEN${formulas.length}END`;
    formulas.push({ token, value, source: raw, display });
    return token;
  });
  const bareLatex = /\\(?:boxed|frac|sqrt|text|mathrm|mathbf|operatorname)\{(?:[^{}]|\{[^{}]*\})*\}(?:\{(?:[^{}]|\{[^{}]*\})*\})?/g;
  protectedSource = protectedSource.replace(bareLatex, (raw, offset, full) => {
    if (full[offset - 1] === '\\') return raw;
    const token = `ASTROMATHTOKEN${formulas.length}END`;
    formulas.push({ token, value: raw, source: raw, display: false });
    return token;
  });
  return { protectedSource, formulas };
}

function replaceMathTokens(target, formulas) {
  if (!formulas.length) return;
  const formulaByToken = new Map(formulas.map(formula => [formula.token, formula]));
  const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  const tokenPattern = /ASTROMATHTOKEN\d+END/g;
  for (const node of nodes) {
    tokenPattern.lastIndex = 0;
    if (!tokenPattern.test(node.nodeValue)) continue;
    tokenPattern.lastIndex = 0;
    const fragment = document.createDocumentFragment();
    let cursor = 0;
    for (const match of node.nodeValue.matchAll(tokenPattern)) {
      fragment.append(document.createTextNode(node.nodeValue.slice(cursor, match.index)));
      const formula = formulaByToken.get(match[0]);
      const insideCode = node.parentElement?.closest('code, pre');
      if (!formula || insideCode) {
        fragment.append(document.createTextNode(formula?.source || match[0]));
      } else {
        const element = document.createElement(formula.display ? 'div' : 'span');
        element.className = formula.display ? 'math-block' : 'math-inline';
        try {
          window.katex.render(formula.value, element, {
            displayMode: formula.display,
            throwOnError: false,
            strict: 'ignore',
            trust: false
          });
        } catch {
          element.textContent = formula.source;
        }
        fragment.append(element);
      }
      cursor = match.index + match[0].length;
    }
    fragment.append(document.createTextNode(node.nodeValue.slice(cursor)));
    node.replaceWith(fragment);
  }
}

function renderMarkdown(target, source) {
  const { protectedSource, formulas } = protectMath(source);
  target.innerHTML = window.DOMPurify.sanitize(markdown.render(protectedSource));
  replaceMathTokens(target, formulas);
}

function modelKey(item) {
  return encodeURIComponent(JSON.stringify([item.provider_id, item.model]));
}

function selectModelValue(value) {
  if (!value) return { provider_id: '', model: '' };
  const [provider_id, model] = JSON.parse(decodeURIComponent(value));
  return { provider_id, model };
}

function renderModelOptions() {
  const current = selectedModel.provider_id ? modelKey(selectedModel) : '';
  modelSelect.innerHTML = '<option value="">AstrBot 默认</option>' +
    modelOptions.map(item => `<option value="${esc(modelKey(item))}">${esc(item.label)}</option>`).join('');
  modelSelect.value = current;
}

async function loadModels() {
  try {
    const data = await api('/api/models');
    modelOptions = data.models || [];
    renderModelOptions();
  } catch {
    modelSelect.innerHTML = '<option value="">AstrBot 默认</option>';
  }
}

function renderAttachments(container, attachments = []) {
  if (!attachments.length) return;
  const box = document.createElement('div');
  box.className = 'message-files';
  for (const attachment of attachments) {
    if (attachment.kind === 'image' || (attachment.mimetype || '').startsWith('image/')) {
      const image = document.createElement('img');
      image.className = 'message-image';
      image.src = `/api/attachments/${encodeURIComponent(attachment.id)}`;
      image.alt = attachment.filename || '图片';
      image.loading = 'lazy';
      image.onclick = () => window.open(image.src, '_blank', 'noopener');
      box.append(image);
    } else {
      const file = document.createElement('div');
      file.className = 'file-card';
      file.innerHTML = `<span class="file-icon">▤</span><span><b>${esc(attachment.filename || '附件')}</b><small>已添加</small></span>`;
      box.append(file);
    }
  }
  container.append(box);
}

function renderMessage(role, content, attachments = []) {
  const article = document.createElement('article');
  article.className = `message ${role}`;
  const messageContent = document.createElement('div');
  messageContent.className = 'message-content';
  const text = document.createElement('div');
  text.className = 'message-text';
  if (role === 'assistant') renderMarkdown(text, content || '');
  else text.innerHTML = esc(content || '').replace(/\n/g, '<br>');
  messageContent.append(text);
  renderAttachments(messageContent, attachments);
  article.append(messageContent);
  messagesEl.append(article);
  return text;
}

async function refreshChats() {
  const chats = await api('/api/chats');
  listEl.innerHTML = '';
  for (const chat of chats) {
    const button = document.createElement('button');
    button.className = `chat-item${activeChat === chat.id ? ' active' : ''}`;
    button.textContent = chat.title;
    button.onclick = () => openChat(chat.id);
    listEl.append(button);
  }
}

async function newChat() {
  const chat = await api('/api/chats', {
    method: 'POST',
    body: JSON.stringify({ selected_provider: selectedModel.provider_id, selected_model: selectedModel.model })
  });
  activeChat = chat.id;
  messagesEl.innerHTML = '';
  welcomeEl.hidden = false;
  deleteButton.hidden = false;
  await refreshChats();
  modelSelect.disabled = false;
  return chat;
}

async function openChat(id) {
  activeChat = id;
  pendingFiles = [];
  renderPendingFiles();
  const chats = await api('/api/chats');
  const chat = chats.find(item => item.id === id);
  selectedModel = chat?.selected_provider
    ? { provider_id: chat.selected_provider, model: chat.selected_model }
    : { provider_id: '', model: '' };
  renderModelOptions();
  messagesEl.innerHTML = '';
  welcomeEl.hidden = true;
  deleteButton.hidden = false;
  const rows = await api(`/api/chats/${id}/messages`);
  if (!rows.length) welcomeEl.hidden = false;
  for (const message of rows) renderMessage(message.role, message.content, message.attachments || []);
  await refreshChats();
  messagesEl.parentElement.scrollTop = messagesEl.parentElement.scrollHeight;
}

function renderPendingFiles() {
  pendingEl.innerHTML = '';
  for (const [index, file] of pendingFiles.entries()) {
    const item = document.createElement('div');
    item.className = 'pending-file';
    if (file.kind === 'image') item.innerHTML = `<img src="/api/attachments/${encodeURIComponent(file.id)}" alt=""><span>${esc(file.filename)}</span>`;
    else item.innerHTML = `<span class="file-icon">▤</span><span>${esc(file.filename)}</span>`;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '×';
    remove.onclick = () => { pendingFiles.splice(index, 1); renderPendingFiles(); };
    item.append(remove);
    pendingEl.append(item);
  }
}

async function uploadFiles(files) {
  for (const file of files) {
    if (pendingFiles.length >= 8) { alert('一次最多添加 8 个文件。'); break; }
    const form = new FormData();
    form.append('file', file);
    try {
      pendingFiles.push(await api('/api/upload', { method: 'POST', body: form }));
      renderPendingFiles();
    } catch (error) { alert(`${file.name}：${error.message}`); }
  }
  fileInput.value = '';
}

async function send(text) {
  text = text.trim();
  if ((!text && !pendingFiles.length) || busy) return;
  if (!activeChat) await newChat();
  busy = true;
  const attachments = [...pendingFiles];
  pendingFiles = [];
  renderPendingFiles();
  inputEl.value = '';
  inputEl.style.height = 'auto';
  welcomeEl.hidden = true;
  renderMessage('user', text, attachments);
  const target = renderMessage('assistant', '');
  const bubble = target.parentElement;
  const spinner = document.createElement('span');
  spinner.className = 'typing';
  spinner.textContent = '正在处理…';
  bubble.append(spinner);
  document.querySelector('#sendButton').disabled = true;
  let liveText = '';
  try {
    const response = await fetch(`/api/chats/${activeChat}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
      body: JSON.stringify({ message: text, attachments })
    });
    if (!response.ok) {
      let payload = {};
      try { payload = await response.json(); } catch {}
      throw new Error(payload.error || '发送失败');
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split('\n\n');
      buffer = frames.pop();
      for (const frame of frames) {
        const line = frame.split('\n').find(item => item.startsWith('data:'));
        if (!line) continue;
        const event = JSON.parse(line.slice(5).trim());
        if (event.error) throw new Error(event.error);
        if (event.text) {
          liveText += event.text;
          target.textContent = liveText;
          target.classList.add('streaming-text');
          spinner.remove();
        }
        if (Object.hasOwn(event, 'final')) {
          liveText = event.final || '';
          target.classList.remove('streaming-text');
          renderMarkdown(target, liveText);
          spinner.remove();
        }
        if (event.done) spinner.remove();
        messagesEl.parentElement.scrollTop = messagesEl.parentElement.scrollHeight;
      }
    }
    target.classList.remove('streaming-text');
    if (!target.textContent) target.textContent = '（没有文本回复）';
  } catch (error) {
    spinner.remove();
    target.classList.remove('streaming-text');
    if (!target.textContent) target.textContent = `请求出错：${error.message}`;
  } finally {
    busy = false;
    document.querySelector('#sendButton').disabled = false;
    await refreshChats();
    messagesEl.parentElement.scrollTop = messagesEl.parentElement.scrollHeight;
  }
}

document.querySelector('#newChat').onclick = () => newChat();
document.querySelector('#composer').onsubmit = event => { event.preventDefault(); send(inputEl.value); };
inputEl.onkeydown = event => {
  if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); send(inputEl.value); }
};
inputEl.oninput = () => { inputEl.style.height = 'auto'; inputEl.style.height = `${Math.min(inputEl.scrollHeight, 140)}px`; };
modelSelect.onchange = async () => {
  selectedModel = selectModelValue(modelSelect.value);
  if (activeChat) {
    try {
      await api(`/api/chats/${activeChat}`, {
        method: 'PATCH',
        body: JSON.stringify({ selected_provider: selectedModel.provider_id, selected_model: selectedModel.model })
      });
    } catch (error) { alert(error.message); }
  }
};
fileInput.onchange = () => uploadFiles([...fileInput.files]);
deleteButton.onclick = async () => {
  if (!activeChat || !confirm('删除这段对话记录？')) return;
  await api(`/api/chats/${activeChat}`, { method: 'DELETE' });
  activeChat = null;
  messagesEl.innerHTML = '';
  welcomeEl.hidden = false;
  deleteButton.hidden = true;
  await refreshChats();
};

(async () => { await loadModels(); await refreshChats(); })();
