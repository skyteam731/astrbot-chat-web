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


const $ = selector => document.querySelector(selector);
const viewport = $('#conversation');
let currentChat = null, followLatest = true, loading = false, listRevision = 0;
let uploading = 0, draftTimer, draftChain = Promise.resolve();
const draftKey = () => `studio-draft:${$('.shell').dataset.userId}:${activeChat || 'new'}`;
let noticeTimer;
function notify(message) { clearTimeout(noticeTimer);$('#notice').textContent=message;$('#notice').hidden=!message;if(message)noticeTimer=setTimeout(()=>{$('#notice').hidden=true;},6000); }
function action(label, callback) {
  const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
  button.onclick = () => Promise.resolve().then(callback).catch(error => notify(error.message)); return button;
}
function resizeInput() { inputEl.style.height = 'auto'; inputEl.style.height = `${Math.min(inputEl.scrollHeight, 160)}px`; }
function saveDraft() {
  clearTimeout(draftTimer);
  try { sessionStorage.setItem(draftKey(), inputEl.value); } catch {}
  if (!activeChat) return draftChain;
  const id = activeChat, draft = inputEl.value;
  draftChain = draftChain.catch(() => {}).then(() => api(`/api/chats/${id}`, {method:'PATCH',body:JSON.stringify({draft})}));
  return draftChain;
}
async function restoreDraft(id) {
  let local = null; try { local = sessionStorage.getItem(draftKey()); } catch {}
  const saved = id ? await api(`/api/chats/${id}/draft`) : {draft:''};
  inputEl.value = local ?? saved.draft ?? ''; resizeInput();
}
function scrollReply() {
  if (followLatest) viewport.scrollTop = viewport.scrollHeight;
  $('#jumpLatest').hidden = followLatest;
}
viewport.addEventListener('scroll', () => {
  followLatest = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 90;
  $('#jumpLatest').hidden = followLatest;
});
$('#jumpLatest').onclick = () => { followLatest = true; scrollReply(); };
async function copyText(text, button) {
  try { await navigator.clipboard.writeText(text); button.textContent = '已复制'; setTimeout(() => button.textContent = '复制', 1500); }
  catch { notify('复制失败，请选择文本后复制。'); }
}
function renderAttachments(container, attachments = []) {
  const box = document.createElement('div'); box.className = 'message-files';
  for (const attachment of attachments) {
    const link = document.createElement('a'); link.target = '_blank'; link.rel = 'noopener';
    link.href = `/api/attachments/${encodeURIComponent(attachment.id)}`;
    if (attachment.kind === 'image' || (attachment.mimetype || '').startsWith('image/')) {
      const image = document.createElement('img'); image.className = 'message-image'; image.src = link.href;
      image.alt = attachment.filename || '图片'; image.loading = 'lazy'; link.append(image);
    } else { link.className = 'file-card'; link.textContent = `${attachment.filename || '附件'} · 下载`; link.href += '?download=1'; }
    box.append(link);
  }
  if (attachments.length) container.append(box);
}
function renderMessage(role, content, attachments = [], messageId = null, bookmarkId = null) {
  const article = document.createElement('article'); article.className = `message ${role}`;
  if (messageId) article.dataset.messageId = messageId;
  const box = document.createElement('div'); box.className = 'message-content';
  const text = document.createElement('div'); text.className = 'message-text'; text.dataset.source = content || '';
  if (role === 'assistant') renderMarkdown(text, content || ''); else text.textContent = content || '';
  const actions = document.createElement('div'); actions.className = 'message-actions';
  const copy = action('复制', () => copyText(text.dataset.source, copy)); actions.append(copy);
  box.append(text); renderAttachments(box, attachments); box.append(actions); article.append(box); messagesEl.append(article);
  if (role === 'assistant') { article.dataset.bookmarkId = bookmarkId || ''; window.addBookmarkAction?.(article, bookmarkId); }
  return text;
}
function codeButtons(target) {
  for (const pre of target.querySelectorAll('pre')) {
    const code = pre.querySelector('code'); const button = action('复制', () => copyText(code?.textContent || '', button));
    button.className = 'code-copy'; pre.append(button);
  }
}
function setChatControls() {
  $('.page-title').textContent = currentChat?.title || '新对话';
  for (const id of ['deleteChat','renameChat','pinChat','archiveChat']) $('#'+id).hidden = !activeChat;
  $('#pinChat').textContent = currentChat?.pinned ? '取消置顶' : '置顶对话';
  $('#archiveChat').textContent = currentChat?.archived ? '移出归档' : '归档对话';
}
async function refreshChats() {
  const revision = ++listRevision;
  const archived = $('#showArchived').checked ? 1 : 0;
  const chats = await api(`/api/chats?q=${encodeURIComponent($('#chatSearch').value)}&archived=${archived}`);
  if (revision !== listRevision) return;
  const updated=chats.find(c=>c.id===activeChat); if(updated){currentChat=updated;setChatControls();}
  listEl.replaceChildren();
  if (!chats.length) { const empty = document.createElement('p'); empty.className='empty-history'; empty.textContent='没有找到对话'; listEl.append(empty); }
  let lastGroup = '';
  for (const chat of chats) {
    const date = new Date(chat.updated_at), today = new Date();
    const group = chat.pinned ? '置顶' : date.toDateString() === today.toDateString() ? '今天' : '更早';
    if(group !== lastGroup) { const label=document.createElement('div'); label.className='side-label'; label.textContent=group; listEl.append(label); lastGroup=group; }
    const button = action('', () => openChat(chat)); button.className=`chat-item chat-row${activeChat===chat.id?' active':''}`;
    const title = document.createElement('span'); title.className='chat-title'; title.textContent=chat.title;
    button.append(title); button.title=chat.title; listEl.append(button);
  }
}
function guardNavigation() { if (busy || uploading || loading) { notify('请先停止当前回复或等待上传完成。'); return false; } return true; }
async function newChat() {
  if (!guardNavigation()) return;
  window.setWorkspaceView?.('chats');
  await saveDraft(); activeChat=null; currentChat=null; pendingFiles=[]; renderPendingFiles();
  messagesEl.replaceChildren(); welcomeEl.hidden=false; setChatControls(); await restoreDraft(null); closeSidebar();
}
async function openChat(chat) {
  if (!guardNavigation()) return;
  loading=true;
  try {
    await saveDraft();
    const [rows, saved] = await Promise.all([api(`/api/chats/${chat.id}/messages`),api(`/api/chats/${chat.id}/draft`)]);
    let local=null;try{local=sessionStorage.getItem(`studio-draft:${$('.shell').dataset.userId}:${chat.id}`);}catch{}
    activeChat=chat.id; currentChat=chat;
    selectedModel={provider_id:chat.selected_provider || '',model:chat.selected_model || ''}; renderModelOptions();
    pendingFiles=[];renderPendingFiles();messagesEl.replaceChildren();welcomeEl.hidden=!!rows.length;
    for(const m of rows){const target=renderMessage(m.role,m.content,m.attachments || [],m.id,m.bookmark_id);if(m.role==='assistant')codeButtons(target);}
    inputEl.value=local ?? saved.draft ?? '';resizeInput();setChatControls();
    await refreshChats();followLatest=true;scrollReply();closeSidebar();
  } finally { loading=false; }
}
function renderPendingFiles() {
  pendingEl.replaceChildren();
  pendingFiles.forEach((file,index)=>{
    const item=document.createElement('div'); item.className='pending-file';
    if(file.kind==='image') { const img=document.createElement('img'); img.src=`/api/attachments/${encodeURIComponent(file.id)}`; img.alt=''; item.append(img); }
    const name=document.createElement('span'); name.textContent=file.filename; item.append(name);
    const remove=action('×',()=>{pendingFiles.splice(index,1);renderPendingFiles();}); remove.setAttribute('aria-label',`移除 ${file.filename}`); item.append(remove); pendingEl.append(item);
  });
}
function uploadOne(file) {
  return new Promise((resolve,reject)=>{
    const row=document.createElement('div'); row.className='upload-item';
    const label=document.createElement('span'); label.textContent=file.name;
    const progress=document.createElement('progress'); progress.max=100; progress.value=0;
    const xhr=new XMLHttpRequest(); const cancel=action('取消',()=>xhr.abort()); row.append(label,progress,cancel); $('#uploadQueue').append(row);
    xhr.open('POST','/api/upload'); xhr.setRequestHeader('X-CSRF-Token',csrfToken);
    xhr.upload.onprogress=e=>{if(e.lengthComputable)progress.value=e.loaded/e.total*100;};
    xhr.onload=()=>{ let data={}; try{data=JSON.parse(xhr.responseText);}catch{} row.remove();
      if(xhr.status>=200&&xhr.status<300)resolve(data);else reject(new Error(data.error||'上传失败')); };
    xhr.onerror=()=>{row.remove();reject(new Error('网络连接中断'));};
    xhr.onabort=()=>{row.remove();reject(new Error('已取消上传'));};
    const form=new FormData(); form.append('file',file); xhr.send(form);
  });
}
async function uploadFiles(files) {
  if(busy || uploading || loading){notify('请等待当前操作完成。');return;}
  uploading++; $('#sendButton').disabled=true;
  try { for(const file of files){
    if(pendingFiles.length>=8){notify('一次最多添加 8 个附件。');break;}
    if(file.size>25*1024*1024){notify(`${file.name} 超过 25 MB。`);continue;}
    try {pendingFiles.push(await uploadOne(file));renderPendingFiles();}
    catch(error){ const row=document.createElement('div');row.className='upload-item message-error';row.append(document.createTextNode(`${file.name}：${error.message} `));
      row.append(action('重试',()=>{row.remove();return uploadFiles([file]);}),action('移除',()=>row.remove()));$('#uploadQueue').append(row); }
  }} finally{uploading--;$('#sendButton').disabled=false;fileInput.value='';}
}
async function send(text) {
  text=text.trim(); if((!text&&!pendingFiles.length)||busy||uploading||loading)return;
  busy=true;for(const button of messagesEl.querySelectorAll('.bookmark-action,.template-followup'))button.disabled=true; notify(''); modelSelect.disabled=true; $('#sendButton').disabled=true; $('#stopButton').hidden=false;
  const attachments=[...pendingFiles]; let target=null, complete=false;
  try {
    if(!activeChat){
      const chat=await api('/api/chats',{method:'POST',body:JSON.stringify({selected_provider:selectedModel.provider_id,selected_model:selectedModel.model})});
      activeChat=chat.id;currentChat=chat;setChatControls();try{sessionStorage.removeItem(`studio-draft:${$('.shell').dataset.userId}:new`);}catch{}
    }
    await saveDraft(); pendingFiles=[];renderPendingFiles();inputEl.value='';resizeInput();await saveDraft();welcomeEl.hidden=true;
    const userTarget=renderMessage('user',text,attachments);target=renderMessage('assistant','');target.textContent='正在连接…';
    followLatest=true;scrollReply();let liveText='';
    const response=await fetch(`/api/chats/${activeChat}/send`,{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrfToken},body:JSON.stringify({message:text,attachments})});
    if(!response.ok){const data=await response.json().catch(()=>({}));throw new Error(data.error||`发送失败 (${response.status})`);}
    const reader=response.body.getReader(), decoder=new TextDecoder();let buffer='';
    while(true){const {value,done}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});const frames=buffer.split('\n\n');buffer=frames.pop();
      for(const frame of frames){const line=frame.split('\n').find(line=>line.startsWith('data:'));if(!line)continue;const event=JSON.parse(line.slice(5));
        if(event.error)throw new Error(event.error);
        if(event.text){liveText+=event.text;target.textContent=liveText;target.classList.add('streaming-text');}
        if(Object.prototype.hasOwnProperty.call(event,'final')){liveText=event.final||'';target.classList.remove('streaming-text');renderMarkdown(target,liveText);}
        if(event.done){complete=true;if(event.user_message_id)userTarget.closest('.message').dataset.messageId=event.user_message_id;if(event.assistant_message_id)target.closest('.message').dataset.messageId=event.assistant_message_id;}target.dataset.source=liveText;scrollReply();
      }
    }
    if(!complete)throw new Error('连接已中断，回复可能不完整。');
    target.classList.remove('streaming-text');renderMarkdown(target,liveText || '（本次没有文本回复）');codeButtons(target);window.addBookmarkAction?.(target.closest('.message'),null);
  }catch(error){
    const row=document.createElement('div');row.className='message-error';row.setAttribute('role','alert');row.textContent=error.message+' ';
    row.append(action('恢复输入',()=>{inputEl.value=text;pendingFiles=attachments;renderPendingFiles();resizeInput();return saveDraft();}));
    (target?.parentElement || messagesEl).append(row);
    if(target&&!target.dataset.source)target.textContent='';
    if(!inputEl.value){inputEl.value=text;pendingFiles=attachments;renderPendingFiles();resizeInput();try{await saveDraft();}catch{notify('Draft sync failed');}}
  }finally{
    busy=false;for(const article of messagesEl.querySelectorAll('.message.assistant'))window.addBookmarkAction?.(article,article.dataset.bookmarkId);modelSelect.disabled=false;$('#sendButton').disabled=false;$('#stopButton').hidden=true;document.querySelectorAll('.bookmark-action:not([aria-pressed="true"])').forEach(button=>button.disabled=false);
    try{await refreshChats();}catch(e){notify(e.message);}scrollReply();
  }
}
$('#stopButton').onclick=async()=>{
  if(!activeChat)return;$('#stopButton').disabled=true;
  try{await api(`/api/chats/${activeChat}/stop`,{method:'POST'});notify('已请求停止生成。');}
  catch(e){notify(e.message);}finally{$('#stopButton').disabled=false;}
};
function syncSidebarAccess(){const mobile=matchMedia('(max-width: 900px)').matches;const open=document.body.classList.contains('sidebar-open');$('#sidebar').inert=mobile&&!open;$('.main').inert=mobile&&open;}
function closeSidebar(){const open=document.body.classList.contains('sidebar-open');document.body.classList.remove('sidebar-open');$('#sidebarToggle').setAttribute('aria-expanded','false');syncSidebarAccess();if(open)$('#sidebarToggle').focus();}
$('#sidebarToggle').onclick=()=>{
  if(matchMedia('(max-width: 900px)').matches)document.body.classList.toggle('sidebar-open');
  else document.body.classList.toggle('sidebar-collapsed');
  $('#sidebarToggle').setAttribute('aria-expanded',String(document.body.classList.contains('sidebar-open')));syncSidebarAccess();if(document.body.classList.contains('sidebar-open'))$('#newChat').focus();
};
$('#sidebarBackdrop').onclick=closeSidebar;
$('#sidebarClose').onclick=closeSidebar;
document.addEventListener('keydown',e=>{if(e.key==='Escape')closeSidebar();});
$('#newChat').onclick=()=>newChat().catch(e=>notify(e.message));
$('#composer').onsubmit=e=>{e.preventDefault();send(inputEl.value);};
inputEl.onkeydown=e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing&&e.keyCode!==229){e.preventDefault();send(inputEl.value);}};
inputEl.oninput=()=>{resizeInput();try{sessionStorage.setItem(draftKey(),inputEl.value);}catch{}clearTimeout(draftTimer);draftTimer=setTimeout(()=>saveDraft().catch(e=>notify('草稿同步失败：'+e.message)),500);};
inputEl.addEventListener('paste',e=>{const files=[...(e.clipboardData?.files||[])];if(files.length){e.preventDefault();uploadFiles(files);}});
const composer=$('#composer');composer.ondragover=e=>{e.preventDefault();composer.classList.add('drag-over');};
composer.ondragleave=()=>composer.classList.remove('drag-over');composer.ondrop=e=>{e.preventDefault();composer.classList.remove('drag-over');uploadFiles([...e.dataTransfer.files]);};
fileInput.onchange=()=>uploadFiles([...fileInput.files]);
let searchTimer;$('#chatSearch').oninput=()=>{clearTimeout(searchTimer);if(typeof workspaceMode!=='undefined'&&workspaceMode!=='chats')return;searchTimer=setTimeout(()=>refreshChats().catch(e=>notify(e.message)),200);};
$('#showArchived').onchange=()=>refreshChats().catch(e=>notify(e.message));
async function changeChat(patch){if(!activeChat||!guardNavigation())return;await api(`/api/chats/${activeChat}`,{method:'PATCH',body:JSON.stringify(patch)});Object.assign(currentChat,patch);setChatControls();await refreshChats();}
$('#renameChat').onclick=()=>{const title=prompt('对话名称',currentChat?.title||'');if(title?.trim())changeChat({title:title.trim()}).catch(e=>notify(e.message));};
$('#pinChat').onclick=()=>changeChat({pinned:!currentChat?.pinned}).catch(e=>notify(e.message));
$('#archiveChat').onclick=()=>changeChat({archived:!currentChat?.archived}).catch(e=>notify(e.message));
deleteButton.onclick=async()=>{if(!activeChat||!guardNavigation()||!confirm('删除这段对话？此操作不可撤销。'))return;try{await api(`/api/chats/${activeChat}`,{method:'DELETE'});try{sessionStorage.removeItem(draftKey());}catch{}activeChat=null;currentChat=null;inputEl.value='';await newChat();await refreshChats();}catch(e){notify(e.message);}};
modelSelect.onchange=async()=>{const previous=selectedModel;selectedModel=selectModelValue(modelSelect.value);try{if(activeChat)await api(`/api/chats/${activeChat}`,{method:'PATCH',body:JSON.stringify({selected_provider:selectedModel.provider_id,selected_model:selectedModel.model})});}catch(e){selectedModel=previous;renderModelOptions();notify(e.message);}};
if(window.visualViewport){const fit=()=>document.documentElement.style.setProperty('--app-height',`${window.visualViewport.height}px`);visualViewport.addEventListener('resize',fit);fit();}
(async()=>{try{await loadModels();await refreshChats();await restoreDraft(null);setChatControls();}catch(e){notify(e.message);}})();

matchMedia('(max-width: 900px)').addEventListener('change',syncSidebarAccess);syncSidebarAccess();
