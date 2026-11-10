import './style.css';
import '@xterm/xterm/css/xterm.css';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Connect, SendInput, Resize, Disconnect, LoadStore, SaveStore, PickKeyFile, HomeDir, ListDir, EditFile, MakeDir, MakeFile, Remove, Version, CheckUpdate, OpenURL, ExportStore, ImportStore, DownloadFileTo, DownloadDirTo, UploadFileTo, ExtractArchive } from '../wailsjs/go/main/App';
import { EventsOn, ClipboardSetText, ClipboardGetText } from '../wailsjs/runtime/runtime';
import { LANGS, t, setLang, getLang, detectLang, applyStaticI18n } from './i18n';

/* ===================== État ===================== */
let store = { folders: [], connections: [], keys: [], language: '' };
let sessions = [];          // [{id, label, term, fit, pane, connId, closed}]
let activeSid = null;
let editingConnId = null;
let selectedConnId = null;
let draggedConnId = null;
let draggedFolderId = null;
let draggedSid = null;
let filterText = '';
let editingKeyId = null;     // clé SSH en cours de modification (null = ajout)
let appVersion = 'dev';    // remplacé par Version() au démarrage (injectée au build)

function uid() {
  return (crypto.randomUUID ? crypto.randomUUID() : 's' + Date.now() + Math.random().toString(16).slice(2));
}
function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstChild;
}
function persist() { SaveStore(store).catch((e) => console.error('save', e)); }
async function loadStore() {
  try {
    const s = await LoadStore();
    store = { folders: s.folders || [], connections: s.connections || [], keys: s.keys || [], language: s.language || '' };
  } catch (e) { console.error('load', e); }
}

/* ===================== Icônes ===================== */
const HOST_ICON = `<svg class="item__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="6" rx="1.2"/><rect x="3" y="14" width="18" height="6" rx="1.2"/><line x1="7" y1="7" x2="7.01" y2="7"/><line x1="7" y1="17" x2="7.01" y2="17"/></svg>`;
const FOLDER_ICON = `<svg class="folder__icon" viewBox="0 0 24 24" fill="currentColor"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>`;
const CHEVRON = `<svg class="folder__chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="8 10 12 14 16 10"/></svg>`;

/* ===================== Arbre des connexions ===================== */
const connTree = document.getElementById('conn-tree');

function matches(conn) {
  if (!filterText) return true;
  const f = filterText.toLowerCase();
  return (conn.name || '').toLowerCase().includes(f) || (conn.host || '').toLowerCase().includes(f);
}

function connectionRow(conn) {
  const row = el(`<div class="item" draggable="true">
    <span class="item__status"></span>
    ${HOST_ICON}
    <span class="item__name"></span>
    <span class="item__actions">
      <button class="row-btn" data-act="edit" title="Modifier">✎</button>
      <button class="row-btn" data-act="del" title="Supprimer">🗑</button>
    </span>
  </div>`);
  row.querySelector('.item__name').textContent = conn.name || conn.host;
  if (conn.id === selectedConnId) row.classList.add('item--active');

  // simple clic = sélection ; double clic = connexion (nouvel onglet)
  row.addEventListener('click', (e) => {
    if (e.target.closest('.row-btn')) return;
    selectedConnId = conn.id;
    renderTree();
  });
  row.addEventListener('dblclick', (e) => {
    if (e.target.closest('.row-btn')) return;
    openFromConnection(conn);
  });
  row.querySelector('[data-act="edit"]').addEventListener('click', () => openConnModal(conn));
  row.querySelector('[data-act="del"]').addEventListener('click', () => deleteConnection(conn));

  // Glisser-déposer (le setData est indispensable pour que le drag démarre)
  row.addEventListener('dragstart', (e) => {
    draggedConnId = conn.id;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', conn.id);
    row.classList.add('dragging');
  });
  row.addEventListener('dragend', () => row.classList.remove('dragging'));
  row.addEventListener('dragover', (e) => { e.preventDefault(); row.classList.add('drop-before'); });
  row.addEventListener('dragleave', () => row.classList.remove('drop-before'));
  row.addEventListener('drop', (e) => {
    e.preventDefault(); e.stopPropagation(); row.classList.remove('drop-before');
    dropOnConnection(conn);
  });
  return row;
}

function renderTree() {
  connTree.innerHTML = '';

  const rootZone = el(`<div class="root-zone"></div>`);
  store.connections.filter((c) => !c.folderId && matches(c)).forEach((c) => rootZone.appendChild(connectionRow(c)));
  rootZone.addEventListener('dragover', (e) => e.preventDefault());
  rootZone.addEventListener('drop', (e) => { e.preventDefault(); dropOnFolder(''); });
  connTree.appendChild(rootZone);

  store.folders.forEach((folder) => {
    const group = el(`<div class="group"></div>`);
    const header = el(`<div class="folder folder--open" draggable="true">
      ${CHEVRON}${FOLDER_ICON}
      <span class="folder__name"></span>
      <span class="folder__count"></span>
      <button class="row-btn folder-del" title="Supprimer le dossier">🗑</button>
    </div>`);
    header.querySelector('.folder__name').textContent = folder.name;
    const kids = store.connections.filter((c) => c.folderId === folder.id);
    header.querySelector('.folder__count').textContent = kids.length;

    header.addEventListener('click', (e) => {
      if (e.target.closest('.folder-del')) return;
      group.classList.toggle('collapsed');
      header.classList.toggle('folder--open');
    });
    header.querySelector('.folder-del').addEventListener('click', () => deleteFolder(folder));

    // Le dossier est déplaçable (réordonner) ET réceptacle (y déposer une connexion).
    header.addEventListener('dragstart', (e) => {
      e.stopPropagation();
      draggedFolderId = folder.id;
      draggedConnId = null;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', 'folder:' + folder.id);
      header.classList.add('dragging');
    });
    header.addEventListener('dragend', () => header.classList.remove('dragging'));
    header.addEventListener('dragover', (e) => {
      e.preventDefault();
      header.classList.add(draggedFolderId ? 'drop-before' : 'drop-into');
    });
    header.addEventListener('dragleave', () => header.classList.remove('drop-into', 'drop-before'));
    header.addEventListener('drop', (e) => {
      e.preventDefault(); e.stopPropagation();
      header.classList.remove('drop-into', 'drop-before');
      if (draggedFolderId) reorderFolders(folder.id);
      else dropOnFolder(folder.id);
    });
    group.appendChild(header);

    const childrenWrap = el(`<div class="children"></div>`);
    childrenWrap.addEventListener('dragover', (e) => e.preventDefault());
    childrenWrap.addEventListener('drop', (e) => { e.preventDefault(); e.stopPropagation(); dropOnFolder(folder.id); });
    kids.filter(matches).forEach((c) => childrenWrap.appendChild(connectionRow(c)));
    group.appendChild(childrenWrap);
    connTree.appendChild(group);
  });

  if (store.connections.length === 0 && store.folders.length === 0) {
    connTree.appendChild(el(`<div class="tree__empty">${t('tree.empty.connsHtml')}</div>`));
  }
}

