/* Project, template and bookmark UI for v1.3.0. Uses the shared API and chat renderer. */
let workspaceMode = 'chats';
let projectCache = [];
let bookmarkCache = [];
let templateCache = [];
let exampleCache = [];
let dialogOpener = null;
let activeTemplate = null;
const workspaceDialog = $('#workspaceDialog');
const dialogBody = $('#dialogBody');
const projectListEl = $('#projectList');
const templateApi = '/api/templates';

function showNotice(message) { notify(message); }
function setWorkspaceView(view) {
  if((busy||uploading||loading)){notify('请先等待当前回复或上传完成。');return;}
  workspaceMode = view;
  $('#chatList').hidden = view !== 'chats';
  $('#chatMenu').hidden = view !== 'chats';
  closeSidebar();
  for (const button of document.querySelectorAll('.workspace-nav-item')) button.classList.toggle('active', button.dataset.view === view);
  document.querySelector('.history-heading').hidden = view !== 'chats';
  $('#chatArchiveFilter').hidden = view !== 'chats';
  $('#projectArchiveFilter').hidden = view !== 'projects';
  $('#projectList').closest('.project-sidebar').classList.toggle('expanded', view === 'projects');
  $('#chatSearch').placeholder = '搜索历史';
  $('#workspaceMain').hidden = view === 'chats';
  $('#projectPage').hidden = view !== 'projects';
  $('#bookmarksPage').hidden = view !== 'bookmarks';
  $('#conversation').hidden = view !== 'chats';
  $('#composer').hidden = view !== 'chats';
  $('#jumpLatest').hidden = view !== 'chats' || followLatest;
  $('.model-control').hidden = view !== 'chats';
  if(view==='projects') loadProjects().catch(error=>notify(error.message));
  if (view === 'bookmarks') loadBookmarks().catch(error => notify(error.message));
  else if (view === 'chats') refreshChats().catch(error => notify(error.message));
  $('.page-title').textContent = view === 'projects' ? '项目空间' : view === 'bookmarks' ? '收藏与笔记' : currentChat?.title || '请输入文本工作室';
  renderProjectContext();
}
function projectName(id) { return projectCache.find(item => item.id === id)?.name || ''; }
function renderProjectContext() {
  const button = $('#projectContext');
  const selectedId=currentChat?.project_id || (!activeChat?projectFilter:null);
  const name = selectedId && selectedId!=='all' && selectedId!=='none' ? currentChat?.project_name||projectName(selectedId) : '';
  button.hidden = !name;
  button.textContent = name ? `▰ ${name}　×` : '';
  button.title = name ? (activeChat?'将当前会话移至未分组':'清除此新会话的项目') : '';
}
function syncProjectControls(){
  const button=$('#moveChat');if(!button)return;
  button.hidden=!activeChat;
  if(activeChat)button.textContent=currentChat?.project_name?'更换/移出项目':'移入项目';
  renderProjectContext();
}
window.syncProjectControls=syncProjectControls;
async function openProjectAssignment(){
  if(!activeChat||busy||uploading||loading){notify('请先等待当前操作完成。');return;}
  try{
    const projects=await api('/api/projects?q=&archived=0');
    const options=[{id:null,name:'未分组'},...projects];
    const current=currentChat?.project_id||null;
    const html=`<p class="dialog-copy">选择会话归属。项目说明只用于整理，不会作为模型上下文。</p><div class="assignment-list">${options.map(item=>`<button type="button" class="assignment-option${(item.id||'')===(current||'')?' selected':''}" data-project-id="${item.id||''}"><span class="project-glyph">${item.id?'▰':'□'}</span><span>${esc(item.name)}</span><span class="assignment-check">${(item.id||'')===(current||'')?'当前':''}</span></button>`).join('')}</div><div class="form-actions"><button class="secondary" type="button" data-dialog-close>取消</button></div>`;
    openDialog('移动会话','项目空间',html,document.activeElement);
    dialogBody.querySelector('[data-dialog-close]').onclick=closeDialog;
    for(const option of dialogBody.querySelectorAll('[data-project-id]'))option.onclick=async()=>{
      const value=option.dataset.projectId||null;
      try{await api(`/api/chats/${activeChat}`,{method:'PATCH',body:JSON.stringify({project_id:value})});currentChat.project_id=value;currentChat.project_name=value?projectName(value):null;projectFilter=value||'none';setWorkspaceView('chats');renderProjects();closeDialog();notify(value?'会话已移入项目':'会话已移至未分组');}
      catch(error){notify(error.message);}
    };
  }catch(error){notify(error.message);}
}
async function selectProjectFilter(value){
  if(!guardNavigation())return;
  if(activeChat)await newChat();
  projectFilter=value;
  setWorkspaceView('chats');renderProjects();renderProjectContext();
}
async function loadProjects() {
  const archived = $('#showArchivedProjects').checked ? 1 : 0;
  const q=workspaceMode==='projects'?$('#projectPageSearch').value:$('#projectSearch').value;
  projectCache = await api(`/api/projects?q=${encodeURIComponent(q)}&archived=${archived}`);
  $('#projectCount').textContent = projectCache.length ? String(projectCache.length) : '';
  renderProjects();
  if(workspaceMode==='projects')renderProjectCards();
  renderProjectContext();
}
function renderProjects() {
  projectListEl.replaceChildren();
  const shortcuts = document.createElement('div'); shortcuts.className = 'project-shortcuts';
  for (const [label, value] of [['未分组','none']]) {
    const button = document.createElement('button'); button.type = 'button'; button.className = `project-row${projectFilter === value ? ' active' : ''}`;
    button.innerHTML = `<span class="project-glyph">${value === 'all' ? '▤' : '□'}</span><span>${label}</span>`;
    button.onclick = () => selectProjectFilter(value);
    shortcuts.append(button);
  }
  projectListEl.append(shortcuts);
  if (!projectCache.length) {
    const empty = document.createElement('p'); empty.className = 'empty-history'; empty.textContent = $('#showArchivedProjects').checked ? '没有已归档项目' : '还没有项目'; projectListEl.append(empty); return;
  }
  for (const project of projectCache) {
    const row = document.createElement('div'); row.className = `project-row-wrap${projectFilter === project.id ? ' active' : ''}`;
    const select = document.createElement('button'); select.type = 'button'; select.className = 'project-row';
    const glyph = document.createElement('span'); glyph.className='project-glyph'; glyph.textContent='▰';
    const title = document.createElement('span'); title.className='project-title'; title.textContent=project.name;
    select.append(glyph,title); select.title=project.description || project.name;
    select.onclick=()=>selectProjectFilter(project.id);
    const more = document.createElement('button'); more.type='button'; more.className='project-more'; more.textContent='•••'; more.title='项目选项'; more.setAttribute('aria-label',`${project.name}项目选项`);
    more.onclick=()=>openProjectEditor(project);
    row.append(select,more); projectListEl.append(row);
  }
}
function renderProjectCards(){
  const target=$('#projectCards');target.replaceChildren();
  if(!projectCache.length){const empty=document.createElement('p');empty.className='empty-history';empty.textContent=$('#showArchivedProjects').checked?'没有已归档项目':'还没有项目，创建项目后可将相关会话整理在一起。';target.append(empty);return;}
  for(const project of projectCache){
    const card=document.createElement('article');card.className='project-card';
    const glyph=document.createElement('span');glyph.className='project-card-glyph';glyph.textContent='▰';
    const title=document.createElement('h2');title.textContent=project.name;
    const description=document.createElement('p');description.textContent=project.description||'暂无说明';
    const state=document.createElement('span');state.className='project-state';state.textContent=project.archived?'已归档':'项目';
    const open=document.createElement('button');open.type='button';open.className='primary';open.textContent='查看会话';open.onclick=()=>selectProjectFilter(project.id);
    const create=document.createElement('button');create.type='button';create.className='secondary';create.textContent='新建会话';create.onclick=async()=>{await selectProjectFilter(project.id);inputEl.focus();};
    const edit=document.createElement('button');edit.type='button';edit.className='secondary';edit.textContent='设置';edit.onclick=()=>openProjectEditor(project);
    card.append(glyph,state,title,description,open,create,edit);target.append(card);
  }
}
function openDialog(title, eyebrow, html, opener = document.activeElement) {
  if(!workspaceDialog.open && !dialogOpener?.isConnected)dialogOpener = opener;
  $('#chatMenu').open=false;
  $('#dialogTitle').textContent = title;
  $('#dialogEyebrow').textContent = eyebrow;
  dialogBody.innerHTML = html;
  if(!workspaceDialog.open)workspaceDialog.showModal();
  requestAnimationFrame(() => dialogBody.querySelector('input,textarea,button,[tabindex]:not([tabindex="-1"])')?.focus());
}
function closeDialog() {
  if (workspaceDialog.open) workspaceDialog.close();
}
$('#dialogClose').onclick = closeDialog;
workspaceDialog.addEventListener('click', event => { if (event.target === workspaceDialog) closeDialog(); });
workspaceDialog.addEventListener('close', () => { if(workspaceDialog.open)return; dialogBody.replaceChildren(); dialogOpener?.focus?.(); dialogOpener = null; });

