/* Templates and saved answers. Project space is intentionally disabled. */
let workspaceMode = 'chats';
let bookmarkCache = [], templateCache = [], publicTemplateCache = [], exampleCache = [];
let dialogOpener = null;
const workspaceDialog = $('#workspaceDialog');
const dialogBody = $('#dialogBody');
const templateApi = '/api/templates';
const canManagePublicTemplates = $('.shell').dataset.isAdmin === '1';
function setWorkspaceView(view) {
  if(!['chats','bookmarks'].includes(view)||busy||uploading||loading)return;
  workspaceMode=view;
  for(const button of document.querySelectorAll('.workspace-nav-item'))button.classList.toggle('active',button.dataset.view===view);
  $('#chatList').hidden=view!=='chats';$('#chatMenu').hidden=view!=='chats';
  document.querySelector('.history-heading').hidden=view!=='chats';$('#chatArchiveFilter').hidden=view!=='chats';
  $('#workspaceMain').hidden=view==='chats';$('#bookmarksPage').hidden=view!=='bookmarks';
  $('#conversation').hidden=view!=='chats';$('#composer').hidden=view!=='chats';
  $('#jumpLatest').hidden=view!=='chats'||followLatest;$('.model-control').hidden=view!=='chats';
  $('.page-title').textContent=view==='bookmarks'?'收藏与笔记':currentChat?.title||'新对话';
  closeSidebar();
  (view==='bookmarks'?loadBookmarks():refreshChats()).catch(error=>notify(error.message));
}
function openDialog(title, eyebrow, html, opener = document.activeElement) {
  if(!workspaceDialog.open && !dialogOpener?.isConnected)dialogOpener = opener;
  $('#chatMenu').open=false;
  workspaceDialog.classList.toggle('template-manager',title==='提示模板');
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

async function loadBookmarks() {
  bookmarkCache = await api(`/api/bookmarks?q=${encodeURIComponent($('#bookmarkPageSearch').value)}`);
  $('#bookmarkCount').textContent = bookmarkCache.length ? String(bookmarkCache.length) : '';
  renderBookmarks();
}
function addBookmarkAction(article, bookmarkId) {
  const actions=article.querySelector('.message-actions'); if(!actions)return;
  let followup=actions.querySelector('.template-followup');
  if(!followup){followup=action('选模板',()=>{if(!busy)openTemplates();});followup.className='template-followup';actions.append(followup);}
  followup.hidden=!article.dataset.messageId;followup.disabled=!article.dataset.messageId||busy;
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
    setWorkspaceView('chats');await openChat(chat);
    const article=[...messagesEl.querySelectorAll('.message')].find(item=>item.dataset.messageId===String(bookmark.message_id));
    if(article){article.scrollIntoView({behavior:'smooth',block:'center'});article.classList.add('bookmark-highlight');setTimeout(()=>article.classList.remove('bookmark-highlight'),1800);}
  }catch(error){notify(error.message);}
}