/* ===================== Glisser-déposer connexions ===================== */
function dropOnFolder(folderId) {
  const c = store.connections.find((x) => x.id === draggedConnId);
  if (c) { c.folderId = folderId; persist(); renderTree(); }
  draggedConnId = null;
}
function dropOnConnection(target) {
  if (!draggedConnId || draggedConnId === target.id) { draggedConnId = null; return; }
  const arr = store.connections;
  const from = arr.findIndex((x) => x.id === draggedConnId);
  if (from < 0) { draggedConnId = null; return; }
  const moved = arr.splice(from, 1)[0];
  moved.folderId = target.folderId || '';
  const to = arr.findIndex((x) => x.id === target.id);
  arr.splice(to, 0, moved);
  persist(); renderTree(); draggedConnId = null;
}
function reorderFolders(targetId) {
  if (!draggedFolderId || draggedFolderId === targetId) { draggedFolderId = null; return; }
  const from = store.folders.findIndex((f) => f.id === draggedFolderId);
  if (from < 0) { draggedFolderId = null; return; }
  const moved = store.folders.splice(from, 1)[0];
  const to = store.folders.findIndex((f) => f.id === targetId);
  store.folders.splice(to, 0, moved);
  draggedFolderId = null;
  persist(); renderTree();
}

/* ===================== Petites fenêtres génériques ===================== */
function askText(title, labelText, initial = '') {
  return new Promise((resolve) => {
    const modal = document.getElementById('text-modal');
    document.getElementById('text-modal-title').textContent = title;
    document.getElementById('text-modal-label').childNodes[0].textContent = labelText;
    const input = document.getElementById('text-modal-input');
    input.value = initial;
    modal.style.display = 'flex';
    input.focus();
    const done = (val) => {
      modal.style.display = 'none';
      ok.onclick = cancel.onclick = close.onclick = null;
      input.onkeydown = null;
      resolve(val);
    };
    const ok = document.getElementById('text-modal-ok');
    const cancel = document.getElementById('text-modal-cancel');
    const close = document.getElementById('text-modal-close');
    ok.onclick = () => done(input.value.trim() || null);
    cancel.onclick = close.onclick = () => done(null);
    input.onkeydown = (e) => { if (e.key === 'Enter') done(input.value.trim() || null); if (e.key === 'Escape') done(null); };
  });
}
function askConfirm(message) {
  return new Promise((resolve) => {
    const modal = document.getElementById('confirm-modal');
    document.getElementById('confirm-modal-text').textContent = message;
    modal.style.display = 'flex';
    const done = (val) => { modal.style.display = 'none'; yes.onclick = no.onclick = null; resolve(val); };
    const yes = document.getElementById('confirm-modal-yes');
    const no = document.getElementById('confirm-modal-no');
    yes.onclick = () => done(true);
    no.onclick = () => done(false);
  });
}
function toast(message, kind = 'info') {
  let t = document.getElementById('toast');
  if (!t) { t = el(`<div id="toast" class="toast"></div>`); document.body.appendChild(t); }
  t.textContent = message;
  t.className = 'toast toast--' + kind + ' toast--show';
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('toast--show'), 4000);
}

/* ===================== Dossiers ===================== */
async function addFolder() {
  const name = await askText(t('btn.newFolder'), t('dlg.folderName'));
  if (!name) return;
  store.folders.push({ id: uid(), name });
  persist(); renderTree();
}
async function deleteFolder(folder) {
  const ok = await askConfirm(t('confirm.deleteFolder', { name: folder.name }));
  if (!ok) return;
  store.folders = store.folders.filter((f) => f.id !== folder.id);
  store.connections.forEach((c) => { if (c.folderId === folder.id) c.folderId = ''; });
  persist(); renderTree();
}

/* ===================== Connexions (CRUD) ===================== */
async function deleteConnection(conn) {
  const ok = await askConfirm(t('confirm.deleteConn', { name: conn.name || conn.host }));
  if (!ok) return;
  store.connections = store.connections.filter((c) => c.id !== conn.id);
  persist(); renderTree();
}

const connModal = document.getElementById('conn-modal');
const connError = document.getElementById('conn-error');

function populateFolderSelect(selected) {
  const sel = document.getElementById('f-folder');
  sel.innerHTML = `<option value="">${t('folder.none')}</option>`;
  store.folders.forEach((f) => {
    const o = document.createElement('option');
    o.value = f.id; o.textContent = f.name;
    if (f.id === selected) o.selected = true;
    sel.appendChild(o);
  });
}
function populateKeySelect(selected) {
  const sel = document.getElementById('f-keyid');
  sel.innerHTML = '';
  if (store.keys.length === 0) { sel.innerHTML = `<option value="">${t('key.selectNone')}</option>`; return; }
  store.keys.forEach((k) => {
    const o = document.createElement('option');
    o.value = k.id; o.textContent = k.name;
    if (k.id === selected) o.selected = true;
    sel.appendChild(o);
  });
}
function setAuthTab(which) {
  document.querySelectorAll('#conn-modal .auth-tab').forEach((b) => b.classList.toggle('auth-tab--active', b.dataset.auth === which));
  document.getElementById('auth-password').style.display = which === 'password' ? 'block' : 'none';
  document.getElementById('auth-key').style.display = which === 'key' ? 'block' : 'none';
}
function openConnModal(conn = null) {
  editingConnId = conn ? conn.id : null;
  document.getElementById('conn-modal-title').textContent = conn ? t('conn.edit') : t('btn.newConn');
  document.getElementById('f-name').value = conn ? (conn.name || '') : '';
  document.getElementById('f-host').value = conn ? conn.host : '';
  document.getElementById('f-port').value = conn ? (conn.port || 22) : 22;
  document.getElementById('f-user').value = conn ? conn.user : '';
  document.getElementById('f-password').value = conn && conn.authType === 'password' ? (conn.password || '') : '';
  populateFolderSelect(conn ? conn.folderId : '');
  populateKeySelect(conn ? conn.keyId : '');
  setAuthTab(conn && conn.authType === 'key' ? 'key' : 'password');
  connError.style.display = 'none';
  connModal.style.display = 'flex';
  document.getElementById('f-name').focus();
}
function closeConnModal() { connModal.style.display = 'none'; }