function openProjectEditor(project = null) {
  const editing = !!project;
  openDialog(editing ? '项目设置' : '新建项目', '项目空间', `<form id="projectForm" class="workspace-form"><label>项目名称<input name="name" maxlength="80" required value="${editing ? esc(project.name) : ''}" placeholder="例如：春季活动"></label><label>项目说明 <span class="field-hint">仅用于组织，不会发送给模型</span><textarea name="description" rows="3" maxlength="2000" placeholder="简短描述这个项目">${editing ? esc(project.description || '') : ''}</textarea></label><div class="form-actions"><button class="primary" type="submit">${editing ? '保存更改' : '创建项目'}</button><button class="secondary" type="button" data-dialog-close>取消</button></div></form>${editing ? `<div class="dialog-divider"></div><div class="project-danger"><div><b>${project.archived ? '恢复项目' : '归档项目'}</b><small>${project.archived ? '重新显示在项目列表中' : '项目会从默认列表隐藏'}</small></div><button class="secondary" type="button" id="toggleProjectArchive">${project.archived ? '恢复' : '归档'}</button></div><div class="project-danger"><div><b>删除项目</b><small>会移除项目归属，保留其中的会话。</small></div><button class="danger-button" type="button" id="deleteProject">删除</button></div>` : ''}`, document.activeElement);
  $('#projectForm').onsubmit=async event=>{
    event.preventDefault(); const data=new FormData(event.currentTarget); const payload={name:String(data.get('name')).trim(),description:String(data.get('description')).trim()};
    try{const saved=await api(editing?`/api/projects/${project.id}`:'/api/projects',{method:editing?'PATCH':'POST',body:JSON.stringify(payload)});if(!editing)projectCache.unshift(saved);await loadProjects();closeDialog();notify(editing?'项目已更新':'项目已创建');}
    catch(error){notify(error.message);}
  };
  dialogBody.querySelector('[data-dialog-close]')?.addEventListener('click',closeDialog);
  if(editing){
    $('#toggleProjectArchive').onclick=async()=>{try{await api(`/api/projects/${project.id}`,{method:'PATCH',body:JSON.stringify({archived:!project.archived})});await loadProjects();closeDialog();notify(project.archived?'项目已恢复':'项目已归档');}catch(error){notify(error.message);}};
    $('#deleteProject').onclick=()=>confirmProjectDelete(project);
  }
}
function confirmProjectDelete(project) {
  openDialog('删除项目？','请确认',`<p class="dialog-copy">删除“${esc(project.name)}”只会解除会话与项目的关联；项目中的会话仍会保留并出现在“未分组”中。</p><div class="form-actions"><button id="confirmDeleteProject" class="danger-button" type="button">删除项目</button><button class="secondary" type="button" data-dialog-close>取消</button></div>`,document.activeElement);
  dialogBody.querySelector('[data-dialog-close]').onclick=closeDialog;
  $('#confirmDeleteProject').onclick=async()=>{try{await api(`/api/projects/${project.id}`,{method:'DELETE'});if(projectFilter===project.id)projectFilter='none';await loadProjects();await refreshChats();closeDialog();notify('项目已删除，会话已移至未分组');}catch(error){notify(error.message);}};
}

