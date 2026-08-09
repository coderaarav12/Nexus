(function () {
  'use strict';

  /* ------------------------------------------------------------------ */
  /* Constants and tiny helpers                                          */
  /* ------------------------------------------------------------------ */

  var API_BASE = '/api/v1';
  var LS_ACCESS = 'nx.accessToken';
  var LS_REFRESH = 'nx.refreshToken';
  var LS_DEVICE = 'nx.deviceId';

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function fmtBytes(n) {
    if (n == null || isNaN(n)) return '--';
    if (n < 1024) return Math.round(n) + ' B';
    var units = ['KB', 'MB', 'GB', 'TB', 'PB'];
    var v = n, u = -1;
    do { v /= 1024; u++; } while (v >= 1024 && u < units.length - 1);
    return v.toFixed(1) + ' ' + units[u];
  }

  function fmtRate(n) {
    if (n == null || isNaN(n)) return '--';
    return fmtBytes(n) + '/s';
  }

  function pad(x) { return String(x).padStart(2, '0'); }

  function fmtTime(ts) {
    if (!ts) return '--';
    var d = new Date(ts);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
      ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function fmtClock(ts) {
    if (!ts) return '--';
    var d = new Date(ts);
    return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }

  function fmtDur(sec) {
    if (sec == null || isNaN(sec)) return '--';
    var d = Math.floor(sec / 86400);
    var h = Math.floor((sec % 86400) / 3600);
    var m = Math.floor((sec % 3600) / 60);
    if (d) return d + 'd ' + h + 'h';
    if (h) return h + 'h ' + m + 'm';
    return m + 'm';
  }

  function pct(num, den) {
    if (!den) return 0;
    return Math.max(0, Math.min(100, (num / den) * 100));
  }

  function bar(percent) {
    return '<div class="bar"><div class="fill" style="width:' + percent.toFixed(1) + '%"></div></div>';
  }

  /* ---------- icons ---------- */

  var ICON_FOLDER = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/></svg>';
  var ICON_FILE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>';
  var ICON_GRID = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>';
  var ICON_SEARCH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>';
  var ICON_DEVICE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>';
  var ICON_SHIELD = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/></svg>';
  var ICON_GEAR = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9 17 7M7 17l-2.1 2.1"/></svg>';
  var ICON_USERS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8"/></svg>';
  var ICON_NODES = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="5" cy="6" r="3"/><circle cx="19" cy="6" r="3"/><circle cx="12" cy="18" r="3"/><path d="M7.5 7.8 10.7 15M16.5 7.8 13.3 15"/></svg>';
  var ICON_ACTIVITY = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>';
  var ICON_CHART = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 20V10M12 20V4M6 20v-6"/></svg>';
  var ICON_BACK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>';

  /* ---------- global state ---------- */

  var me = null;
  var grantToken = null;
  var dashTimer = null;
  var dashLoading = false;
  var dashPaused = false;
  var privateUnlockToken = null;
  var uploadSession = null;
  var userCache = [];
  var memberDebounce = null;
  var searchCache = [];
  var lastSearchQuery = '';

  var filesCtx = { mode: 'vault', wsId: null, canEdit: true, stack: [{ id: null, name: 'My Vault' }] };
  var wsView = null;

  /* ------------------------------------------------------------------ */
  /* Toast + modal                                                       */
  /* ------------------------------------------------------------------ */

  function toast(msg, type) {
    var box = $('#toasts');
    var el = document.createElement('div');
    el.className = 'toast ' + (type || 'info');
    el.textContent = msg;
    box.appendChild(el);
    setTimeout(function () {
      el.classList.add('out');
      setTimeout(function () { el.remove(); }, 320);
    }, 3400);
  }

  function openModal(bodyHtml) {
    $('#modalBody').innerHTML = bodyHtml;
    $('#modal').classList.remove('hidden');
  }

  function closeModal() {
    $('#modal').classList.add('hidden');
    $('#modalBody').innerHTML = '';
  }

  function confirmAction(msg) {
    return window.confirm(msg);
  }

  /* ------------------------------------------------------------------ */
  /* Request layer with refresh-on-401                                    */
  /* ------------------------------------------------------------------ */

  function tryRefresh() {
    var rt = localStorage.getItem(LS_REFRESH);
    if (!rt) return Promise.resolve(false);
    return fetch(API_BASE + '/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: rt }),
    }).then(function (res) {
      if (res.status === 401) { localStorage.removeItem(LS_REFRESH); return false; }
      return res.json().then(function (data) {
        if (!data || !data.accessToken) return false;
        localStorage.setItem(LS_ACCESS, data.accessToken);
        localStorage.setItem(LS_REFRESH, data.refreshToken);
        return true;
      });
    }).catch(function () { return false; });
  }

  function rawFetch(path, opts) {
    opts = opts || {};
    var headers = {};
    if (opts.body != null && opts.json !== false) headers['Content-Type'] = 'application/json';
    var tok = localStorage.getItem(LS_ACCESS);
    if (tok && !opts.noAuth) headers['Authorization'] = 'Bearer ' + tok;
    if (privateUnlockToken) headers['x-private-unlock'] = privateUnlockToken;
    for (var k in (opts.headers || {})) headers[k] = opts.headers[k];
    var init = { method: opts.method || 'GET', headers: headers };
    if (opts.body != null) init.body = opts.body;
    return fetch(API_BASE + path, init);
  }

  function parseError(res) {
    return res.json().then(function (data) {
      return new Error((data && data.error) || ('HTTP ' + res.status));
    }).catch(function () {
      return new Error('HTTP ' + res.status);
    });
  }

  function doRequest(path, opts, allowRetry) {
    opts = opts || {};
    return rawFetch(path, opts).then(function (res) {
      if (res.status === 401 && allowRetry) {
        return tryRefresh().then(function (ok) {
          if (!ok) {
            forceLogout();
            throw new Error('Session expired. Please sign in again.');
          }
          return doRequest(path, opts, false);
        });
      }
      if (opts.blob) {
        if (!res.ok) return parseError(res).then(function (e) { throw e; });
        return res.blob();
      }
      var ct = res.headers.get('content-type') || '';
      if (ct.indexOf('application/json') !== -1) {
        return res.json().then(function (data) {
          if (!res.ok) throw new Error((data && data.error) || ('HTTP ' + res.status));
          return data;
        });
      }
      if (!res.ok) return parseError(res).then(function (e) { throw e; });
      return res.text();
    });
  }

  function request(path, opts) {
    return doRequest(path, opts, true);
  }

  function fetchJson(path, opts) {
    opts = opts || {};
    var headers = { 'Content-Type': 'application/json' };
    for (var k in (opts.headers || {})) headers[k] = opts.headers[k];
    return fetch(API_BASE + path, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body,
    }).then(function (res) {
      return res.json().then(function (data) {
        if (!res.ok) throw new Error((data && data.error) || ('HTTP ' + res.status));
        return data;
      });
    });
  }

  function forceLogout() {
    localStorage.removeItem(LS_ACCESS);
    localStorage.removeItem(LS_REFRESH);
    localStorage.removeItem(LS_DEVICE);
    me = null;
    showLogin();
  }

  /* ------------------------------------------------------------------ */
  /* Auth flow                                                           */
  /* ------------------------------------------------------------------ */

  function showLogin() {
    clearInterval(dashTimer);
    $('#login').classList.remove('hidden');
    $('#app').classList.add('hidden');
    $('#loginForm').classList.remove('hidden');
    $('#registerForm').classList.add('hidden');
    $('#mfaForm').classList.add('hidden');
    $('#loginErr').textContent = '';
    $('#loginErr').className = 'login-err';
    // Show the register link only while registration is open (no users yet).
    fetch(API_BASE + '/auth/registration-open').then(function (r) {
      return r.json();
    }).then(function (data) {
      var link = $('#showRegister');
      if (link) link.parentNode.style.display = (data && data.open) ? '' : 'none';
    }).catch(function () {});
    if ($('#loginUser')) $('#loginUser').focus();
  }

  function startLogin(username, password) {
    return fetchJson('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: username, password: password }),
    }).then(function (data) {
      grantToken = data.grantToken;
      if (data.mfaRequired) {
        $('#loginForm').classList.add('hidden');
        $('#mfaForm').classList.remove('hidden');
        $('#loginErr').textContent = 'Enter your 6-digit verification code';
        $('#mfaForm').reset();
        $('#mfaCode').focus();
      } else {
        return finishLogin(data.grantToken);
      }
    });
  }

  function finishLogin(grant) {
    return fetchJson('/auth/devices/register', {
      method: 'POST',
      body: JSON.stringify({ grantToken: grant, name: 'Dashboard', platform: 'web' }),
    }).then(function (out) {
      localStorage.setItem(LS_ACCESS, out.accessToken);
      localStorage.setItem(LS_REFRESH, out.refreshToken);
      localStorage.setItem(LS_DEVICE, out.deviceId);
      return reloadMe().then(function () {
        showApp();
        route();
        toast('Welcome back', 'ok');
      });
    });
  }

  function logout() {
    var rt = localStorage.getItem(LS_REFRESH);
    if (rt) {
      fetch(API_BASE + '/auth/logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: rt }),
      }).catch(function () {});
    }
    forceLogout();
    toast('Logged out', 'info');
  }

  function reloadMe() {
    return request('/auth/me').then(function (data) {
      me = data;
      return me;
    });
  }

  /* ------------------------------------------------------------------ */
  /* App shell                                                           */
  /* ------------------------------------------------------------------ */

  var NAV = [
    { id: 'dashboard', label: 'Dashboard', icon: ICON_CHART, admin: 'gate' },
    { id: 'files', label: 'Files', icon: ICON_FOLDER },
    { id: 'workspaces', label: 'Workspaces', icon: ICON_USERS },
    { id: 'search', label: 'Search', icon: ICON_SEARCH },
    { id: 'devices', label: 'Devices', icon: ICON_DEVICE },
    { id: 'security', label: 'Security', icon: ICON_SHIELD },
    { id: 'settings', label: 'Settings', icon: ICON_GEAR },
    { id: 'users', label: 'Users', icon: ICON_USERS, admin: true },
    { id: 'nodes', label: 'Nodes', icon: ICON_NODES, admin: true },
    { id: 'activity', label: 'Activity', icon: ICON_ACTIVITY, admin: true },
  ];

  var TITLES = {
    dashboard: 'Dashboard', files: 'Files', workspaces: 'Workspaces', search: 'Search',
    devices: 'Devices', security: 'Security', settings: 'Settings',
    users: 'Users', nodes: 'Nodes', activity: 'Activity',
  };

  function isAdmin() { return me && me.role === 'admin'; }

  function showApp() {
    $('#login').classList.add('hidden');
    $('#app').classList.remove('hidden');
    renderNav();
    renderTopbar();
  }

  function currentRoute() {
    var h = location.hash.replace(/^#/, '').split('/')[0];
    return h || 'files';
  }

  function renderNav() {
    var items = NAV.filter(function (n) { return !n.admin || isAdmin(); });
    $('#nav').innerHTML = items.map(function (n) {
      return '<button class="nav-item' + (currentRoute() === n.id ? ' active' : '') + '" data-nav="' + n.id + '">' +
        '<span class="nav-ic">' + n.icon + '</span>' + esc(n.label) + '</button>';
    }).join('');
    $$('#nav .nav-item').forEach(function (b) {
      b.addEventListener('click', function () {
        var id = b.getAttribute('data-nav');
        if (id === 'files') {
          filesCtx.mode = 'vault';
          filesCtx.wsId = null;
          filesCtx.canEdit = true;
          filesCtx.stack = [{ id: null, name: 'My Vault' }];
        }
        if (id === 'workspaces') wsView = null;
        navigate('#' + id);
        closeSidebar();
      });
    });
  }

  function renderTopbar() {
    $('#topUser').textContent = (me.displayName || me.username || '');
    var role = $('#topRole');
    if (role) role.textContent = me.role || '';
    var av = $('#chipAvatar');
    if (av) av.textContent = (me.displayName || me.username || '?').charAt(0);
    var cn = $('#chipName');
    if (cn) cn.textContent = me.displayName || me.username;
    var cr = $('#chipRole');
    if (cr) cr.textContent = me.role;
  }

  function setPageTitle(name) {
    $('#pageTitle').textContent = TITLES[name] || 'Project Nexus';
  }

  function navigate(hash) {
    var clean = '#' + hash.replace(/^#/, '');
    if (location.hash === clean) route();
    else location.hash = clean;
  }

  function openSidebar() {
    $('#sidebar').classList.add('open');
    $('#scrim').classList.remove('hidden');
  }
  function closeSidebar() {
    $('#sidebar').classList.remove('open');
    $('#scrim').classList.add('hidden');
  }

  /* ------------------------------------------------------------------ */
  /* Router                                                              */
  /* ------------------------------------------------------------------ */

  function loading() { return '<div class="loading">Loading...</div>'; }
  function page(bodyHtml) { return '<div class="page">' + bodyHtml + '</div>'; }
  function errHtml(msg) { return page('<div class="card note"><p class="dim">' + esc(msg) + '</p></div>'); }
  function section(title, bodyHtml, cls) {
    return '<section class="card' + (cls ? ' ' + cls : '') + '"><h3 class="card-title">' + esc(title) +
      '</h3><div class="card-body">' + bodyHtml + '</div></section>';
  }

  function route() {
    clearInterval(dashTimer);
    var name = currentRoute();
    setPageTitle(name);

    var nav = NAV.filter(function (n) { return n.id === name; })[0];
    if (nav && nav.admin && !isAdmin()) {
      renderAdminRequired();
      return;
    }

    var map = {
      dashboard: renderDashboard,
      files: renderFiles,
      workspaces: renderWorkspaces,
      search: renderSearch,
      devices: renderDevices,
      security: renderSecurity,
      settings: renderSettings,
      users: renderUsers,
      nodes: renderNodes,
      activity: renderActivity,
    };
    (map[name] || renderFiles)();
    renderNav();
  }

  function renderAdminRequired() {
    $('#view').innerHTML = page(
      '<div class="card note"><h3 class="card-title">Administrator access required</h3>' +
      '<p class="dim">This page is only available to administrators of this Project Nexus instance.</p></div>'
    );
    renderNav();
  }

  /* ------------------------------------------------------------------ */
  /* Delegated actions                                                   */
  /* ------------------------------------------------------------------ */

  var ACTIONS = {
    'open-folder': function (el) {
      var id = Number(el.getAttribute('data-i'));
      var name = el.getAttribute('data-n') || 'Folder';
      filesCtx.stack.push({ id: id, name: name });
      refreshFilesView();
    },
    'open-private': function () { openPrivateFolder(); },
    'crumb': function (el) {
      var idx = Number(el.getAttribute('data-idx'));
      filesCtx.stack = filesCtx.stack.slice(0, idx + 1);
      refreshFilesView();
    },
    'new-folder': function () { newFolder(); },
    'pick-upload': function () {
      var input = $('#fileInput');
      if (input) input.click();
    },
    'delete-item': function (el) { deleteItem(el); },
    'download': function (el) { downloadItem(el); },
    'versions': function (el) { showVersions(el); },
    'restore': function (el) { restoreVersion(el); },
    'open-ws': function (el) {
      wsView = Number(el.getAttribute('data-i'));
      navigate('#workspaces');
    },
    'back-ws': function () { wsView = null; navigate('#workspaces'); },
    'delete-ws': function () { deleteWorkspace(); },
    'rm-member': function (el) { removeMember(el); },
    'rename-device': function (el) { renameDevice(el); },
    'revoke-device': function (el) { revokeDevice(el); },
    'open-result': function (el) { openSearchResult(el); },
    'run-backup': function () { runBackup(); },
    'shutdown-server': function () { shutdownServer(); },
    'dash-pause': function () { toggleDashPause(); },
    'priv-set-pw': function () { setPrivatePassword(); },
    'priv-unlock': function () { unlockPrivateFolder(); },
    'load-2fa': function () { setup2fa(); },
    'mark-read': function () { markNotifsRead(); },
  };

  document.addEventListener('click', function (e) {
    var el = e.target.closest ? e.target.closest('[data-act]') : null;
    if (!el) return;
    var fn = ACTIONS[el.getAttribute('data-act')];
    if (fn) fn(el, e);
  });

  document.addEventListener('click', function (e) {
    var el = e.target.closest ? e.target.closest('[data-mask]') : null;
    if (!el) return;
    el.classList.toggle('revealed');
  });

  function maskedHtml(value) {
    return '<span class="masked" data-mask title="Click to reveal">' + value + '</span>';
  }

  /* ------------------------------------------------------------------ */
  /* Files page                                                          */
  /* ------------------------------------------------------------------ */

  function refreshFilesView() {
    if ($('#filesHost')) renderFiles('#filesHost');
    else if (currentRoute() === 'files') renderFiles();
  }

  function filesListUrl() {
    var cur = filesCtx.stack[filesCtx.stack.length - 1];
    if (filesCtx.mode === 'ws') {
      if (cur && cur.id) return '/storage/vault/' + cur.id;
      return '/sharing/workspaces/' + filesCtx.wsId + '/items';
    }
    return (cur && cur.id) ? '/storage/vault/' + cur.id : '/storage/vault';
  }

  function loadItems() {
    return request(filesListUrl()).then(function (data) { return (data && data.items) || []; });
  }

  async function filesHtml() {
    var items = await loadItems();
    var crumbs = filesCtx.stack.map(function (c, idx) {
      return '<button class="crumb" data-act="crumb" data-i="' + (c.id === null ? '' : c.id) +
        '" data-idx="' + idx + '">' + esc(c.name) + '</button>';
    }).join('<span class="crumb-sep">/</span>');

    var privateCard = '';
    if (filesCtx.mode === 'vault' && filesCtx.stack.length === 1) {
      privateCard = '<div class="card private-card"><div class="node-head">' +
        '<span class="node-name">Private folder (encrypted)</span>' +
        '<button class="btn primary small" data-act="open-private">Open my private folder</button></div>' +
        '<div class="dim small">Encrypted per-user folder on the network drive. Only you and the admin can view it.</div></div>';
    }

    var rows = items.map(function (it) {
      var icon = it.kind === 'folder' ? ICON_FOLDER : ICON_FILE;
      var size = it.kind === 'folder' ? '--' : fmtBytes(it.size);
      var name = esc(it.name);
      var n = ' data-n="' + esc(it.name) + '"';
      var id = ' data-i="' + it.id + '"';
      if (it.kind === 'folder') {
        return '<tr><td class="name-cell"><span class="ic">' + icon + '</span>' +
          '<button class="link" data-act="open-folder"' + id + n + '>' + name + '</button></td>' +
          '<td>folder</td><td>' + size + '</td><td>' + fmtTime(it.mtime) + '</td>' +
          '<td class="row-actions">' + (filesCtx.canEdit ? '<button class="btn small danger" data-act="delete-item"' + id + n + '>Delete</button>' : '') + '</td></tr>';
      }
      return '<tr><td class="name-cell"><span class="ic">' + icon + '</span>' + name + '</td>' +
        '<td>file</td><td>' + size + '</td><td>' + fmtTime(it.mtime) + '</td>' +
        '<td class="row-actions">' +
        '<button class="btn small ghost" data-act="download"' + id + n + '>Download</button>' +
        (filesCtx.canEdit ? '<button class="btn small ghost" data-act="versions"' + id + n + '>Versions</button>' : '') +
        (filesCtx.canEdit ? '<button class="btn small danger" data-act="delete-item"' + id + n + '>Delete</button>' : '') +
        '</td></tr>';
    }).join('');
    var empty = items.length ? '' : '<tr><td colspan="5" class="empty">This folder is empty</td></tr>';

    var toolbar = '<div class="files-toolbar"><div class="crumbs">' + crumbs + '</div>' +
      '<div class="toolbar-actions">' +
      (filesCtx.canEdit ? '<button class="btn ghost" data-act="new-folder">New folder</button>' +
        '<button class="btn primary" data-act="pick-upload">Upload</button>' +
        '<input type="file" id="fileInput" multiple class="hidden-file">' : '') +
      '</div></div>';

    return privateCard + toolbar +
      '<div class="card"><table class="table"><thead><tr><th>Name</th><th>Type</th><th>Size</th><th>Modified</th><th></th></tr></thead>' +
      '<tbody>' + rows + empty + '</tbody></table></div>';
  }

  function renderFiles(container) {
    var host = container ? $(container) : $('#view');
    if (!host) return;
    host.innerHTML = loading();
    filesHtml().then(function (html) {
      host.innerHTML = container ? html : page(html);
    }).catch(function (err) {
      if (err.message && err.message.indexOf('locked') !== -1 && !privateUnlockToken) {
        host.innerHTML = page('<div class="card note"><p class="dim">' + esc(err.message) + '</p>' +
          '<button class="btn primary" data-act="open-private" style="margin-top:10px">Unlock private folder</button></div>');
        return;
      }
      host.innerHTML = container ? '<div class="card note"><p class="dim">' + esc(err.message) + '</p></div>' : errHtml(err.message);
    });
  }

  function newFolder() {
    var name = window.prompt('Folder name:');
    if (!name) return;
    var cur = filesCtx.stack[filesCtx.stack.length - 1];
    var body = { name: name };
    if (cur && cur.id) body.parentId = cur.id;
    var url = filesCtx.mode === 'ws'
      ? '/sharing/workspaces/' + filesCtx.wsId + '/folder'
      : '/storage/vault/folder';
    request(url, { method: 'POST', body: JSON.stringify(body) }).then(function () {
      toast('Folder created', 'ok');
      refreshFilesView();
    }).catch(function (err) { toast(err.message, 'err'); });
  }

  function openPrivateFolder() {
    request('/private/status').then(function (data) {
      var st = data && data.status;
      if (!st) throw new Error('No private folder');
      if (st.hasPassword && !privateUnlockToken) {
        openPrivateUnlockModal();
        return;
      }
      filesCtx.mode = 'vault';
      filesCtx.stack = [{ id: null, name: 'My Vault' }, { id: st.id, name: 'Private' }];
      refreshFilesView();
    }).catch(function (err) { toast(err.message, 'err'); });
  }

  function openPrivateUnlockModal() {
    openModal(
      '<h3 class="modal-title">Private folder locked</h3>' +
      '<p class="dim">Enter the private folder password to unlock and view its contents.</p>' +
      '<form id="privUnlockForm" class="member-form">' +
      '<input id="privUnlockPw" class="input" type="password" placeholder="Private folder password" autocomplete="off" required>' +
      '<button class="btn primary" type="submit">Unlock</button></form>' +
      '<p class="login-err" id="privUnlockErr"></p>'
    );
    $('#privUnlockForm').addEventListener('submit', function (e) {
      e.preventDefault();
      var pw = $('#privUnlockPw').value;
      request('/private/unlock', {
        method: 'POST',
        body: JSON.stringify({ password: pw }),
      }).then(function (data) {
        privateUnlockToken = data.token;
        closeModal();
        openPrivateFolder();
      }).catch(function (err) {
        var errEl = $('#privUnlockErr');
        if (errEl) { errEl.textContent = err.message; errEl.className = 'login-err'; }
      });
    });
  }

  function deleteItem(el) {
    var id = Number(el.getAttribute('data-i'));
    var name = el.getAttribute('data-n') || 'item';
    if (!confirmAction('Delete "' + name + '"? This cannot be undone.')) return;
    var url = filesCtx.mode === 'ws'
      ? '/sharing/workspaces/' + filesCtx.wsId + '/items/' + id
      : '/storage/vault/' + id;
    request(url, { method: 'DELETE' }).then(function () {
      toast('Deleted ' + name, 'ok');
      refreshFilesView();
    }).catch(function (err) { toast(err.message, 'err'); });
  }

  function saveBlob(blob, name) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
  }

  function downloadItem(el) {
    var id = Number(el.getAttribute('data-i'));
    var name = el.getAttribute('data-n') || 'file';
    request('/storage/vault/' + id + '/content', { blob: true }).then(function (blob) {
      saveBlob(blob, name);
    }).catch(function (err) { toast(err.message, 'err'); });
  }

  function showVersions(el) {
    var id = Number(el.getAttribute('data-i'));
    var name = el.getAttribute('data-n') || 'file';
    request('/storage/vault/' + id + '/versions').then(function (data) {
      var rows = (data.versions || []).map(function (v) {
        return '<tr><td class="mono">' + esc(v.version) + '</td><td>' + fmtBytes(v.size) + '</td>' +
          '<td>' + fmtTime(v.created_at) + '</td><td class="mono break">' + esc(v.sha256 || '') + '</td>' +
          '<td>' + (filesCtx.canEdit ? '<button class="btn small primary" data-act="restore" data-i="' + id +
            '" data-v="' + esc(v.version) + '">Restore</button>' : '') + '</td></tr>';
      }).join('') || '<tr><td colspan="5" class="empty">No versions for this file</td></tr>';
      $('#modalTitle').textContent = 'Versions - ' + name;
      openModal('<table class="table"><thead><tr><th>Version</th><th>Size</th><th>Date</th><th>SHA-256</th><th></th></tr></thead>' +
        '<tbody>' + rows + '</tbody></table>');
    }).catch(function (err) { toast(err.message, 'err'); });
  }

  function restoreVersion(el) {
    var id = Number(el.getAttribute('data-i'));
    var ver = el.getAttribute('data-v');
    if (!confirmAction('Restore version ' + ver + ' of this file?')) return;
    request('/storage/vault/' + id + '/restore', {
      method: 'POST',
      body: JSON.stringify({ version: Number(ver) }),
    }).then(function () {
      closeModal();
      toast('Version restored', 'ok');
      refreshFilesView();
    }).catch(function (err) { toast(err.message, 'err'); });
  }

  /* ---------- uploads ---------- */

  function toHex(buf) {
    return Array.prototype.map.call(new Uint8Array(buf), function (b) {
      return b.toString(16).padStart(2, '0');
    }).join('');
  }

  function sha256File(file) {
    return file.arrayBuffer().then(function (buf) {
      return crypto.subtle.digest('SHA-256', buf);
    }).then(function (digest) {
      return toHex(digest);
    });
  }

  function startUploadPanel(files) {
    uploadSession = { files: files, index: 0 };
    var panel = $('#uploadPanel');
    panel.classList.remove('hidden');
    panel.innerHTML = '<h4>Uploading</h4>' + files.map(function (f, i) {
      return '<div class="upload-row" data-row="' + i + '">' +
        '<div class="upload-top"><span class="upload-name">' + esc(f.name) + '</span><span class="upload-msg">queued</span></div>' +
        '<div class="bar"><div class="fill" style="width:0%"></div></div></div>';
    }).join('');
  }

  function setUploadRow(i, state, done, total) {
    if (!uploadSession) return;
    var row = $('#uploadPanel .upload-row[data-row="' + i + '"]');
    if (!row) return;
    var msg = row.querySelector('.upload-msg');
    var fill = row.querySelector('.fill');
    if (state === 'active') {
      msg.textContent = (done != null && total != null) ? fmtBytes(done) + ' / ' + fmtBytes(total) : 'uploading';
      if (fill) fill.style.width = pct(done || 0, total || 1).toFixed(1) + '%';
    } else if (state === 'done') {
      msg.textContent = 'done';
      if (fill) fill.style.width = '100%';
    } else if (state === 'err') {
      msg.textContent = 'failed';
      msg.style.color = 'var(--red)';
    }
  }

  function endUploadPanel() {
    uploadSession = null;
    $('#uploadPanel').classList.add('hidden');
    $('#uploadPanel').innerHTML = '';
  }

  function handleFilesSelected(fileList) {
    var files = Array.prototype.slice.call(fileList);
    if (!files.length) return;
    startUploadPanel(files);
    var seq = Promise.resolve();
    files.forEach(function (f, i) {
      seq = seq.then(function () {
        uploadSession.index = i;
        setUploadRow(i, 'active');
        return uploadOne(f, function (done, total) {
          setUploadRow(i, 'active', done, total);
        }).then(function () {
          setUploadRow(i, 'done');
        }, function (err) {
          setUploadRow(i, 'err');
          toast('Upload failed: ' + f.name + ' - ' + err.message, 'err');
        });
      });
    });
    seq.then(function () {
      setTimeout(function () {
        endUploadPanel();
        refreshFilesView();
      }, 1100);
    });
  }

  function uploadOne(file, onProgress) {
    var cur = filesCtx.stack[filesCtx.stack.length - 1];
    var body = {
      filename: file.name,
      size: file.size,
      sha256: null,
      mtime: Math.floor((file.lastModified || Date.now()) / 1000),
    };
    if (cur && cur.id) body.parentId = cur.id;
    if (filesCtx.mode === 'ws') body.workspaceId = filesCtx.wsId;

    return sha256File(file).then(function (sha) {
      body.sha256 = sha;
      return request('/sync/upload', { method: 'POST', body: JSON.stringify(body) });
    }).then(function (job) {
      if (job.deduped) {
        if (onProgress) onProgress(job.totalBytes, job.totalBytes);
        toast('Already on server: ' + file.name, 'info');
        return;
      }
      var jobId = job.jobId;
      var jobToken = job.jobToken;
      var chunkSize = job.chunkSize || 1048576;
      var totalBytes = job.totalBytes || file.size;
      var totalChunks = Math.max(1, Math.ceil(file.size / chunkSize));
      var index = 0;
      var guard = 0;

      function sendChunk() {
        if (index >= totalChunks) return Promise.resolve();
        var start = index * chunkSize;
        var end = Math.min(file.size, start + chunkSize);
        return file.slice(start, end).arrayBuffer().then(function (buf) {
          return fetch(API_BASE + '/sync/jobs/' + encodeURIComponent(jobId) + '/chunks/' + index, {
            method: 'POST',
            headers: { 'Content-Type': 'application/octet-stream', 'x-job-token': jobToken },
            body: buf,
          }).then(function (res) {
            return res.json().catch(function () { return {}; }).then(function (data) {
              if (!res.ok) throw new Error((data && data.error) || ('chunk upload failed (HTTP ' + res.status + ')'));
              if (data.gap || data.skipped) {
                var resume = Number(data.resumeIndex) || 0;
                if (resume <= index && ++guard > totalChunks + 2) throw new Error('server stalled');
                index = Math.max(0, resume);
                return sendChunk();
              }
              if (onProgress) onProgress(Number(data.bytesDone) || end, Number(data.totalBytes) || totalBytes);
              index += 1;
              return sendChunk();
            });
          });
        });
      }

      return sendChunk().then(function () {
        return request('/sync/jobs/' + encodeURIComponent(jobId) + '/complete', {
          method: 'POST',
          body: JSON.stringify({ jobToken: jobToken }),
        });
      }).then(function () {
        if (onProgress) onProgress(totalBytes, totalBytes);
      });
    });
  }

  /* ------------------------------------------------------------------ */
  /* Workspaces page                                                     */
  /* ------------------------------------------------------------------ */

  function renderWorkspaces() {
    if (wsView) { renderWsDetail(); return; }
    $('#view').innerHTML = loading();
    request('/sharing/workspaces').then(function (data) {
      var list = (data.workspaces || []).map(function (w) {
        return '<div class="ws-card card"><div class="ws-head"><span class="ws-name">' + esc(w.name) + '</span>' +
          '<span class="badge info">' + esc(w.role || 'viewer') + '</span></div>' +
          '<div class="dim small">' + esc(w.kind || 'shared') + ' - created ' + fmtTime(w.created_at) + '</div>' +
          '<div class="ws-actions"><button class="btn small primary" data-act="open-ws" data-i="' + w.id + '">Open</button></div></div>';
      }).join('') || '<div class="card note"><p class="dim">No workspaces yet. Create one below.</p></div>';

      $('#view').innerHTML = page(
        '<div class="grid ws-grid">' + list + '</div>' +
        '<div class="card"><h3 class="card-title">New workspace</h3>' +
        '<form id="wsForm" class="member-form"><input id="wsName" class="input" placeholder="Workspace name" required>' +
        '<button class="btn primary" type="submit">Create</button></form></div>'
      );
      $('#wsForm').addEventListener('submit', createWorkspace);
    }).catch(function (err) { $('#view').innerHTML = errHtml(err.message); });
  }

  function createWorkspace(e) {
    e.preventDefault();
    var name = $('#wsName').value.trim();
    if (!name) return;
    request('/sharing/workspaces', { method: 'POST', body: JSON.stringify({ name: name }) }).then(function () {
      toast('Workspace created', 'ok');
      renderWorkspaces();
    }).catch(function (err) { toast(err.message, 'err'); });
  }

  function renderWsDetail() {
    $('#view').innerHTML = loading();
    request('/sharing/workspaces/' + wsView).then(function (data) {
      var ws = data.workspace;
      var role = data.role || 'viewer';
      var canManage = role === 'owner';
      var canEdit = role === 'owner' || role === 'editor';

      filesCtx.mode = 'ws';
      filesCtx.wsId = wsView;
      filesCtx.canEdit = canEdit;
      filesCtx.stack = [{ id: null, name: ws.name }];

      var membersRows = (data.members || []).map(function (m) {
        return '<tr><td>' + esc(m.username) + '</td><td><span class="badge ' + (m.role === 'owner' ? 'accent' : 'info') + '">' +
          esc(m.role) + '</span></td><td class="row-actions">' +
          (canManage && m.user_id !== me.id
            ? '<button class="btn small danger" data-act="rm-member" data-i="' + m.user_id + '" data-n="' + esc(m.username) + '">Remove</button>'
            : '') +
          '</td></tr>';
      }).join('') || '<tr><td colspan="3" class="empty">No members</td></tr>';

      var membersCard = section('Members',
        '<table class="table"><thead><tr><th>Username</th><th>Role</th><th></th></tr></thead><tbody>' + membersRows + '</tbody></table>' +
        (canManage
          ? '<form id="memberForm" class="member-form">' +
            '<input id="memberInput" class="input" list="memberOptions" placeholder="Search username" autocomplete="off">' +
            '<datalist id="memberOptions"></datalist>' +
            '<select id="memberRole"><option value="viewer">Viewer</option><option value="editor">Editor</option></select>' +
            '<button class="btn primary" type="submit">Add member</button></form>' +
            '<div style="margin-top:14px"><button class="btn danger" data-act="delete-ws">Delete workspace</button></div>'
          : '')
      );

      $('#view').innerHTML = page(
        '<div class="ws-detail-head"><button class="btn ghost" data-act="back-ws"><span class="ic">' + ICON_BACK + '</span>Workspaces</button>' +
        '<h2>' + esc(ws.name) + ' <span class="badge ' + (role === 'owner' ? 'accent' : role === 'editor' ? 'ok' : 'info') + '">' + esc(role) + '</span></h2></div>' +
        '<div class="ws-grid-detail"><div>' + membersCard + '</div><div id="filesHost"></div></div>'
      );

      var mf = $('#memberForm');
      if (mf) mf.addEventListener('submit', addMemberSubmit);
      renderFiles('#filesHost');
    }).catch(function (err) { $('#view').innerHTML = errHtml(err.message); });
  }

  function userSearch(q) {
    q = (q || '').trim();
    if (q.length < 2) return Promise.resolve();
    return request('/sharing/users/search?q=' + encodeURIComponent(q)).then(function (data) {
      userCache = (data && data.users) || [];
      var opts = $('#memberOptions');
      if (opts) opts.innerHTML = userCache.map(function (u) {
        return '<option value="' + esc(u.username) + '"></option>';
      }).join('');
    }).catch(function () {});
  }

  function addMemberSubmit(e) {
    e.preventDefault();
    var uname = $('#memberInput').value.trim();
    var role = $('#memberRole').value;
    var u = userCache.filter(function (x) { return x.username === uname; })[0];
    if (!u) {
      toast('User not found. Type a username from the suggestions.', 'err');
      return;
    }
    request('/sharing/workspaces/' + wsView + '/members', {
      method: 'POST',
      body: JSON.stringify({ userId: u.id, role: role }),
    }).then(function () {
      toast('Member added', 'ok');
      renderWsDetail();
    }).catch(function (err) { toast(err.message, 'err'); });
  }

  function removeMember(el) {
    var uid = Number(el.getAttribute('data-i'));
    var uname = el.getAttribute('data-n') || 'user';
    if (!confirmAction('Remove ' + uname + ' from this workspace?')) return;
    request('/sharing/workspaces/' + wsView + '/members/' + uid, { method: 'DELETE' }).then(function () {
      toast('Member removed', 'ok');
      renderWsDetail();
    }).catch(function (err) { toast(err.message, 'err'); });
  }

  function deleteWorkspace() {
    if (!confirmAction('Delete this workspace and all of its files? This cannot be undone.')) return;
    request('/sharing/workspaces/' + wsView, { method: 'DELETE' }).then(function () {
      toast('Workspace deleted', 'ok');
      wsView = null;
      navigate('#workspaces');
    }).catch(function (err) { toast(err.message, 'err'); });
  }

  /* ------------------------------------------------------------------ */
  /* Search page                                                         */
  /* ------------------------------------------------------------------ */

  function renderSearch() {
    $('#view').innerHTML = page(
      '<div class="card"><h3 class="card-title">Search</h3>' +
      '<form id="searchForm" class="member-form">' +
      '<input id="searchInput" class="input" placeholder="Search files and folders..." value="' + esc(lastSearchQuery) + '">' +
      '<button class="btn primary" type="submit">Search</button></form></div>' +
      '<div id="searchResults"></div>'
    );
    $('#searchForm').addEventListener('submit', function (e) {
      e.preventDefault();
      runSearch();
    });
    if (lastSearchQuery) runSearch();
  }

  function runSearch() {
    var q = $('#searchInput').value.trim();
    lastSearchQuery = q;
    if (!q) return;
    $('#searchResults').innerHTML = loading();
    request('/search/search?q=' + encodeURIComponent(q)).then(function (data) {
      searchCache = (data && data.results) || [];
      var rows = searchCache.map(function (r) {
        var n = ' data-n="' + esc(r.name) + '"';
        var id = ' data-i="' + r.id + '"';
        return '<tr><td class="name-cell"><span class="ic">' + (r.kind === 'folder' ? ICON_FOLDER : ICON_FILE) + '</span>' +
          esc(r.name) + '</td><td><span class="badge ' + (r.kind === 'folder' ? 'info' : 'ok') + '">' + esc(r.kind) + '</span></td>' +
          '<td class="dim small break">' + esc(r.path || '') + '</td><td>' + (r.kind === 'folder' ? '--' : fmtBytes(r.size)) + '</td>' +
          '<td class="row-actions"><button class="btn small primary" data-act="open-result"' + id + n + '>' +
          (r.kind === 'folder' ? 'Open' : 'Download') + '</button></td></tr>';
      }).join('');
      var empty = searchCache.length ? '' : '<tr><td colspan="5" class="empty">No results for "' + esc(q) + '"</td></tr>';
      $('#searchResults').innerHTML =
        '<div class="card"><table class="table"><thead><tr><th>Name</th><th>Type</th><th>Path</th><th>Size</th><th></th></tr></thead>' +
        '<tbody>' + rows + empty + '</tbody></table></div>';
    }).catch(function (err) {
      $('#searchResults').innerHTML = errHtml(err.message);
    });
  }

  function openSearchResult(el) {
    var id = Number(el.getAttribute('data-i'));
    var item = searchCache.filter(function (r) { return r.id === id; })[0];
    if (!item) return;
    if (item.kind === 'folder') {
      if (item.workspace_id) {
        filesCtx.mode = 'ws';
        filesCtx.wsId = item.workspace_id;
        filesCtx.canEdit = true;
        filesCtx.stack = [{ id: null, name: 'Workspace' }, { id: item.id, name: item.name }];
      } else {
        filesCtx.mode = 'vault';
        filesCtx.wsId = null;
        filesCtx.canEdit = true;
        filesCtx.stack = [{ id: null, name: 'My Vault' }, { id: item.id, name: item.name }];
      }
      navigate('#files');
    } else {
      request('/storage/vault/' + item.id + '/content', { blob: true }).then(function (blob) {
        saveBlob(blob, item.name);
      }).catch(function (err) { toast(err.message, 'err'); });
    }
  }

  /* ------------------------------------------------------------------ */
  /* Devices page                                                        */
  /* ------------------------------------------------------------------ */

  function renderDevices() {
    $('#view').innerHTML = loading();
    Promise.all([
      request('/auth/devices'),
      request('/auth/security-log'),
    ]).then(function (results) {
      var devices = (results[0] && results[0].devices) || [];
      var logs = (results[1] && results[1].logs) || [];

      var deviceRows = devices.map(function (d) {
        return '<tr><td>' + esc(d.name) + '</td>' +
          '<td>' + esc(d.platform || '--') + ' ' + esc(d.os_version || '') + '</td>' +
          '<td>' + (d.revoked_at ? '<span class="badge bad">revoked</span>' : '<span class="badge ok">active</span>') + '</td>' +
          '<td>' + (d.last_active ? fmtTime(d.last_active) : '--') + '</td>' +
          '<td>' + esc(d.last_ip || '--') + '</td>' +
          '<td class="row-actions">' +
          '<button class="btn small ghost" data-act="rename-device" data-i="' + d.id + '" data-n="' + esc(d.name) + '">Rename</button>' +
          (d.revoked_at ? '' : '<button class="btn small danger" data-act="revoke-device" data-i="' + d.id + '" data-n="' + esc(d.name) + '">Revoke</button>') +
          '</td></tr>';
      }).join('') || '<tr><td colspan="6" class="empty">No devices registered</td></tr>';

      var logRows = logs.map(function (l) {
        return '<tr><td class="mono">' + fmtTime(l.ts) + '</td>' +
          '<td><span class="badge ' + (l.success ? 'ok' : 'bad') + '">' + esc(l.event) + '</span></td>' +
          '<td>' + esc(l.device_name || '--') + '</td>' +
          '<td>' + esc(l.ip || '--') + '</td>' +
          '<td class="dim small break">' + esc(l.user_agent || '') + '</td></tr>';
      }).join('') || '<tr><td colspan="5" class="empty">No security events</td></tr>';

      $('#view').innerHTML = page(
        section('Registered devices',
          '<table class="table"><thead><tr><th>Name</th><th>Platform</th><th>Status</th><th>Last active</th><th>Last IP</th><th></th></tr></thead>' +
          '<tbody>' + deviceRows + '</tbody></table>'
        ) +
        section('Security log',
          '<table class="table"><thead><tr><th>Time</th><th>Event</th><th>Device</th><th>IP</th><th>User agent</th></tr></thead>' +
          '<tbody>' + logRows + '</tbody></table>'
        )
      );
    }).catch(function (err) { $('#view').innerHTML = errHtml(err.message); });
  }

  function renameDevice(el) {
    var id = Number(el.getAttribute('data-i'));
    var oldName = el.getAttribute('data-n') || 'Device';
    var name = window.prompt('New device name:', oldName);
    if (!name) return;
    request('/auth/devices/' + id + '/rename', {
      method: 'POST',
      body: JSON.stringify({ name: name }),
    }).then(function () {
      toast('Device renamed', 'ok');
      renderDevices();
    }).catch(function (err) { toast(err.message, 'err'); });
  }

  function revokeDevice(el) {
    var id = Number(el.getAttribute('data-i'));
    var name = el.getAttribute('data-n') || 'Device';
    if (!confirmAction('Revoke device "' + name + '"? It will no longer be able to sign in.')) return;
    request('/auth/devices/' + id + '/revoke', { method: 'POST' }).then(function () {
      toast('Device revoked', 'ok');
      renderDevices();
    }).catch(function (err) { toast(err.message, 'err'); });
  }

  /* ------------------------------------------------------------------ */
  /* Security page                                                       */
  /* ------------------------------------------------------------------ */

  function renderSecurity() {
    $('#view').innerHTML = loading();
    request('/auth/security-log').then(function (data) {
      var logs = (data && data.logs) || [];
      var logRows = logs.map(function (l) {
        return '<tr><td class="mono">' + fmtTime(l.ts) + '</td>' +
          '<td><span class="badge ' + (l.success ? 'ok' : 'bad') + '">' + esc(l.event) + '</span></td>' +
          '<td>' + esc(l.device_name || '--') + '</td>' +
          '<td>' + esc(l.ip || '--') + '</td>' +
          '<td class="dim small break">' + esc(l.user_agent || '') + '</td></tr>';
      }).join('') || '<tr><td colspan="5" class="empty">No security events</td></tr>';

      var overview = section('Account security',
        '<div class="grid stats">' +
        '<div class="stat"><div class="stat-value">' + esc(me.username) + '</div><div class="stat-label">Username</div></div>' +
        '<div class="stat"><div class="stat-value">' + esc(me.role) + '</div><div class="stat-label">Role</div></div>' +
        '<div class="stat"><div class="stat-value">' + (me.totpEnabled ? 'Enabled' : 'Disabled') + '</div><div class="stat-label">Two-factor auth</div></div>' +
        '</div>' +
        '<p class="dim small" style="margin:12px 0 0">Manage passwords and 2FA from the Settings page.</p>'
      );

      $('#view').innerHTML = page(
        overview +
        section('Security log',
          '<table class="table"><thead><tr><th>Time</th><th>Event</th><th>Device</th><th>IP</th><th>User agent</th></tr></thead>' +
          '<tbody>' + logRows + '</tbody></table>'
        )
      );
    }).catch(function (err) { $('#view').innerHTML = errHtml(err.message); });
  }

  /* ------------------------------------------------------------------ */
  /* Settings page                                                       */
  /* ------------------------------------------------------------------ */

  function renderSettings() {
    $('#view').innerHTML = loading();
    request('/auth/notifications').then(function (data) {
      var notifs = (data && data.notifications) || [];
      var notifRows = notifs.map(function (n) {
        return '<div class="notif-item"><span class="notif-dot' + (n.read ? '' : ' unread') + '"></span>' +
          '<span class="badge ' + (n.level === 'error' ? 'bad' : n.level === 'warning' ? 'warn' : 'info') + '">' + esc(n.level) + '</span>' +
          '<span class="notif-msg">' + esc(n.message) + '</span>' +
          '<span class="feed-time">' + fmtTime(n.created_at) + '</span></div>';
      }).join('') || '<div class="dim small">No notifications</div>';

      var twofa = me.totpEnabled
        ? '<p><span class="badge ok">Enabled</span></p>' +
          '<form id="disable2faForm" class="member-form">' +
          '<input id="disable2faCode" class="input" placeholder="6-digit code" inputmode="numeric" maxlength="6" required>' +
          '<button class="btn danger" type="submit">Disable 2FA</button></form>'
        : '<p class="dim">Two-factor authentication is not enabled.</p>' +
          '<button class="btn primary" data-act="load-2fa">Set up two-factor auth</button>';

      $('#view').innerHTML = page(
        '<div class="grid-2">' +
        section('Change password',
          '<form id="pwForm">' +
          '<div class="field"><label for="pwOld">Current password</label><input id="pwOld" class="input" type="password" autocomplete="current-password" required></div>' +
          '<div class="field"><label for="pwNew">New password</label><input id="pwNew" class="input" type="password" autocomplete="new-password" required></div>' +
          '<div class="field"><label for="pwNew2">Confirm new password</label><input id="pwNew2" class="input" type="password" autocomplete="new-password" required></div>' +
          '<button class="btn primary" type="submit">Change password</button></form>'
        ) +
        section('Two-factor authentication', twofa) +
        '</div>' +
        section('Private folder (encrypted)',
          '<div id="privSection" class="dim">Loading private folder...</div>'
        ) +
        section('Notifications',
          '<button class="btn ghost small" data-act="mark-read" style="margin-bottom:10px">Mark all read</button>' + notifRows
        )
      );

      $('#pwForm').addEventListener('submit', changePassword);
      var d2fa = $('#disable2faForm');
      if (d2fa) d2fa.addEventListener('submit', disable2fa);
      loadPrivateSection();
    }).catch(function (err) { $('#view').innerHTML = errHtml(err.message); });
  }

  function loadPrivateSection() {
    var host = $('#privSection');
    if (!host) return;
    request('/private/status').then(function (data) {
      var st = data && data.status;
      if (!st) { host.innerHTML = '<p class="dim">No private folder.</p>'; return; }
      var lockTxt = st.hasPassword
        ? (privateUnlockToken ? '<span class="badge ok">Unlocked</span>' : '<span class="badge warn">Locked</span>')
        : '<span class="badge info">No password set</span>';
      var encTxt = st.encrypted ? '<span class="badge ok">Encrypted</span>' : '<span class="badge bad">Not encrypted</span>';
      host.innerHTML =
        '<div class="config-list">' +
        '<div class="config-item"><div class="config-key">Folder</div><div class="config-val">' + esc(st.name || 'Private') + ' (N:\\Private\\' + esc(me.username || '') + '\\)</div></div>' +
        '<div class="config-item"><div class="config-key">Status</div><div class="config-val">' + lockTxt + ' ' + encTxt + '</div></div>' +
        '</div>' +
        '<div class="member-form" style="margin-top:10px">' +
        '<input id="privPw" class="input" type="password" placeholder="' + (st.hasPassword ? 'New password (blank = clear)' : 'Set password') + '">' +
        '<button class="btn primary" data-act="priv-set-pw">' + (st.hasPassword ? 'Change' : 'Set password') + '</button>' +
        (st.hasPassword ? '<button class="btn ghost" data-act="priv-unlock">Unlock</button>' : '') +
        '</div>' +
        '<p class="dim small" style="margin-top:8px">Files in your private folder are encrypted on the network drive. Only you and the admin can view them. Each device you connect syncs into this folder.</p>';
    }).catch(function (err) {
      host.innerHTML = '<p class="dim">' + esc(err.message) + '</p>';
    });
  }

  function setPrivatePassword() {
    var pw = $('#privPw') ? $('#privPw').value : '';
    request('/private/password', {
      method: 'POST',
      body: JSON.stringify({ next: pw }),
    }).then(function () {
      privateUnlockToken = null;
      toast(pw ? 'Private folder password set' : 'Private folder password cleared', 'ok');
      loadPrivateSection();
    }).catch(function (err) { toast(err.message, 'err'); });
  }

  function unlockPrivateFolder() {
    var pw = $('#privPw') ? $('#privPw').value : '';
    if (!pw) { toast('Enter the private folder password', 'err'); return; }
    request('/private/unlock', {
      method: 'POST',
      body: JSON.stringify({ password: pw }),
    }).then(function (data) {
      privateUnlockToken = data.token;
      toast('Private folder unlocked', 'ok');
      loadPrivateSection();
    }).catch(function (err) { toast(err.message, 'err'); });
  }

  function changePassword(e) {
    e.preventDefault();
    var oldPw = $('#pwOld').value;
    var newPw = $('#pwNew').value;
    var newPw2 = $('#pwNew2').value;
    if (newPw !== newPw2) { toast('New passwords do not match', 'err'); return; }
    if (newPw.length < 6) { toast('Password must be at least 6 characters', 'err'); return; }
    request('/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({ oldPassword: oldPw, newPassword: newPw }),
    }).then(function () {
      toast('Password changed', 'ok');
      renderSettings();
    }).catch(function (err) { toast(err.message, 'err'); });
  }

  function setup2fa() {
    request('/auth/2fa/setup', { method: 'POST' }).then(function (data) {
      var codes = (data.backupCodes || []).map(function (c) {
        return '<span class="code">' + esc(c) + '</span>';
      }).join('');
      openModal(
        '<h3 class="modal-title">Set up two-factor auth</h3>' +
        '<p class="dim">Scan the code in your authenticator app, or enter the secret manually.</p>' +
        '<div class="secret-box">' + esc(data.secret) + '</div>' +
        '<p class="dim small">App URL:</p>' +
        '<div class="mono break dim">' + esc(data.otpauthUrl) + '</div>' +
        '<p class="dim small" style="margin-top:12px">Backup codes (store these somewhere safe):</p>' +
        '<div class="codes">' + codes + '</div>' +
        '<form id="enable2faForm" class="member-form">' +
        '<input id="enable2faCode" class="input" placeholder="6-digit code" inputmode="numeric" maxlength="6" required>' +
        '<button class="btn primary" type="submit">Enable</button></form>'
      );
      $('#enable2faForm').addEventListener('submit', function (e2) {
        e2.preventDefault();
        var code = $('#enable2faCode').value.trim();
        request('/auth/2fa/enable', { method: 'POST', body: JSON.stringify({ code: code }) }).then(function () {
          closeModal();
          toast('Two-factor authentication enabled', 'ok');
          return reloadMe();
        }).then(function () {
          renderSettings();
        }).catch(function (err) { toast(err.message, 'err'); });
      });
    }).catch(function (err) { toast(err.message, 'err'); });
  }

  function disable2fa(e) {
    e.preventDefault();
    var code = $('#disable2faCode').value.trim();
    request('/auth/2fa/disable', { method: 'POST', body: JSON.stringify({ code: code }) }).then(function () {
      toast('Two-factor authentication disabled', 'ok');
      return reloadMe();
    }).then(function () {
      renderSettings();
    }).catch(function (err) { toast(err.message, 'err'); });
  }

  function markNotifsRead() {
    request('/auth/notifications/read', { method: 'POST' }).then(function () {
      toast('Notifications marked as read', 'ok');
      renderSettings();
    }).catch(function (err) { toast(err.message, 'err'); });
  }

  /* ------------------------------------------------------------------ */
  /* Dashboard (admin)                                                   */
  /* ------------------------------------------------------------------ */

  function scheduleDash() {
    clearInterval(dashTimer);
    if (dashPaused) return;
    dashTimer = setInterval(function () {
      if (currentRoute() === 'dashboard' && !dashLoading) refreshDashboard();
    }, 5000);
  }

  function toggleDashPause() {
    dashPaused = !dashPaused;
    clearInterval(dashTimer);
    var btn = document.querySelector('[data-act="dash-pause"]');
    if (btn) {
      btn.textContent = dashPaused ? 'Resume auto-refresh' : 'Pause auto-refresh';
      btn.className = 'btn ' + (dashPaused ? 'ghost' : 'primary');
    }
    if (!dashPaused) scheduleDash();
  }

  function runBackup() {
    request('/monitor/admin/backup', { method: 'POST' }).then(function (data) {
      toast('Backup created: ' + data.backup + ' (' + fmtBytes(data.size) + ')', 'ok');
    }).catch(function (err) { toast(err.message, 'err'); });
  }

  function shutdownServer() {
    if (!confirmAction('Shut down the server now? You will need to physically press the power button on the laptop to turn it back on.')) return;
    request('/monitor/admin/shutdown', { method: 'POST' }).then(function () {
      toast('Shutting down the server now...', 'ok');
    }).catch(function (err) { toast(err.message, 'err'); });
  }

  function renderDashboard() {
    clearInterval(dashTimer);
    if (!isAdmin()) { renderAdminRequired(); return; }
    if (dashLoading) { scheduleDash(); return; }
    dashLoading = true;
    $('#view').innerHTML = loading();

    Promise.all([
      request('/monitor/dashboard/summary'),
      request('/monitor/admin/config'),
    ]).then(function (results) {
      $('#view').innerHTML = renderDashboardHtml(results[0], results[1]);
      flashDash();
    }).catch(function (err) {
      $('#view').innerHTML = errHtml(err.message);
    }).then(function () {
      dashLoading = false;
      scheduleDash();
    });
  }

  function refreshDashboard() {
    if (!isAdmin() || currentRoute() !== 'dashboard') return;
    request('/monitor/dashboard/summary').then(function (summary) {
      patchDashboard(summary);
    }).catch(function () {});
  }

  function flashDash() {
    var live = document.querySelector('.dash-live');
    if (live) {
      live.classList.add('flash');
      setTimeout(function () { if (live) live.classList.remove('flash'); }, 600);
    }
  }

  function renderDashboardHtml(summary, cfg) {
    return page(
      '<div class="dash-actions card">' +
      '<div class="dash-actions-left">' +
      '<span class="dash-live"><i class="live-dot"></i>LIVE</span>' +
      '<span class="dash-last dim small">Last refresh ' + fmtClock(summary.server && summary.server.time) + (dashPaused ? ' - paused' : ' - 5s') + '</span>' +
      '</div>' +
      '<div class="dash-actions-right">' +
      '<button class="btn ghost" data-act="dash-pause">' + (dashPaused ? 'Resume auto-refresh' : 'Pause auto-refresh') + '</button>' +
      '<button class="btn primary" data-act="run-backup">Run backup now</button>' +
      '<button class="btn danger" data-act="shutdown-server">Shut down server</button>' +
      '</div></div>' +
      section('Server', '<div id="dash-server">' + serverHtml(summary.server) + '</div>') +
      section('Gateway nodes', '<div id="dash-nodes">' + nodesHtml(summary) + '</div>') +
      section('Active transfers',
        '<table class="table"><thead><tr><th>Job</th><th>Direction</th><th>Progress</th><th>Node</th><th>User</th></tr></thead>' +
        '<tbody id="dash-transfers-active">' + activeRowsHtml(summary.transfers) + '</tbody></table>'
      ) +
      section('Recent failed transfers',
        '<table class="table"><thead><tr><th>Job</th><th>Direction</th><th>Error</th><th>Node</th><th>User</th><th>Time</th></tr></thead>' +
        '<tbody id="dash-transfers-failed">' + failedRowsHtml(summary.transfers) + '</tbody></table>'
      ) +
      section('Storage and counts', '<div id="dash-counts">' + countsHtml(summary) + '</div>') +
      section('Recent activity', '<div id="dash-feed">' + feedHtml(summary) + '</div>') +
      section('Server config', '<div class="config-list">' + configHtml(cfg) + '</div>')
    );
  }

  function patchDashboard(summary) {
    var s = summary.server || {};
    var ds = $('#dash-server');
    if (ds) ds.innerHTML = serverHtml(s);
    var dn = $('#dash-nodes');
    if (dn) dn.innerHTML = nodesHtml(summary);
    var ta = $('#dash-transfers-active');
    if (ta) ta.innerHTML = activeRowsHtml(summary.transfers);
    var tf = $('#dash-transfers-failed');
    if (tf) tf.innerHTML = failedRowsHtml(summary.transfers);
    var dc = $('#dash-counts');
    if (dc) dc.innerHTML = countsHtml(summary);
    var df = $('#dash-feed');
    if (df) df.innerHTML = feedHtml(summary);
    var last = document.querySelector('.dash-last');
    if (last) last.textContent = 'Last refresh ' + fmtClock(s.time) + (dashPaused ? ' - paused' : ' - 5s');
    flashDash();
  }

  function serverHtml(s) {
    s = s || {};
    var ram = s.ram || {};
    var disk = s.storage || {};

    return '<div class="grid stats">' +
      stat('Hostname', maskedHtml(esc(s.hostname || '--'))) +
      stat('Platform', esc(s.platform || '--')) +
      stat('Architecture', esc(s.arch || '--')) +
      stat('Uptime', fmtDur(s.uptime)) +
      '</div>' +
      '<div class="grid stats">' +
      stat('CPU', (s.cpu != null ? s.cpu.toFixed(1) : '--') + '%', s.cpu) +
      stat('Cores', String(s.cpuCount != null ? s.cpuCount : '--')) +
      stat('Load (1/5/15)', (function () {
        var l = s.load || {};
        return (l.one != null ? l.one.toFixed(2) : '--') + ' / ' +
          (l.five != null ? l.five.toFixed(2) : '--') + ' / ' +
          (l.fifteen != null ? l.fifteen.toFixed(2) : '--');
      })()) +
      stat('Temperature', s.temp != null ? s.temp.toFixed(0) + ' C' : '--') +
      '</div>' +
      '<div class="grid stats">' +
      stat('RAM used', fmtBytes(ram.used) + ' / ' + fmtBytes(ram.total), pct(ram.used, ram.total)) +
      stat('RAM free', fmtBytes(ram.free)) +
      stat('RAM cached', fmtBytes(ram.cached)) +
      stat('Swap used', fmtBytes(ram.swapUsed) + ' / ' + fmtBytes(ram.swapTotal), pct(ram.swapUsed, ram.swapTotal)) +
      '</div>' +
      '<div class="grid stats">' +
      stat('Storage free', fmtBytes(disk.free) + ' / ' + fmtBytes(disk.total), pct(disk.free, disk.total)) +
      stat('Network in', fmtRate(s.net ? s.net.rxBytesPerSec : 0)) +
      stat('Network out', fmtRate(s.net ? s.net.txBytesPerSec : 0)) +
      stat('LAN addresses', maskedHtml(esc((s.addresses || []).join(', ') || '--'))) +
      '</div>' +
      (s.battery && s.battery.present ?
        '<div class="grid stats">' +
        stat('Battery', (s.battery.percent != null ? s.battery.percent + '%' : '--')) +
        stat('Battery status', esc(s.battery.status || '--')) +
        stat('Battery temp', s.battery.tempC != null ? s.battery.tempC.toFixed(1) + ' C' : '--') +
        '</div>' : '') +
      perCoreCpuHtml(s) +
      mountsHtml(s) +
      thermalHtml(s) +
      topProcHtml(s.processes);
  }

  function nodesHtml(summary) {
    var nodes = (summary.nodes || []).map(function (n) {
      var status = n.status === 'online'
        ? '<span class="badge ok">online</span>'
        : '<span class="badge bad">offline</span>';
      var inFlight = '';
      if (n.currentTransfer) {
        var t = n.currentTransfer;
        inFlight = '<div class="inflight"><div class="dim small">' + esc(t.job_id) + ' - ' + esc(t.direction) + '</div>' +
          bar(pct(t.bytes_done, t.total_bytes)) +
          '<div class="small dim">' + fmtBytes(t.bytes_done) + ' / ' + fmtBytes(t.total_bytes) + '</div></div>';
      }
      return '<div class="node-card card">' +
        '<div class="node-head"><span class="node-name">' + esc(n.name) + '</span>' + status + '</div>' +
        '<div class="dim small">' + esc(n.model || '') + ' - last seen ' + fmtTime(n.lastSeen) + '</div>' +
        '<div class="node-grid">' +
        kpi('Battery', (n.battery != null ? n.battery + '%' : '--'), n.charging ? 'charging' : '') +
        kpi('CPU', (n.cpu != null ? n.cpu.toFixed(1) + '%' : '--')) +
        kpi('Temp', (n.temp != null ? n.temp.toFixed(0) + ' C' : '--')) +
        kpi('Net speed', fmtRate(n.netSpeed)) +
        kpi('Latency', (n.latency != null ? n.latency.toFixed(0) + ' ms' : '--')) +
        kpi('Score', (n.score != null ? n.score.toFixed(2) : '--')) +
        kpi('Active transfers', n.activeTransfers != null ? String(n.activeTransfers) : '0') +
        kpi('Storage free', fmtBytes(n.storageFree)) +
        kpi('RAM free', fmtBytes(n.ramAvailable) + ' / ' + fmtBytes(n.ramTotal)) +
        '</div>' + inFlight + '</div>';
    }).join('') || '<div class="card note"><p class="dim">No gateway nodes registered.</p></div>';
    return '<div class="nodes-grid">' + nodes + '</div>';
  }

  function activeRowsHtml(transfers) {
    transfers = transfers || {};
    var rows = (transfers.active || []).map(function (t) {
      return '<tr><td class="mono">' + esc(t.job_id) + '</td>' +
        '<td><span class="badge ' + (t.direction === 'upload' ? 'info' : 'ok') + '">' + esc(t.direction) + '</span></td>' +
        '<td><div style="min-width:120px">' + bar(pct(t.bytes_done, t.total_bytes)) + '</div>' +
        '<span class="small dim">' + fmtBytes(t.bytes_done) + ' / ' + fmtBytes(t.total_bytes) + '</span></td>' +
        '<td>' + esc(t.node_name || '--') + '</td>' +
        '<td>' + maskedHtml(esc(t.username || '--')) + '</td></tr>';
    }).join('') || '<tr><td colspan="5" class="empty">No active transfers</td></tr>';
    return rows;
  }

  function failedRowsHtml(transfers) {
    transfers = transfers || {};
    var rows = (transfers.recentFailed || []).map(function (t) {
      return '<tr><td class="mono">' + esc(t.job_id) + '</td>' +
        '<td><span class="badge ' + (t.direction === 'upload' ? 'info' : 'ok') + '">' + esc(t.direction) + '</span></td>' +
        '<td class="dim">' + esc(t.error || '--') + '</td>' +
        '<td>' + esc(t.node_name || '--') + '</td>' +
        '<td>' + maskedHtml(esc(t.username || '--')) + '</td>' +
        '<td>' + fmtTime(t.updated_at) + '</td></tr>';
    }).join('') || '<tr><td colspan="6" class="empty">No recent failures</td></tr>';
    return rows;
  }

  function countsHtml(summary) {
    var files = summary.files || {};
    var counts = summary.counts || {};
    return '<div class="grid stats">' +
      stat('Files', String(files.count != null ? files.count : 0)) +
      stat('Total bytes', fmtBytes(files.totalBytes)) +
      stat('Users', String(counts.users != null ? counts.users : 0)) +
      stat('Devices', String(counts.devices != null ? counts.devices : 0)) +
      stat('Workspaces', String(counts.workspaces != null ? counts.workspaces : 0)) +
      '</div>';
  }

  function feedHtml(summary) {
    return (summary.recentActivity || []).map(function (a) {
      var cls = a.level === 'error' ? 'bad' : a.level === 'warning' ? 'warn' : 'info';
      return '<div class="feed-item"><span class="badge ' + cls + '">' + esc(a.level) + '</span>' +
        '<span class="feed-msg">' + esc(a.message) + '</span>' +
        '<span class="feed-time">' + fmtTime(a.created_at) + '</span></div>';
    }).join('') || '<div class="dim">No recent activity</div>';
  }

  function configHtml(cfg) {
    return Object.keys(cfg || {}).map(function (k) {
      return '<div class="config-item"><div class="config-key">' + esc(k) + '</div><div class="config-val">' + maskedHtml(esc(cfg[k])) + '</div></div>';
    }).join('');
  }

  function stat(label, value, barPct) {
    var barHtml = (barPct != null) ? bar(pct(barPct, 100)) : '';
    return '<div class="stat"><div class="stat-value">' + value + '</div><div class="stat-label">' + esc(label) + '</div>' + barHtml + '</div>';
  }

  function kpi(label, value, extra) {
    return '<div class="kpi"><span class="kpi-v">' + value + '</span>' +
      '<span class="kpi-l">' + esc(label) + (extra ? ' (' + esc(extra) + ')' : '') + '</span></div>';
  }

  function perCoreCpuHtml(s) {
    var cores = s.cpuPerCore || [];
    if (!cores.length) return '';
    var row = cores.map(function (c) {
      return '<div class="core-cell"><div class="core-pct">' + c.toFixed(0) + '%</div>' + bar(pct(c, 100)) + '</div>';
    }).join('');
    return '<div class="section-block"><h4>CPU per core</h4><div class="core-grid">' + row + '</div></div>';
  }

  function mountsHtml(s) {
    var mounts = s.mounts || [];
    if (!mounts.length) return '';
    var rows = mounts.map(function (m) {
      return '<div class="stat"><div class="stat-value">' + fmtBytes(m.free) + ' / ' + fmtBytes(m.total) + '</div>' +
        '<div class="stat-label">' + esc(m.mount) + '</div>' + bar(pct(m.free, m.total)) + '</div>';
    }).join('');
    return '<div class="section-block"><h4>Disks</h4><div class="grid stats">' + rows + '</div></div>';
  }

  function thermalHtml(s) {
    var zones = s.thermal || [];
    if (!zones.length) return '';
    var rows = zones.map(function (z) {
      return '<div class="stat"><div class="stat-value">' + (z.tempC != null ? z.tempC.toFixed(1) + ' C' : '--') + '</div>' +
        '<div class="stat-label">' + esc(z.type || z.id) + '</div></div>';
    }).join('');
    return '<div class="section-block"><h4>Temperature sensors</h4><div class="grid stats">' + rows + '</div></div>';
  }

  function topProcHtml(procs) {
    if (!procs || !procs.length) return '';
    var rows = procs.map(function (p) {
      return '<tr><td class="mono">' + p.pid + '</td><td>' + esc(p.name) + '</td>' +
        '<td>' + p.cpu.toFixed(1) + '%</td><td>' + fmtBytes(p.mem) + '</td></tr>';
    }).join('');
    return '<div class="section-block"><h4>Top processes by CPU</h4>' +
      '<table class="table"><thead><tr><th>PID</th><th>Name</th><th>CPU</th><th>RSS</th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table></div>';
  }

  /* ------------------------------------------------------------------ */
  /* Admin pages                                                         */
  /* ------------------------------------------------------------------ */

  function renderUsers() {
    $('#view').innerHTML = loading();
    request('/monitor/admin/users').then(function (data) {
      var rows = (data.users || []).map(function (u) {
        return '<tr><td>' + u.id + '</td><td>' + esc(u.username) + '</td>' +
          '<td>' + esc(u.display_name || '--') + '</td>' +
          '<td><span class="badge ' + (u.role === 'admin' ? 'accent' : 'info') + '">' + esc(u.role) + '</span></td>' +
          '<td>' + (u.totp_enabled ? '<span class="badge ok">yes</span>' : '<span class="badge">no</span>') + '</td>' +
          '<td>' + fmtTime(u.created_at) + '</td>' +
          '<td>' + fmtTime(u.updated_at) + '</td></tr>';
      }).join('') || '<tr><td colspan="7" class="empty">No users</td></tr>';

      $('#view').innerHTML = page(section('Users',
        '<table class="table"><thead><tr><th>ID</th><th>Username</th><th>Display name</th><th>Role</th><th>2FA</th><th>Created</th><th>Updated</th></tr></thead>' +
        '<tbody>' + rows + '</tbody></table>'
      ));
    }).catch(function (err) { $('#view').innerHTML = errHtml(err.message); });
  }

  function renderStorage() {
    $('#view').innerHTML = loading();
    request('/monitor/admin/storage').then(function (data) {
      var byUser = (data.byUser || []).map(function (r) {
        return '<tr><td>' + (r.owner_id != null ? r.owner_id : '--') + '</td><td>' + esc(r.username || '--') + '</td>' +
          '<td>' + (r.files != null ? r.files : 0) + '</td><td>' + fmtBytes(r.bytes) + '</td></tr>';
      }).join('') || '<tr><td colspan="4" class="empty">No personal files</td></tr>';

      var byWs = (data.byWorkspace || []).map(function (r) {
        return '<tr><td>' + (r.workspace_id != null ? r.workspace_id : '--') + '</td><td>' + esc(r.name || '--') + '</td>' +
          '<td>' + (r.files != null ? r.files : 0) + '</td><td>' + fmtBytes(r.bytes) + '</td></tr>';
      }).join('') || '<tr><td colspan="4" class="empty">No workspace files</td></tr>';

      $('#view').innerHTML = page(
        '<div class="grid-2">' +
        section('Storage by user',
          '<table class="table"><thead><tr><th>User ID</th><th>Username</th><th>Files</th><th>Bytes</th></tr></thead><tbody>' + byUser + '</tbody></table>'
        ) +
        section('Storage by workspace',
          '<table class="table"><thead><tr><th>Workspace ID</th><th>Name</th><th>Files</th><th>Bytes</th></tr></thead><tbody>' + byWs + '</tbody></table>'
        ) +
        '</div>'
      );
    }).catch(function (err) { $('#view').innerHTML = errHtml(err.message); });
  }

  function renderNodes() {
    $('#view').innerHTML = loading();
    request('/monitor/admin/nodes').then(function (data) {
      var rows = (data.nodes || []).map(function (n) {
        return '<tr><td>' + n.id + '</td><td>' + esc(n.name) + '</td>' +
          '<td>' + esc(n.model || '--') + '</td>' +
          '<td>' + esc(n.os_version || '--') + '</td>' +
          '<td><span class="badge ' + (n.status === 'online' ? 'ok' : 'bad') + '">' + esc(n.status || 'offline') + '</span></td>' +
          '<td>' + fmtTime(n.last_seen) + '</td>' +
          '<td>' + esc(n.lan_ip || '--') + ':' + esc(n.lan_port != null ? n.lan_port : '') + '</td>' +
          '<td>' + (n.active_transfers != null ? n.active_transfers : 0) + '</td>' +
          '<td>' + fmtTime(n.created_at) + '</td></tr>';
      }).join('') || '<tr><td colspan="9" class="empty">No gateway nodes registered</td></tr>';

      $('#view').innerHTML = page(section('Gateway nodes',
        '<table class="table"><thead><tr><th>ID</th><th>Name</th><th>Model</th><th>OS</th><th>Status</th><th>Last seen</th><th>LAN</th><th>Active</th><th>Registered</th></tr></thead>' +
        '<tbody>' + rows + '</tbody></table>'
      ));
    }).catch(function (err) { $('#view').innerHTML = errHtml(err.message); });
  }

  function renderActivity() {
    $('#view').innerHTML = loading();
    request('/monitor/admin/activity').then(function (data) {
      var items = (data.activity || []).map(function (a) {
        var cls = a.level === 'error' ? 'bad' : a.level === 'warning' ? 'warn' : 'info';
        return '<div class="feed-item"><span class="badge ' + cls + '">' + esc(a.level) + '</span>' +
          '<span class="feed-msg">' + esc(a.message) + '</span>' +
          '<span class="feed-time">' + fmtTime(a.created_at) + '</span></div>';
      }).join('') || '<div class="dim">No activity recorded</div>';

      $('#view').innerHTML = page(section('Activity log', items));
    }).catch(function (err) { $('#view').innerHTML = errHtml(err.message); });
  }

  /* ------------------------------------------------------------------ */
  /* Global listeners + boot                                              */
  /* ------------------------------------------------------------------ */

  document.addEventListener('change', function (e) {
    if (e.target && e.target.id === 'fileInput') {
      handleFilesSelected(e.target.files);
      e.target.value = '';
    }
  });

  document.addEventListener('input', function (e) {
    if (e.target && e.target.id === 'memberInput') {
      clearTimeout(memberDebounce);
      memberDebounce = setTimeout(function () { userSearch(e.target.value); }, 250);
    }
  });

  $('#loginForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var u = $('#loginUser').value.trim();
    var p = $('#loginPass').value;
    $('#loginErr').textContent = '';
    startLogin(u, p).catch(function (err) {
      $('#loginErr').textContent = err.message;
    });
  });

  $('#registerForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var u = $('#regUser').value.trim();
    var n = $('#regName').value.trim();
    var p = $('#regPass').value;
    $('#loginErr').textContent = '';
    fetchJson('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ username: u, password: p, displayName: n || undefined }),
    }).then(function () {
      $('#loginErr').textContent = 'Account created. Sign in with your new credentials.';
      $('#loginErr').className = 'login-err ok';
      showLoginForm();
      $('#loginUser').value = u;
      $('#loginPass').value = '';
      $('#loginPass').focus();
    }).catch(function (err) {
      $('#loginErr').textContent = err.message;
    });
  });

  $('#showRegister').addEventListener('click', function (e) {
    e.preventDefault();
    showRegisterForm();
  });

  $('#showLogin').addEventListener('click', function (e) {
    e.preventDefault();
    showLoginForm();
  });

  function showLoginForm() {
    $('#loginForm').classList.remove('hidden');
    $('#registerForm').classList.add('hidden');
  }

  function showRegisterForm() {
    $('#loginForm').classList.add('hidden');
    $('#registerForm').classList.remove('hidden');
  }

  $('#mfaForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var code = $('#mfaCode').value.trim();
    if (!grantToken) return;
    $('#loginErr').textContent = '';
    fetchJson('/auth/mfa', {
      method: 'POST',
      body: JSON.stringify({ grantToken: grantToken, code: code }),
    }).then(function (data) {
      return finishLogin(data.grantToken);
    }).catch(function (err) {
      $('#loginErr').textContent = err.message;
    });
  });

  $('#logoutBtn').addEventListener('click', logout);

  $('#menuBtn').addEventListener('click', openSidebar);
  $('#scrim').addEventListener('click', closeSidebar);
  $('#modalClose').addEventListener('click', closeModal);
  $('#modalBackdrop').addEventListener('click', closeModal);

  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      closeModal();
      closeSidebar();
    }
  });

  window.addEventListener('hashchange', route);

  function bootstrap() {
    if (localStorage.getItem(LS_ACCESS)) {
      reloadMe().then(function () {
        showApp();
        route();
      }).catch(function () {
        showLogin();
      });
    } else {
      showLogin();
    }
  }

  bootstrap();
})();