function readConnForm() {
  const authType = document.querySelector('#conn-modal .auth-tab--active').dataset.auth;
  const name = document.getElementById('f-name').value.trim();
  const host = document.getElementById('f-host').value.trim();
  const user = document.getElementById('f-user').value.trim();
  const fail = (msg) => { connError.textContent = msg; connError.style.display = 'block'; return null; };
  if (!name) return fail(t('err.nameRequired'));
  if (!host || !user) return fail(t('err.hostUserRequired'));
  if (authType === 'key' && store.keys.length === 0) return fail(t('err.noKeys'));
  return {
    id: editingConnId || uid(),
    name,
    folderId: document.getElementById('f-folder').value,
    host,
    port: parseInt(document.getElementById('f-port').value, 10) || 22,
    user,
    authType,
    password: authType === 'password' ? document.getElementById('f-password').value : '',
    keyId: authType === 'key' ? document.getElementById('f-keyid').value : '',
  };
}
function saveConn(conn) {
  const i = store.connections.findIndex((c) => c.id === conn.id);
  if (i >= 0) store.connections[i] = conn; else store.connections.push(conn);
  persist(); renderTree();
}

/* ===================== Sessions / onglets ===================== */
function optsFromConnection(conn) {
  const o = { host: conn.host, port: conn.port || 22, user: conn.user, password: '', keyPath: '', passphrase: '' };
  if (conn.authType === 'password') o.password = conn.password || '';
  else if (conn.authType === 'key') {
    const k = store.keys.find((x) => x.id === conn.keyId);
    if (k) { o.keyPath = k.path; o.passphrase = k.passphrase || ''; }
  }
  return o;
}

function makeTerminal(sid, pane) {
  const t = new Terminal({
    fontFamily: 'JetBrains Mono, Fira Code, Cascadia Code, monospace',
    fontSize: 13,
    cursorBlink: true,
    theme: { background: '#0b0f14', foreground: '#c9d4e0', cursor: '#4aa3df' },
  });
  const f = new FitAddon();
  t.loadAddon(f);
  t.open(pane);

  // Copier (Ctrl+Maj+C) / Coller (Ctrl+Maj+V, via term.paste → bracketed paste).
  t.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown' || !e.ctrlKey || !e.shiftKey) return true;
    if (e.code === 'KeyC') { e.preventDefault(); const s = t.getSelection(); if (s) ClipboardSetText(s); return false; }
    // preventDefault() indispensable : sans lui, webkit déclenche AUSSI un collage
    // natif en plus de notre t.paste() → le texte était collé en double.
    if (e.code === 'KeyV') { e.preventDefault(); ClipboardGetText().then((x) => { if (x) t.paste(x); }); return false; }
    return true;
  });
  t.onData((d) => SendInput(sid, d));
  return { term: t, fit: f };
}

async function createSession(opts, label, connId) {
  const id = await Connect(opts);
  const pane = el(`<div class="term-pane" data-sid="${id}"></div>`);
  document.getElementById('term-stack').appendChild(pane);
  const { term: t, fit: f } = makeTerminal(id, pane);
  sessions.push({ id, label: label || opts.host, host: opts.host, term: t, fit: f, pane, connId, closed: false, cwd: opts.initialDir || null });
  document.getElementById('welcome').style.display = 'none';
  renderTabs();
  activateSession(id);
}
async function startNewTab(opts, label, connId) {
  const loader = document.getElementById('loader');
  loader.style.display = 'flex';
  try { await createSession(opts, label, connId); }
  catch (e) { toast(t('toast.connFailed', { err: String(e) }), 'error'); }
  finally { loader.style.display = 'none'; }
}
function openFromConnection(conn) {
  return startNewTab(optsFromConnection(conn), conn.name || conn.host, conn.id);
}
// "Ouvrir un terminal ici" : nouvel onglet (nouvelle session SSH) démarré dans ce dossier.
// On NE touche PAS au terminal courant (qui peut être en nano, crontab -e, etc.).
function openTerminalHere(s, dir) {
  const conn = store.connections.find((c) => c.id === s.connId);
  if (!conn) { toast(t('toast.connNotFound'), 'error'); return; }
  const opts = optsFromConnection(conn);
  opts.initialDir = dir;
  startNewTab(opts, conn.name || conn.host, conn.id);
}

function activateSession(id) {
  activeSid = id;
  sessions.forEach((s) => { s.pane.style.display = s.id === id ? 'block' : 'none'; });
  renderTabs();
  const s = sessions.find((x) => x.id === id);
  if (s) {
    s.fit.fit(); Resize(id, s.term.cols, s.term.rows); s.term.focus();
    setStatus(t('status.connectedTo', { host: s.host }));
    refreshFiles();
  }
}
function setStatus(text) {
  const m = document.querySelector('.statusbar__item--muted');
  if (m) m.textContent = 'Drossh v' + appVersion + ' · ' + text;
}

async function closeTab(id) {
  const idx = sessions.findIndex((s) => s.id === id);
  if (idx < 0) return;
  const s = sessions[idx];
  try { await Disconnect(id); } catch (_) {}
  s.term.dispose();
  s.pane.remove();
  sessions.splice(idx, 1);
  if (activeSid === id) {
    const next = sessions[idx] || sessions[idx - 1] || null;
    if (next) activateSession(next.id);
    else { activeSid = null; document.getElementById('welcome').style.display = ''; setStatus(t('status.noSession')); renderTabs(); refreshFiles(); }
  } else {
    renderTabs();
  }
}