async function loadBookmarks() {
  bookmarkCache = await api(`/api/bookmarks?q=${encodeURIComponent($('#bookmarkPageSearch').value)}`);
  $('#bookmarkCount').textContent = bookmarkCache.length ? String(bookmarkCache.length) : '';
  renderBookmarks();
}
function addBookmarkAction(article, bookmarkId) {
  const actions=article.querySelector('.message-actions'); if(!actions)return;
  const existing=actions.querySelector('.bookmark-action');if(existing){existing.disabled=!article.dataset.messageId||busy;return;}
  article.dataset.bookmarkId=bookmarkId || '';
  const button=document.createElement('button');button.type='button';button.className='bookmark-action';button.textContent=bookmarkId?'★ 已收藏':'☆ 收藏';button.setAttribute('aria-pressed',String(!!bookmarkId));button.disabled=!bookmarkId&&(!article.dataset.messageId||busy);
  button.onclick=async()=>{
    if(busy||!article.dataset.messageId)return;
    button.disabled=true;
    try{
      if(article.dataset.bookmarkId){await api(`/api/bookmarks/${article.dataset.bookmarkId}`,{method:'DELETE'});article.dataset.bookmarkId='';button.textContent='☆ 收藏';button.setAttribute('aria-pressed','false');notify('已取消收藏');}
      else{const saved=await api('/api/bookmarks',{method:'POST',body:JSON.stringify({message_id:Number(article.dataset.messageId)})});article.dataset.bookmarkId=saved.id;button.textContent='★ 已收藏';button.setAttribute('aria-pressed','true');notify('已加入收藏');}
    }catch(error){notify(error.message);}finally{button.disabled=false;}
  };
  actions.append(button);
}
window.addBookmarkAction=addBookmarkAction;
function renderBookmarks() {
  const target=$('#bookmarkResults');target.replaceChildren();
  if(!bookmarkCache.length){const empty=document.createElement('p');empty.className='empty-history';empty.textContent='没有找到收藏';target.append(empty);return;}
  for(const bookmark of bookmarkCache){
    const card=document.createElement('article');card.className='bookmark-card';
    const content=document.createElement('div');content.className='bookmark-content';
    renderMarkdown(content,bookmark.content||'');
    const meta=document.createElement('div');meta.className='bookmark-meta';
    const source=document.createElement('button');source.type='button';source.className='bookmark-source';source.textContent=bookmark.source_available?`↗ ${bookmark.source_title||'打开来源会话'}`:`来源会话已删除 · ${bookmark.source_title||'快照仍可阅读'}`;
    source.disabled=!bookmark.source_available;
    source.onclick=()=>openBookmarkSource(bookmark);
    const date=document.createElement('time');date.textContent=bookmark.created_at?new Date(bookmark.created_at).toLocaleString('zh-CN',{dateStyle:'short',timeStyle:'short'}):'';meta.append(source,date);
    const note=document.createElement('textarea');note.className='bookmark-note';note.rows=2;note.maxLength=10000;note.placeholder='添加备注…';note.value=bookmark.note||'';note.setAttribute('aria-label','收藏备注');
    const save=document.createElement('button');save.type='button';save.className='small-button bookmark-save';save.textContent='保存备注';
    save.onclick=async()=>{try{await api(`/api/bookmarks/${bookmark.id}`,{method:'PATCH',body:JSON.stringify({note:note.value})});bookmark.note=note.value;save.textContent='已保存';setTimeout(()=>save.textContent='保存备注',1400);}catch(error){notify(error.message);}};
    const remove=document.createElement('button');remove.type='button';remove.className='quiet-icon bookmark-remove';remove.textContent='×';remove.title='取消收藏';remove.setAttribute('aria-label','取消收藏');
    remove.onclick=async()=>{try{await api(`/api/bookmarks/${bookmark.id}`,{method:'DELETE'});for(const a of messagesEl.querySelectorAll('.message.assistant'))if(Number(a.dataset.messageId)===bookmark.message_id){a.dataset.bookmarkId='';const btn=a.querySelector('.bookmark-action');if(btn){btn.textContent='☆ 收藏';btn.setAttribute('aria-pressed','false');}}await loadBookmarks();notify('已取消收藏');}catch(error){notify(error.message);}};
    card.append(content,meta,note,save,remove);target.append(card);
  }
}
async function openBookmarkSource(bookmark) {
  if(!bookmark.source_available)return;
  try{
    const chat=await api(`/api/chats/${bookmark.source_chat_id}`);
    $('#showArchived').checked=!!chat.archived;
    projectFilter=chat.project_id||'none';setWorkspaceView('chats');await openChat(chat);
    const article=[...messagesEl.querySelectorAll('.message')].find(item=>item.dataset.messageId===String(bookmark.message_id));
    if(article){article.scrollIntoView({behavior:'smooth',block:'center'});article.classList.add('bookmark-highlight');setTimeout(()=>article.classList.remove('bookmark-highlight'),1800);}
  }catch(error){notify(error.message);}
}