async function openTemplates() {
  if(busy||uploading||loading){notify('请先等待当前操作完成。');return;}
  try{[templateCache,publicTemplateCache,exampleCache]=await Promise.all([api('/api/templates'),api('/api/public-templates'),api('/api/template-examples')]);renderTemplateManager();}
  catch(error){notify(error.message);}
}
function renderTemplateManager() {
  openDialog('提示模板','选择后填入输入框',`<div class="template-toolbar"><label class="search-box"><input id="templateSearch" type="search" placeholder="搜索全部模板" aria-label="搜索全部模板"></label><button id="newTemplate" class="primary" type="button">＋ 新建个人模板</button>${canManagePublicTemplates?'<a href="/admin/templates" class="secondary" target="_blank" rel="noopener">管理公共模板</a>':''}</div><div class="template-columns"><section><h3>公共模板</h3><div id="publicTemplates" class="template-list"></div></section><section><h3>我的模板</h3><div id="myTemplates" class="template-list"></div></section><section><h3>示例</h3><div id="exampleTemplates" class="template-list"></div></section></div>`);
  function renderLists(){
    const query=$('#templateSearch').value.trim().toLocaleLowerCase();
    for(const [selector,items,kind,empty] of [['#publicTemplates',publicTemplateCache,'public','管理员尚未添加公共模板'],['#myTemplates',templateCache,'private','还没有个人模板'],['#exampleTemplates',exampleCache,'example','没有示例']]){
      const target=$(selector);target.replaceChildren();
      const matching=items.filter(item=>`${item.name} ${item.content}`.toLocaleLowerCase().includes(query));
      for(const item of matching)target.append(templateCard(item,kind));
      if(!matching.length){const message=document.createElement('p');message.className='empty-history';message.textContent=query?'没有匹配的模板':empty;target.append(message);}
    }
  }
  renderLists();$('#templateSearch').oninput=renderLists;$('#newTemplate').onclick=()=>editTemplate();
}
function templateCard(item, kind) {
  const card=document.createElement('article');card.className='template-card';
  const title=document.createElement('h4');title.textContent=item.name;
  const preview=document.createElement('p');preview.textContent=item.content;preview.className='template-preview';
  const actions=document.createElement('div');actions.className='template-card-actions';
  if(kind!=='example'){const use=action('插入草稿',()=>previewTemplate(item));use.className='small-button';actions.append(use);}
  if(kind!=='private'){const copy=action('复制为个人模板',()=>editTemplate({name:item.name,content:item.content}));copy.className='quiet-icon';actions.append(copy);}
  else{const edit=action('编辑',()=>editTemplate(item));edit.className='quiet-icon';const remove=action('删除',()=>deleteTemplate(item));remove.className='quiet-icon danger-text';actions.append(edit,remove);}
  card.append(title,preview,actions);return card;
}
function editTemplate(item=null) {
  const editing=!!item?.id;
  openDialog(editing?'编辑个人模板':item?'复制为个人模板':'新建个人模板','仅自己可见',`<form id="templateForm" class="workspace-form"><label>模板名称<input name="name" maxlength="80" required value="${item?esc(item.name):''}"></label><label>模板正文<textarea name="content" rows="9" maxlength="20000" required>${item?esc(item.content):''}</textarea></label><div class="form-actions"><button class="primary" type="submit">保存个人模板</button><button class="secondary" type="button" data-dialog-close>取消</button></div></form>`);
  dialogBody.querySelector('[data-dialog-close]').onclick=closeDialog;
  $('#templateForm').onsubmit=async event=>{event.preventDefault();const button=event.submitter;button.disabled=true;const data=new FormData(event.currentTarget);try{await api(editing?`${templateApi}/${item.id}`:templateApi,{method:editing?'PATCH':'POST',body:JSON.stringify({name:String(data.get('name')).trim(),content:String(data.get('content'))})});await openTemplates();notify('个人模板已保存');}catch(error){notify(error.message);}finally{button.disabled=false;}};
}
function deleteTemplate(item) {
  openDialog('删除个人模板？','请确认',`<p class="dialog-copy">删除“${esc(item.name)}”后无法恢复。</p><div class="form-actions"><button id="confirmDeleteTemplate" class="danger-button" type="button">删除模板</button><button class="secondary" type="button" data-dialog-close>取消</button></div>`);
  dialogBody.querySelector('[data-dialog-close]').onclick=closeDialog;
  $('#confirmDeleteTemplate').onclick=async()=>{try{await api(`${templateApi}/${item.id}`,{method:'DELETE'});await openTemplates();notify('个人模板已删除');}catch(error){notify(error.message);}};
}
function previewTemplate(item) {
  openDialog('预览模板','填入输入框后可继续编辑',`<div class="template-preview-full"><h3>${esc(item.name)}</h3><pre>${esc(item.content)}</pre></div><div class="form-actions"><button id="insertAppend" class="primary" type="button">${inputEl.value.trim()?'追加到草稿':'插入草稿'}</button>${inputEl.value.trim()?'<button id="insertReplace" class="secondary" type="button">替换现有草稿</button>':''}<button class="secondary" type="button" data-dialog-close>取消</button></div>`);
  $('#insertAppend').onclick=()=>insertTemplate(item.content,false);$('#insertReplace')?.addEventListener('click',()=>insertTemplate(item.content,true));dialogBody.querySelector('[data-dialog-close]').onclick=closeDialog;
}
function insertTemplate(content, replace) {
  const next=replace||!inputEl.value.trim()?content:`${inputEl.value.trimEnd()}\n\n${content}`;
  if(next.length>20000){notify('插入后超过 20,000 字限制，请精简模板或草稿。');return;}
  inputEl.value=next;resizeInput();inputEl.dispatchEvent(new Event('input',{bubbles:true}));closeDialog();inputEl.focus();inputEl.setSelectionRange(next.length,next.length);notify('模板已填入输入框，可继续编辑后发送');
}
$('#navChats').onclick=()=>setWorkspaceView('chats');$('#navBookmarks').onclick=()=>setWorkspaceView('bookmarks');
$('#bookmarkPageSearch').oninput=()=>loadBookmarks().catch(error=>notify(error.message));$('#openTemplates').onclick=openTemplates;