function renderTabs() {
  const list = document.getElementById('tabs-list');
  list.innerHTML = '';
  sessions.forEach((s) => {
    const tab = el(`<div class="tab" draggable="true">
      <span class="tab__dot ${s.closed ? 'tab__dot--closed' : ''}"></span>
      <span class="tab__label"></span>
      <span class="tab__close" title="Fermer">×</span>
    </div>`);
    tab.querySelector('.tab__label').textContent = s.label;
    if (s.id === activeSid) tab.classList.add('tab--active');

    tab.addEventListener('click', (e) => { if (e.target.closest('.tab__close')) return; activateSession(s.id); });
    tab.querySelector('.tab__close').addEventListener('click', () => closeTab(s.id));

    tab.addEventListener('dragstart', (e) => {
      draggedSid = s.id;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', s.id);
      tab.classList.add('dragging');
    });
    tab.addEventListener('dragend', () => tab.classList.remove('dragging'));
    tab.addEventListener('dragover', (e) => { e.preventDefault(); tab.classList.add('tab--dropbefore'); });
    tab.addEventListener('dragleave', () => tab.classList.remove('tab--dropbefore'));
    tab.addEventListener('drop', (e) => { e.preventDefault(); tab.classList.remove('tab--dropbefore'); reorderTabs(s.id); });

    list.appendChild(tab);
  });
}
function reorderTabs(targetSid) {
  if (!draggedSid || draggedSid === targetSid) { draggedSid = null; return; }
  const from = sessions.findIndex((s) => s.id === draggedSid);
  const moved = sessions.splice(from, 1)[0];
  const to = sessions.findIndex((s) => s.id === targetSid);
  sessions.splice(to, 0, moved);
  draggedSid = null;
  renderTabs();
}

/* ===================== Flux venant du serveur ===================== */
EventsOn('term:data', (p) => {
  const s = sessions.find((x) => x.id === p.id);
  if (!s) return;
  s.term.write(Uint8Array.from(atob(p.b64), (c) => c.charCodeAt(0)));
});
EventsOn('term:exit', (id) => {
  const s = sessions.find((x) => x.id === id);
  if (!s) return;
  s.closed = true;
  s.term.write('\r\n\x1b[31m*** Session fermée ***\x1b[0m\r\n');
  renderTabs();
});
window.addEventListener('resize', () => {
  const s = sessions.find((x) => x.id === activeSid);
  if (s) { s.fit.fit(); Resize(s.id, s.term.cols, s.term.rows); }
});

// Édition de fichiers (retours du moteur Go)
EventsOn('file:editing', (p) => toast(t('toast.editOpened', { name: p.split('/').pop() }), 'info'));
EventsOn('file:uploaded', (p) => toast(t('toast.saved', { name: p.split('/').pop() }), 'ok'));
EventsOn('file:error', (o) => toast(t('toast.uploadFail', { err: (o && o.error ? o.error : '') }), 'error'));

/* ===================== Gestionnaire de clés ===================== */
const keyModal = document.getElementById('key-modal');
const keyError = document.getElementById('key-error');

function renderKeyList() {
  const list = document.getElementById('key-list');
  list.innerHTML = '';
  if (store.keys.length === 0) { list.appendChild(el(`<div class="tree__empty" style="padding:14px">${t('key.none')}</div>`)); return; }
  store.keys.forEach((k) => {
    const row = el(`<div class="key-row${k.id === editingKeyId ? ' key-row--editing' : ''}">
      <div class="key-row__info"><div class="key-row__name"></div><div class="key-row__path"></div></div>
      <div class="key-row__actions">
        <button class="row-btn" data-act="edit" title="${t('btn.edit')}">✎</button>
        <button class="row-btn" data-act="del" title="${t('btn.delete')}">🗑</button>
      </div>
    </div>`);
    row.querySelector('.key-row__name').textContent = k.name;
    row.querySelector('.key-row__path').textContent = k.path + (k.passphrase ? '  🔒' : '');
    row.querySelector('[data-act="edit"]').addEventListener('click', () => startEditKey(k));
    row.querySelector('[data-act="del"]').addEventListener('click', async () => {
      const ok = await askConfirm(t('confirm.deleteKey', { name: k.name }));
      if (!ok) return;
      store.keys = store.keys.filter((x) => x.id !== k.id);
      if (editingKeyId === k.id) resetKeyForm();
      persist(); renderKeyList();
    });
    list.appendChild(row);
  });
}
function resetKeyForm() {
  editingKeyId = null;
  document.getElementById('k-name').value = '';
  document.getElementById('k-path').value = '';
  document.getElementById('k-passphrase').value = '';
  document.getElementById('key-add-title').textContent = t('key.add.title');
  document.getElementById('key-add-btn').textContent = t('key.add.btn');
  keyError.style.display = 'none';
}
function startEditKey(k) {
  editingKeyId = k.id;
  document.getElementById('k-name').value = k.name;
  document.getElementById('k-path').value = k.path;
  document.getElementById('k-passphrase').value = k.passphrase || '';
  document.getElementById('key-add-title').textContent = t('key.edit.title');
  document.getElementById('key-add-btn').textContent = t('key.edit.btn');
  keyError.style.display = 'none';
  renderKeyList();
  document.getElementById('k-name').focus();
}
function openKeyModal() {
  resetKeyForm();
  renderKeyList();
  keyModal.style.display = 'flex';
}
function addKey() {
  const name = document.getElementById('k-name').value.trim();
  const path = document.getElementById('k-path').value.trim();
  const passphrase = document.getElementById('k-passphrase').value;
  if (!name || !path) { keyError.textContent = t('err.keyNameRequired'); keyError.style.display = 'block'; return; }
  if (editingKeyId) {
    const k = store.keys.find((x) => x.id === editingKeyId);
    if (k) { k.name = name; k.path = path; k.passphrase = passphrase; }
  } else {
    store.keys.push({ id: uid(), name, path, passphrase });
  }
  persist();
  resetKeyForm();
  renderKeyList();
}

/* ===================== Boutons ===================== */
document.getElementById('quick-connect-btn').addEventListener('click', () => openConnModal());
document.getElementById('new-conn-btn').addEventListener('click', () => openConnModal());
document.getElementById('new-tab-btn').addEventListener('click', () => openConnModal());
document.getElementById('new-folder-btn').addEventListener('click', addFolder);