function openTemplates() { Promise.all([loadTemplates(),loadExamples()]).then(renderTemplateManager).catch(error=>notify(error.message)); }
async function loadTemplates() { templateCache=await api(`${templateApi}?q=${encodeURIComponent($('#templateSearch')?.value||'')}`); }
async function loadExamples() { exampleCache=await api('/api/template-examples'); }
function renderTemplateManager() {
  openDialog('提示模板','起草工具',`<div class="template-toolbar"><label class="search-box"><span aria-hidden="true">⌕</span><input id="templateSearch" type="search" placeholder="搜索我的模板"></label><button id="newTemplate" class="primary" type="button">＋ 新建模板</button></div><div class="template-columns"><section><h3>我的模板</h3><div id="myTemplates" class="template-list"></div></section><section><h3>示例 · 复制后可编辑</h3><div id="exampleTemplates" class="template-list"></div></section></div>`,document.activeElement);
  const own=$('#myTemplates'), examples=$('#exampleTemplates');
  if(!templateCache.length)own.innerHTML='<p class="empty-history">还没有自己的模板</p>';
  for(const item of templateCache)own.append(templateCard(item,false));
  for(const item of exampleCache)examples.append(templateCard(item,true));
  $('#newTemplate').onclick=()=>editTemplate();
  $('#templateSearch').oninput=()=>{clearTimeout(window.templateSearchTimer);window.templateSearchTimer=setTimeout(async()=>{try{await loadTemplates();const list=$('#myTemplates');if(!list)return;list.replaceChildren();if(!templateCache.length)list.innerHTML='<p class="empty-history">没有匹配的模板</p>';else templateCache.forEach(item=>list.append(templateCard(item,false)));}catch(error){notify(error.message);}},180);};
}
function templateCard(item, example) {
  const card=document.createElement('article');card.className='template-card';
  const title=document.createElement('h4');title.textContent=item.name;
  const preview=document.createElement('p');preview.textContent=item.content;preview.className='template-preview';
  const actions=document.createElement('div');actions.className='template-card-actions';
  const use=document.createElement('button');use.type='button';use.className='small-button';use.textContent=example?'复制为我的模板':'插入草稿';use.onclick=()=>example?editTemplate({name:item.name,content:item.content}):previewTemplate(item);
  actions.append(use);
  if(!example){const edit=document.createElement('button');edit.type='button';edit.className='quiet-icon';edit.textContent='编辑';edit.onclick=()=>editTemplate(item);const del=document.createElement('button');del.type='button';del.className='quiet-icon danger-text';del.textContent='删除';del.onclick=()=>deleteTemplate(item);actions.append(edit,del);}
  card.append(title,preview,actions);return card;
}
function editTemplate(item=null) {
  const editing=!!item?.id;
  openDialog(editing?'编辑模板':item?'复制示例':'新建模板','提示模板',`<form id="templateForm" class="workspace-form"><label>模板名称<input name="name" maxlength="80" required value="${item?esc(item.name):''}"></label><label>模板正文<textarea name="content" rows="9" maxlength="20000" required placeholder="写下希望复用的起草指令">${item?esc(item.content):''}</textarea></label><div class="form-actions"><button class="primary" type="submit">${editing?'保存更改':'保存到我的模板'}</button><button class="secondary" type="button" data-dialog-close>取消</button></div></form>`,document.activeElement);
  dialogBody.querySelector('[data-dialog-close]').onclick=closeDialog;
  $('#templateForm').onsubmit=async event=>{event.preventDefault();const data=new FormData(event.currentTarget);const payload={name:String(data.get('name')).trim(),content:String(data.get('content')).trim()};try{await api(editing?`${templateApi}/${item.id}`:templateApi,{method:editing?'PATCH':'POST',body:JSON.stringify(payload)});await loadTemplates();closeDialog();openTemplates();notify(editing?'模板已保存':'模板已加入我的模板');}catch(error){notify(error.message);}};
}
function deleteTemplate(item) {
  openDialog('删除模板？','请确认',`<p class="dialog-copy">删除“${esc(item.name)}”后无法恢复。</p><div class="form-actions"><button id="confirmDeleteTemplate" class="danger-button" type="button">删除模板</button><button class="secondary" type="button" data-dialog-close>取消</button></div>`,document.activeElement);
  dialogBody.querySelector('[data-dialog-close]').onclick=closeDialog;
  $('#confirmDeleteTemplate').onclick=async()=>{try{await api(`${templateApi}/${item.id}`,{method:'DELETE'});await loadTemplates();closeDialog();openTemplates();notify('模板已删除');}catch(error){notify(error.message);}};
}
function previewTemplate(item) {
  activeTemplate=item;
  openDialog('预览模板','插入前可继续编辑',`<div class="template-preview-full"><h3>${esc(item.name)}</h3><pre>${esc(item.content)}</pre></div><div class="form-actions"><button id="insertAppend" class="primary" type="button">${inputEl.value.trim()?'追加到草稿':'插入草稿'}</button>${inputEl.value.trim()?'<button id="insertReplace" class="secondary" type="button">替换现有草稿</button>':''}<button class="secondary" type="button" data-dialog-close>取消</button></div>`,document.activeElement);
  $('#insertAppend').onclick=()=>insertTemplate(item.content,false);
  $('#insertReplace')?.addEventListener('click',()=>insertTemplate(item.content,true));
  dialogBody.querySelector('[data-dialog-close]').onclick=closeDialog;
}
function insertTemplate(content, replace) {
  const next=replace||!inputEl.value.trim()?content:`${inputEl.value.trimEnd()}\n\n${content}`;
  if(next.length>20000){notify('插入后会超过草稿 20,000 字限制，请先精简模板或现有草稿。');return;}
  inputEl.value=next;
  inputEl.focus();inputEl.setSelectionRange(inputEl.value.length,inputEl.value.length);resizeInput();inputEl.dispatchEvent(new Event('input',{bubbles:true}));closeDialog();notify('模板已放入草稿，请检查并编辑后发送');
}

$('#createProject').onclick=()=>openProjectEditor();
$('#newProjectMain').onclick=()=>openProjectEditor();
$('#navChats').onclick=()=>{if(!guardNavigation())return;projectFilter='all';setWorkspaceView('chats');renderProjects();};
$('#navProjects').onclick=()=>setWorkspaceView('projects');
$('#navBookmarks').onclick=()=>setWorkspaceView('bookmarks');
$('#showArchivedProjects').onchange=()=>loadProjects().catch(error=>notify(error.message));
$('#projectSearch').oninput=()=>{if(workspaceMode!=='projects')loadProjects().catch(error=>notify(error.message));};
$('#projectPageSearch').oninput=()=>{if(workspaceMode==='projects')loadProjects().catch(error=>notify(error.message));};
$('#bookmarkPageSearch').oninput=()=>loadBookmarks().catch(error=>notify(error.message));
$('#openTemplates').onclick=openTemplates;
$('#projectContext').onclick=()=>{if(activeChat)openProjectAssignment();else selectProjectFilter('none').catch(e=>notify(e.message));};
$('#moveChat').onclick=openProjectAssignment;

loadProjects().catch(error=>notify(error.message));