document.getElementById('conn-modal-close').addEventListener('click', closeConnModal);
document.getElementById('conn-cancel').addEventListener('click', closeConnModal);
document.querySelectorAll('#conn-modal .auth-tab').forEach((b) => b.addEventListener('click', () => setAuthTab(b.dataset.auth)));
document.getElementById('conn-save').addEventListener('click', () => {
  const conn = readConnForm(); if (!conn) return;
  saveConn(conn); closeConnModal();
});
document.getElementById('conn-save-connect').addEventListener('click', () => {
  const conn = readConnForm(); if (!conn) return;
  saveConn(conn); closeConnModal();
  openFromConnection(conn);
});

document.getElementById('manage-keys-btn').addEventListener('click', openKeyModal);
document.getElementById('keys-btn').addEventListener('click', openKeyModal);
document.getElementById('key-add-btn').addEventListener('click', addKey);
document.getElementById('k-browse').addEventListener('click', async () => {
  try { const p = await PickKeyFile(); if (p) document.getElementById('k-path').value = p; }
  catch (e) { console.error(e); }
});
const closeKeyModal = () => { keyModal.style.display = 'none'; populateKeySelect(document.getElementById('f-keyid').value); };
document.getElementById('key-modal-close').addEventListener('click', closeKeyModal);
document.getElementById('key-modal-done').addEventListener('click', closeKeyModal);

document.getElementById('conn-filter').addEventListener('input', (e) => { filterText = e.target.value.trim(); renderTree(); });

/* ===================== Réglages : langue + export/import + mises à jour ===================== */
document.getElementById('settings-btn').addEventListener('click', openSettingsMenu);

function openSettingsMenu() {
  const r = document.getElementById('settings-btn').getBoundingClientRect();
  showMenu(r.left, r.bottom + 4, [
    { label: t('menu.language') + '  ▸', onClick: openLanguageMenu },
    { sep: true },
    { label: t('menu.export'), onClick: exportConfig },
    { label: t('menu.import'), onClick: importConfig },
    { sep: true },
    { label: t('menu.checkUpdate'), onClick: () => doCheckUpdate(true) },
  ]);
}
function openLanguageMenu() {
  const cur = getLang();
  const r = document.getElementById('settings-btn').getBoundingClientRect();
  showMenu(r.left, r.bottom + 4, LANGS.map((l) => ({
    label: (l.code === cur ? '✓ ' : ' ') + l.name,
    onClick: () => setLanguage(l.code),
  })));
}
function setLanguage(code) {
  setLang(code);
  store.language = code;
  persist();
  applyI18n();
}
// applyI18n : ré-applique les traductions partout (statique + parties dynamiques).
function applyI18n() {
  applyStaticI18n();
  renderTree();
  renderTabs();
  if (keyModal.style.display === 'flex') renderKeyList();
  const s = sessions.find((x) => x.id === activeSid);
  if (s) setStatus(t('status.connectedTo', { host: s.host }));
  else {
    const m = document.querySelector('.statusbar__item--muted');
    if (m) m.textContent = 'Drossh v' + appVersion + ' · ' + t('status.noSession');
  }
  refreshFiles();
}

async function exportConfig() {
  try {
    const path = await ExportStore();
    if (path) toast(t('toast.exported', { path }), 'ok');
  } catch (e) { toast(t('toast.exportFail', { err: String(e) }), 'error'); }
}
async function importConfig() {
  const ok = await askConfirm(t('confirm.import'));
  if (!ok) return;
  try {
    const s = await ImportStore();
    if (!s) return; // annulé dans le sélecteur de fichier
    store = { folders: s.folders || [], connections: s.connections || [], keys: s.keys || [], language: s.language || store.language };
    selectedConnId = null;
    if (store.language) setLang(store.language); // la langue importée prend le dessus
    applyI18n();
    toast(t('toast.imported'), 'ok');
  } catch (e) { toast(t('toast.importFail', { err: String(e) }), 'error'); }
}

/* --- Vérificateur de mises à jour --- */
async function doCheckUpdate(manual) {
  try {
    const info = await CheckUpdate();
    if (info.newer) showUpdateBanner(info);
    else if (manual) toast(t('update.uptodate', { v: info.current }), 'ok');
  } catch (e) {
    if (manual) toast(t('update.checkFail', { err: String(e) }), 'error');
  }
}
function showUpdateBanner(info) {
  if (document.getElementById('update-banner')) return;
  const bar = el(`<div id="update-banner" class="update-banner">
    <span class="update-banner__text">${t('update.bannerHtml', { latest: info.latest, current: info.current })}</span>
    <button class="update-banner__btn" type="button">${t('update.download')}</button>
    <button class="update-banner__close" type="button" title="${t('update.later')}">×</button>
  </div>`);
  bar.querySelector('.update-banner__btn').addEventListener('click', () => OpenURL(info.url));
  bar.querySelector('.update-banner__close').addEventListener('click', () => bar.remove());
  document.body.appendChild(bar);
}
async function initVersion() {
  try { appVersion = await Version(); } catch (_) {}
  if (!activeSid) {
    const m = document.querySelector('.statusbar__item--muted');
    if (m) m.textContent = 'Drossh v' + appVersion + ' · ' + t('status.noSession');
  }
}

/* ===================== Explorateur SFTP ===================== */
const filesTree = document.getElementById('files-tree');
const filesPath = document.getElementById('files-path');

const DIR_ICON = `<svg class="file-icon file-icon--dir" viewBox="0 0 24 24" fill="currentColor"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>`;
const UP_ICON = `<svg class="file-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 14 4 9 9 4"/><path d="M4 9h11a4 4 0 0 1 4 4v4"/></svg>`;

/* --- Icônes par type de fichier --- */
const G = {
  doc: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-5z" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M14 3v5h5" fill="none" stroke="currentColor" stroke-width="1.6"/>',
  code: '<polyline points="16 18 22 12 16 6" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/><polyline points="8 6 2 12 8 18" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>',
  braces: '<path d="M8 3a3 3 0 0 0-3 3v2a2 2 0 0 1-2 2 2 2 0 0 1 2 2v2a3 3 0 0 0 3 3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M16 3a3 3 0 0 1 3 3v2a2 2 0 0 0 2 2 2 2 0 0 0-2 2v2a3 3 0 0 1-3 3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
  term: '<rect x="3" y="4" width="18" height="16" rx="2" fill="none" stroke="currentColor" stroke-width="1.6"/><polyline points="7 9 10 12 7 15" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><line x1="12" y1="15" x2="16" y2="15" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
  box: '<path d="M3 8.5l9-5 9 5v7l-9 5-9-5z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M3 8.5l9 5 9-5M12 13.5v7" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>',
  leaf: '<path d="M5 21c0-9 5-14 14-16 0 9-5 16-14 16z" fill="currentColor"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="8.5" cy="9.5" r="1.6" fill="currentColor"/><path d="M21 16l-5-5L5 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>',
  archive: '<rect x="3" y="4" width="18" height="16" rx="2" fill="none" stroke="currentColor" stroke-width="1.6"/><line x1="12" y1="4" x2="12" y2="9" stroke="currentColor" stroke-width="1.6"/><rect x="10.5" y="9" width="3" height="3" rx=".5" fill="currentColor"/>',
  gear: '<circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9 7 7M17 17l2.1 2.1M19.1 4.9 17 7M7 17l-2.1 2.1" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>',
  key: '<circle cx="7.5" cy="15.5" r="3.5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M10 13l9-9M16 4l3 3M14 6l2 2" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
  db: '<ellipse cx="12" cy="6" rx="7" ry="3" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6" fill="none" stroke="currentColor" stroke-width="1.5"/>',
  lock: '<rect x="4" y="10" width="16" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M8 10V7a4 4 0 0 1 8 0v3" fill="none" stroke="currentColor" stroke-width="1.6"/>',
  git: '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="9" cy="9" r="1.5" fill="currentColor"/><circle cx="9" cy="15" r="1.5" fill="currentColor"/><circle cx="15" cy="11" r="1.5" fill="currentColor"/><path d="M9 10.5v3M9.6 14.6c4 0 4.4-2 4.4-2.9" fill="none" stroke="currentColor" stroke-width="1.3"/>',
};
function glyph(inner, color) { return `<svg class="file-icon" style="color:${color}" viewBox="0 0 24 24">${inner}</svg>`; }

function iconFor(name) {
  const lower = name.toLowerCase();
  const ext = lower.includes('.') ? lower.split('.').pop() : '';
  if (lower === 'dockerfile' || lower.startsWith('docker-compose') || lower === '.dockerignore' || lower === 'compose.yaml' || lower === 'compose.yml') return glyph(G.box, '#2496ed');
  if (lower.startsWith('.git')) return glyph(G.git, '#f05133');
  if (lower === '.env' || lower.startsWith('.env.')) return glyph(G.key, '#ecd53f');
  if (lower === 'package.json') return glyph(G.braces, '#cb3837');
  if (lower === 'composer.json' || lower === 'composer.lock') return glyph(G.braces, '#885630');
  const map = {
    php: [G.code, '#8993be'], twig: [G.leaf, '#9acd32'], blade: [G.leaf, '#f55247'],
    js: [G.code, '#f0db4f'], mjs: [G.code, '#f0db4f'], cjs: [G.code, '#f0db4f'], ts: [G.code, '#3178c6'], tsx: [G.code, '#3178c6'], jsx: [G.code, '#61dafb'],
    json: [G.braces, '#f0b429'], html: [G.code, '#e44d26'], htm: [G.code, '#e44d26'], xml: [G.code, '#e44d26'],
    css: [G.code, '#2965f1'], scss: [G.code, '#c6538c'], sass: [G.code, '#c6538c'], less: [G.code, '#2965f1'],
    vue: [G.code, '#42b883'], py: [G.code, '#3572a5'], go: [G.code, '#00add8'], rs: [G.code, '#dea584'],
    rb: [G.code, '#cc342d'], java: [G.code, '#b07219'], c: [G.code, '#888'], h: [G.code, '#888'], cpp: [G.code, '#f34b7d'],
    md: [G.doc, '#42a5f5'], markdown: [G.doc, '#42a5f5'], txt: [G.doc, '#9aa7b4'], log: [G.doc, '#9aa7b4'], pdf: [G.doc, '#e5484d'],
    sh: [G.term, '#4caf50'], bash: [G.term, '#4caf50'], zsh: [G.term, '#4caf50'], fish: [G.term, '#4caf50'],
    yml: [G.gear, '#a0a8b0'], yaml: [G.gear, '#a0a8b0'], toml: [G.gear, '#a0a8b0'], ini: [G.gear, '#a0a8b0'], conf: [G.gear, '#a0a8b0'], cfg: [G.gear, '#a0a8b0'],
    sql: [G.db, '#f29111'], sqlite: [G.db, '#f29111'], db: [G.db, '#f29111'],
    lock: [G.lock, '#9aa7b4'],
    png: [G.image, '#a78bfa'], jpg: [G.image, '#a78bfa'], jpeg: [G.image, '#a78bfa'], gif: [G.image, '#a78bfa'], svg: [G.image, '#ffb13b'], webp: [G.image, '#a78bfa'], ico: [G.image, '#a78bfa'], bmp: [G.image, '#a78bfa'],
    zip: [G.archive, '#f4b942'], tar: [G.archive, '#f4b942'], gz: [G.archive, '#f4b942'], xz: [G.archive, '#f4b942'], bz2: [G.archive, '#f4b942'], '7z': [G.archive, '#f4b942'], rar: [G.archive, '#f4b942'],
  };
  const m = map[ext];
  return m ? glyph(m[0], m[1]) : glyph(G.doc, '#8aa0b5');
}

function humanSize(n) {
  if (n < 1024) return n + ' o';
  const u = ['Ko', 'Mo', 'Go', 'To']; let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return n.toFixed(n < 10 ? 1 : 0) + ' ' + u[i];
}
function parentPath(p) {
  const clean = (p || '/').replace(/\/+$/, '');
  return clean.split('/').slice(0, -1).join('/') || '/';
}

async function refreshFiles() {
  const s = sessions.find((x) => x.id === activeSid);
  if (!s) {
    filesTree.innerHTML = `<div class="tree__empty">${t('files.connectPromptHtml')}</div>`;
    filesPath.textContent = t('files.none');
    filesPath.title = '';
    return;
  }
  try {
    const p = s.cwd || (await HomeDir(s.id));
    await listInto(s, p);
  } catch (e) {
    filesTree.innerHTML = '';
    filesTree.appendChild(el(`<div class="tree__empty">${t('files.sftpErrorHtml', { err: String(e) })}</div>`));
  }
}

async function listInto(s, p) {
  const entries = await ListDir(s.id, p);
  s.cwd = p;
  if (s.id !== activeSid) return;
  renderPath(s, p);
  renderFiles(s, p, entries);
}

// Fil d'Ariane cliquable : chaque dossier parent du chemin ramène dessus (cd).
function renderPath(s, p) {
  filesPath.innerHTML = '';
  filesPath.title = p;
  const go = (target) => listInto(s, target).catch((e) => toast(String(e), 'error'));

  filesPath.appendChild(el(`<svg class="crumb-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>`));

  const root = el(`<span class="crumb" title="/">/</span>`);
  root.addEventListener('click', () => go('/'));
  filesPath.appendChild(root);

  const parts = p.split('/').filter(Boolean);
  let cum = '';
  parts.forEach((part, i) => {
    cum += '/' + part;
    const target = cum;
    if (i > 0) filesPath.appendChild(el(`<span class="crumb-sep">/</span>`));
    const seg = el(`<span class="crumb"></span>`);
    seg.textContent = part;
    if (i === parts.length - 1) seg.classList.add('crumb--current');
    seg.addEventListener('click', () => go(target));
    filesPath.appendChild(seg);
  });

  // garde la fin du chemin visible
  filesPath.scrollLeft = filesPath.scrollWidth;
}

function renderFiles(s, p, entries) {
  filesTree.innerHTML = '';
  if (p !== '/') {
    const up = el(`<div class="item file-item file-item--dir">${UP_ICON}<span class="item__name">..</span></div>`);
    up.addEventListener('click', () => listInto(s, parentPath(p)).catch((e) => toast(String(e), "error")));
    filesTree.appendChild(up);
  }
  entries.forEach((entry) => {
    const row = el(`<div class="item file-item">
      ${entry.isDir ? DIR_ICON : iconFor(entry.name)}
      <span class="item__name"></span>
      ${entry.isDir ? '' : '<span class="file-size"></span>'}
    </div>`);
    row.querySelector('.item__name').textContent = entry.name;
    if (!entry.isDir) row.querySelector('.file-size').textContent = humanSize(entry.size);
    if (entry.isDir) {
      row.classList.add('file-item--dir');
      row.addEventListener('click', () => listInto(s, entry.path).catch((e) => toast(String(e), 'error')));
    } else {
      row.addEventListener('dblclick', () => openEdit(s, entry));
    }
    // Menu clic droit
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault(); e.stopPropagation();
      const items = entry.isDir
        ? [
            { label: t('ctx.open'), onClick: () => listInto(s, entry.path).catch((err) => toast(String(err), 'error')) },
            { label: t('ctx.openTermHere'), onClick: () => openTerminalHere(s, entry.path) },
            { sep: true },
            { label: t('ctx.downloadDir'), onClick: () => downloadDirEntry(s, entry.path) },
            { label: t('ctx.importHere'), onClick: () => importInto(s, entry.path) },
            { sep: true },
            { label: t('ctx.newDirHere'), onClick: () => newDirIn(s, entry.path) },
            { label: t('ctx.newFileHere'), onClick: () => newFileIn(s, entry.path) },
            { sep: true },
            { label: t('btn.delete'), danger: true, onClick: () => removeEntry(s, entry) },
          ]
        : [
            { label: t('ctx.openInEditor'), onClick: () => openEdit(s, entry) },
            { label: t('ctx.downloadFile'), onClick: () => downloadFileEntry(s, entry) },
            ...(isArchive(entry.name) ? [{ label: t('ctx.extractHere'), onClick: () => extractHere(s, entry) }] : []),
            { sep: true },
            { label: t('ctx.importHere'), onClick: () => importInto(s, s.cwd || parentPath(entry.path)) },
            { sep: true },
            { label: t('btn.delete'), danger: true, onClick: () => removeEntry(s, entry) },
          ];
      showMenu(e.clientX, e.clientY, items);
    });
    filesTree.appendChild(row);
  });
}

function openEdit(s, entry) {
  toast(t('toast.openingInEditor', { name: entry.name }), 'info');
  EditFile(s.id, entry.path).catch((e) => toast(t('toast.editError', { err: String(e) }), 'error'));
}
function joinPath(dir, name) {
  return (dir.endsWith('/') ? dir : dir + '/') + name;
}
async function newDirIn(s, parentDir) {
  const name = await askText(t('btn.newFolder'), t('dlg.folderName'));
  if (!name) return;
  try {
    await MakeDir(s.id, joinPath(parentDir, name));
    toast(t('toast.dirCreated'), 'ok');
    if (s.cwd) listInto(s, s.cwd);
  } catch (e) { toast(t('toast.createFail', { err: String(e) }), 'error'); }
}
async function newFileIn(s, parentDir) {
  const name = await askText(t('dlg.newFile.title'), t('dlg.fileName'));
  if (!name) return;
  const p = joinPath(parentDir, name);
  try {
    await MakeFile(s.id, p);
    toast(t('toast.fileCreated'), 'ok');
    if (s.cwd) await listInto(s, s.cwd);
    openEdit(s, { name, path: p, isDir: false }); // ouvre direct dans l'éditeur
  } catch (e) { toast(t('toast.createFail', { err: String(e) }), 'error'); }
}
async function removeEntry(s, entry) {
  const ok = await askConfirm(t('confirm.deleteEntry', { name: entry.name, suffix: entry.isDir ? t('confirm.deleteEntry.suffix') : '' }));
  if (!ok) return;
  try {
    await Remove(s.id, entry.path);
    toast(t('toast.deleted'), 'ok');
    if (s.cwd) listInto(s, s.cwd);
  } catch (e) { toast(t('toast.deleteFail', { err: String(e) }), 'error'); }
}

// Reconnaît une archive extractible d'après son extension.
function isArchive(name) {
  return /\.(tar\.(gz|bz2|xz|zst)|tgz|tbz2|txz|tzst|tar|zip|rar|7z|gz|bz2|xz|zst)$/i.test(name);
}

// Télécharger un fichier distant → boîte "Enregistrer sous…" (choix de l'emplacement local).
async function downloadFileEntry(s, entry) {
  try {
    const p = await DownloadFileTo(s.id, entry.path);
    if (p) toast(t('toast.downloaded', { path: p }), 'ok');
  } catch (e) { toast(t('toast.downloadFail', { err: String(e) }), 'error'); }
}
// Télécharger un dossier distant (récursif) → boîte "choisir le dossier de destination".
async function downloadDirEntry(s, remotePath) {
  try {
    const p = await DownloadDirTo(s.id, remotePath);
    if (p) toast(t('toast.downloaded', { path: p }), 'ok');
  } catch (e) { toast(t('toast.downloadFail', { err: String(e) }), 'error'); }
}
// Importer un fichier local → upload dans le dossier distant visé.
async function importInto(s, remoteDir) {
  try {
    const name = await UploadFileTo(s.id, remoteDir);
    if (name) {
      toast(t('toast.fileImported', { name }), 'ok');
      if (s.cwd) listInto(s, s.cwd).catch(() => {});
    }
  } catch (e) { toast(t('toast.importFail', { err: String(e) }), 'error'); }
}
// Extraire une archive distante dans son propre dossier (côté serveur).
async function extractHere(s, entry) {
  toast(t('toast.extracting', { name: entry.name }), 'info');
  try {
    await ExtractArchive(s.id, entry.path);
    toast(t('toast.extracted', { name: entry.name }), 'ok');
    if (s.cwd) listInto(s, s.cwd).catch(() => {});
  } catch (e) { toast(t('toast.extractFail', { err: String(e) }), 'error'); }
}

function fitActive() {
  const s = sessions.find((x) => x.id === activeSid);
  if (s) { s.fit.fit(); Resize(s.id, s.term.cols, s.term.rows); }
}

document.getElementById('files-refresh').addEventListener('click', refreshFiles);

// Clic droit n'importe où dans le panneau Fichiers (vide inclus) → menu du dossier courant
filesTree.closest('.panel__body').addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const s = sessions.find((x) => x.id === activeSid);
  if (!s) return;
  showMenu(e.clientX, e.clientY, [
    { label: t('ctx.openTermHere'), onClick: () => openTerminalHere(s, s.cwd || '/') },
    { sep: true },
    { label: t('ctx.downloadCwd'), onClick: () => downloadDirEntry(s, s.cwd || '/') },
    { label: t('ctx.importHere'), onClick: () => importInto(s, s.cwd || '/') },
    { sep: true },
    { label: t('ctx.newDirHere'), onClick: () => newDirIn(s, s.cwd || '/') },
    { label: t('ctx.newFileHere'), onClick: () => newFileIn(s, s.cwd || '/') },
    { sep: true },
    { label: t('btn.refresh'), onClick: refreshFiles },
  ]);
});

/* --- Menu contextuel générique --- */
function showMenu(x, y, items) {
  closeMenu();
  const menu = el(`<div class="ctx-menu"></div>`);
  items.forEach((it) => {
    if (it.sep) { menu.appendChild(el(`<div class="ctx-sep"></div>`)); return; }
    const mi = el(`<div class="ctx-item${it.danger ? ' ctx-item--danger' : ''}"></div>`);
    mi.textContent = it.label;
    mi.addEventListener('click', () => { closeMenu(); it.onClick(); });
    menu.appendChild(mi);
  });
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
  document.body.appendChild(menu);
  const r = menu.getBoundingClientRect();
  if (r.right > window.innerWidth) menu.style.left = (x - r.width) + 'px';
  if (r.bottom > window.innerHeight) menu.style.top = (y - r.height) + 'px';
  setTimeout(() => {
    document.addEventListener('mousedown', closeMenuOutside);
    document.addEventListener('contextmenu', closeMenuOutside);
  }, 0);
}
function closeMenu() {
  const m = document.querySelector('.ctx-menu');
  if (m) m.remove();
  document.removeEventListener('mousedown', closeMenuOutside);
  document.removeEventListener('contextmenu', closeMenuOutside);
}
function closeMenuOutside(e) { if (!e.target.closest('.ctx-menu')) closeMenu(); }

/* ===================== Repli + redimensionnement des panneaux ===================== */
const appEl = document.getElementById('app');
let manualFiles = null, manualConns = null;

document.getElementById('files-collapse').addEventListener('click', () => {
  const collapsed = appEl.classList.toggle('files-collapsed');
  if (collapsed) appEl.style.removeProperty('--col-files');
  else if (manualFiles) appEl.style.setProperty('--col-files', manualFiles + 'px');
  setTimeout(fitActive, 220);
});
document.getElementById('conns-collapse').addEventListener('click', () => {
  const collapsed = appEl.classList.toggle('conns-collapsed');
  if (collapsed) appEl.style.removeProperty('--col-conns');
  else if (manualConns) appEl.style.setProperty('--col-conns', manualConns + 'px');
  setTimeout(fitActive, 220);
});

function setupResizer(resizer, which) {
  resizer.addEventListener('mousedown', (e) => {
    e.preventDefault();
    appEl.classList.add('resizing');
    resizer.classList.add('active');
    const move = (ev) => {
      const rect = appEl.getBoundingClientRect();
      let w = which === 'files' ? ev.clientX - rect.left : rect.right - ev.clientX;
      w = Math.max(160, Math.min(560, w));
      if (which === 'files') { manualFiles = w; appEl.style.setProperty('--col-files', w + 'px'); }
      else { manualConns = w; appEl.style.setProperty('--col-conns', w + 'px'); }
      fitActive();
    };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      appEl.classList.remove('resizing');
      resizer.classList.remove('active');
      fitActive();
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });
}
setupResizer(document.getElementById('resizer-files'), 'files');
setupResizer(document.getElementById('resizer-conns'), 'conns');

/* ===================== Démarrage ===================== */
(async () => {
  await loadStore();
  setLang(detectLang(store.language)); // langue sauvée > langue système > anglais
  applyStaticI18n();
  renderTree();
  await initVersion();
  doCheckUpdate(false); // vérification silencieuse au démarrage (n'affiche que si MAJ dispo)
})();
