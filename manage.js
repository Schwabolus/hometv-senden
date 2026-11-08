// HomeTV "Mit Handy verwalten": the phone side of the session started on the device. Same protocol as HomeSecurity
// sealManage/openManage in core/security.js: AES-256-GCM, AAD "HomeTV-Manage-v1|<topic>|<dir>", "u" phone -> device,
// "d" device -> phone, message "v1.<iv>.<ciphertext>" (base64url), JSON {s:<rising number>, t:<type>, ...}.
// Titles arrive as plain text with short numbers; everything is shown with textContent only.
(function () {
  'use strict';
  var params = {};
  location.hash.replace(/^#/, '').split('&').forEach(function (part) { var i = part.indexOf('='); if (i > 0) params[part.slice(0, i)] = decodeURIComponent(part.slice(i + 1)); });
  if (location.hash) history.replaceState(null, '', location.pathname);
  // Mobile browsers reload tabs in the background: the session survives in this tab only (sessionStorage).
  var saved = null; try { saved = JSON.parse(sessionStorage.getItem('hometv-manage') || 'null'); } catch (_) {}
  var topic = /^hometv-[0-9a-f]{32}$/.test(params.t || '') ? params.t : saved && saved.t, key = /^[A-Za-z0-9_-]{43}$/.test(params.k || '') ? params.k : saved && saved.k;
  var $ = function (id) { return document.getElementById(id); };
  var status = $('status');
  function say(text) { status.textContent = text; }
  if (!topic || !key || !/^hometv-[0-9a-f]{32}$/.test(topic) || !/^[A-Za-z0-9_-]{43}$/.test(key) || !window.crypto || !crypto.subtle || !window.EventSource) { say('Bitte am Fernseher unter „Liste verwalten“ → „Mit Handy verwalten“ den QR-Code scannen.'); return; }
  try { sessionStorage.setItem('hometv-manage', JSON.stringify({t:topic, k:key})); } catch (_) {}

  var seq = Date.now(), peer = 0, pending = {}, lists = [], openList = null, source = null, ended = false, cryptoKey = null;
  function b64url(bytes) { var s = ''; bytes.forEach(function (b) { s += String.fromCharCode(b); }); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
  function fromB64url(text) { var t = text.replace(/-/g, '+').replace(/_/g, '/'); while (t.length % 4) t += '='; return Uint8Array.from(atob(t), function (c) { return c.charCodeAt(0); }); }
  function aad(dir) { return new TextEncoder().encode('HomeTV-Manage-v1|' + topic + '|' + dir); }
  function keyFor() { return cryptoKey || (cryptoKey = crypto.subtle.importKey('raw', fromB64url(key), {name:'AES-GCM'}, false, ['encrypt', 'decrypt'])); }
  function toast(text) {
    var t = $('toast'); if (!t) { t = document.createElement('div'); t.id = 'toast'; t.setAttribute('role', 'status'); document.body.appendChild(t); }
    t.textContent = text; t.hidden = false; clearTimeout(toast.timer); toast.timer = setTimeout(function () { t.hidden = true; }, 3500);
  }
  // Sends a command; the answer of the device (same number in "r") goes to then().
  function send(message) {
    if (ended) return Promise.reject(Error('Verbindung beendet.'));
    message.s = ++seq;
    var number = message.s, iv = crypto.getRandomValues(new Uint8Array(12));
    var answer = new Promise(function (resolve, reject) { pending[number] = {resolve:resolve, reject:reject}; setTimeout(function () { if (pending[number]) { delete pending[number]; reject(Error('Der Fernseher antwortet nicht. Ist HomeTV noch offen?')); } }, 30000); });
    return keyFor().then(function (k) { return crypto.subtle.encrypt({name:'AES-GCM', iv:iv, additionalData:aad('u')}, k, new TextEncoder().encode(JSON.stringify(message))); })
      .then(function (sealed) { return fetch('https://ntfy.sh/' + topic, {method:'POST', body:'v1.' + b64url(iv) + '.' + b64url(new Uint8Array(sealed)), credentials:'omit', cache:'no-store', referrerPolicy:'no-referrer'}); })
      .then(function (response) { if (!response.ok) throw Error('Senden nicht möglich (' + response.status + ').'); return answer; });
  }
  function act(message, done) { return send(message).then(function (reply) { if (done) done(reply); return reply; }).catch(function (e) { toast(e.message); }); }
  function receive(text) {
    var event; try { event = JSON.parse(text); } catch (_) { return; }
    var parts = event && typeof event.message === 'string' ? event.message.split('.') : [];
    if (parts.length !== 3 || parts[0] !== 'v1') return;
    keyFor().then(function (k) { return crypto.subtle.decrypt({name:'AES-GCM', iv:fromB64url(parts[1]), additionalData:aad('d')}, k, fromB64url(parts[2])); }).then(function (plain) {
      var d = JSON.parse(new TextDecoder().decode(plain));
      if (!d || typeof d.s !== 'number' || d.s <= peer) return; peer = d.s;
      if (d.t === 'bye') { finish('Der Fernseher hat die Verbindung beendet.'); return; }
      if (d.t === 'state') showState(d);
      var waiting = pending[d.r]; if (waiting) { delete pending[d.r]; if (d.t === 'error') waiting.reject(Error(d.msg || 'Fehler am Fernseher.')); else waiting.resolve(d); }
    }).catch(function () { /* own messages ("u") and foreign ones do not decrypt */ });
  }
  function finish(text) {
    ended = true; if (source) source.close(); try { sessionStorage.removeItem('hometv-manage'); } catch (_) {}
    ['tabs', 'search', 'favorites', 'resume', 'end'].forEach(function (id) { $(id).hidden = true; }); say(text);
  }

  // --- Views
  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; }
  function button(text, cls, label, onclick) { var b = el('button', cls, text); b.type = 'button'; if (label) b.setAttribute('aria-label', label); b.onclick = onclick; return b; }
  function row(item, buttons) {
    var li = el('li'), text = el('span', 'text'); text.appendChild(el('span', 'title', item.n)); if (item.g) text.appendChild(el('span', 'sub', item.g));
    li.appendChild(text); buttons.forEach(function (b) { li.appendChild(b); }); return li;
  }
  function playButton(item) { return button('▶', 'play', item.n + ' am Fernseher abspielen', function () { act({t:'play', k:item.k}, function (r) { toast(r.msg || 'Läuft am Fernseher.'); }); }); }
  function showState(d) {
    lists = Array.isArray(d.lists) ? d.lists : [];
    var select = $('favTarget'), chosen = select.value; select.textContent = '';
    lists.forEach(function (list) { var o = el('option', '', list.n + ' (' + list.c + ')'); o.value = list.n; select.appendChild(o); });
    if (!lists.length) { var none = el('option', '', 'Erst unter „Favoriten“ eine Liste anlegen'); none.value = ''; select.appendChild(none); }
    select.value = chosen && lists.some(function (l) { return l.n === chosen; }) ? chosen : (lists.length ? lists[0].n : '');
    var host = $('lists'); host.textContent = '';
    lists.forEach(function (list) { host.appendChild(row({n:list.n, g:list.c + (list.c === 1 ? ' Sender' : ' Sender')}, [button('Öffnen', '', 'Liste ' + list.n + ' öffnen', function () { showList(list.n, 0); })])); });
    var resume = $('resumeItems'); resume.textContent = '';
    (d.resume || []).forEach(function (item) { resume.appendChild(row(item, [playButton(item), button('✕', '', item.n + ' aus Weiterschauen entfernen', function () { act({t:'resume-remove', k:item.k}, function () { toast('„' + item.n + '“ entfernt.'); }); })])); });
    $('resumeEmpty').hidden = !!(d.resume && d.resume.length);
    if (openList && !lists.some(function (l) { return l.n === openList; })) closeList();
    else if (openList) showList(openList, 0, true);
  }
  function showList(name, offset, quiet) {
    openList = name; $('lists').hidden = true; $('newList').hidden = true; $('listView').hidden = false; $('listTitle').textContent = name; if (!quiet) $('rename').value = name;
    act({t:'list', n:name, o:offset}, function (d) {
      var host = $('listItems'); if (!offset) host.textContent = '';
      d.items.forEach(function (item) {
        host.appendChild(row(item, [playButton(item),
          button('▲', '', item.n + ' nach oben', function () { act({t:'fav-move', n:name, k:item.k, d:-1}); }),
          button('▼', '', item.n + ' nach unten', function () { act({t:'fav-move', n:name, k:item.k, d:1}); }),
          button('✕', '', item.n + ' aus der Liste entfernen', function () { act({t:'fav-remove', n:name, k:item.k}); })]));
      });
      var shown = offset + d.items.length; $('moreItems').hidden = shown >= d.total;
      $('moreItems').onclick = function () { showList(name, shown, true); };
      if (!d.total) host.appendChild(el('li', 'sub', 'Noch leer. Unter „Suchen“ Sender hinzufügen.'));
    });
  }
  function closeList() { openList = null; $('listView').hidden = true; $('lists').hidden = false; $('newList').hidden = false; }

  // --- Controls
  Array.prototype.forEach.call(document.querySelectorAll('#tabs button'), function (b) {
    b.onclick = function () {
      Array.prototype.forEach.call(document.querySelectorAll('#tabs button'), function (o) { o.className = o === b ? 'on' : ''; });
      ['search', 'favorites', 'resume'].forEach(function (id) { $(id).hidden = id !== b.getAttribute('data-tab'); });
    };
  });
  $('searchForm').onsubmit = function (e) {
    e.preventDefault(); var q = $('query').value.trim(); if (q.length < 2) { toast('Mindestens 2 Zeichen.'); return; }
    var host = $('results'); host.textContent = ''; host.appendChild(el('li', 'sub', 'Suche …'));
    act({t:'search', q:q, scope:$('onlyTv').checked ? 'tv' : 'all'}, function (d) {
      host.textContent = '';
      if (!d.items.length) host.appendChild(el('li', 'sub', 'Nichts gefunden.'));
      d.items.forEach(function (item) {
        var buttons = [playButton(item)];
        if (item.y === 'tv') buttons.push(button('☆', '', item.n + ' zur Favoritenliste', function () {
          var list = $('favTarget').value; if (!list) { toast('Zuerst unter „Favoriten“ eine Liste anlegen.'); return; }
          act({t:'fav-add', n:list, k:item.k}, function () { toast('„' + item.n + '“ zu „' + list + '“ hinzugefügt.'); });
        }));
        host.appendChild(row(item, buttons));
      });
      if (d.more) host.appendChild(el('li', 'sub', 'Weitere Treffer – Suche genauer eingeben.'));
    });
  };
  $('newList').onsubmit = function (e) { e.preventDefault(); var name = $('newName').value.trim(); if (!name) return; act({t:'fav-create', n:name}, function () { $('newName').value = ''; toast('Liste „' + name + '“ angelegt.'); }); };
  $('listBack').onclick = closeList;
  $('renameDo').onclick = function () { var to = $('rename').value.trim(), from = openList; if (!to || !from || to === from) return; act({t:'fav-rename', n:from, to:to}, function () { openList = to; $('listTitle').textContent = to; toast('Umbenannt.'); }); };
  $('deleteList').onclick = function () { var name = openList; if (!name || !confirm('Liste „' + name + '“ löschen? Die Sender selbst bleiben.')) return; act({t:'fav-delete', n:name}, function () { closeList(); toast('Liste gelöscht.'); }); };
  $('end').onclick = function () { send({t:'bye'}).catch(function () {}); setTimeout(function () { finish('Verbindung beendet. Diese Seite kann geschlossen werden.'); }, 300); };

  // --- Connection: an event stream from the relay (from the start of this session) and a hello to the device.
  var since = Math.floor(Date.now() / 1000) - 60;
  source = new EventSource('https://ntfy.sh/' + topic + '/sse?since=' + since);
  source.onmessage = function (e) { receive(e.data); };
  source.onerror = function () { if (!ended) say('Verbindung wackelt, versuche erneut …'); };
  send({t:'hello'}).then(function () {
    say('Mit dem Fernseher verbunden.'); $('tabs').hidden = false; $('search').hidden = false; $('end').hidden = false;
  }).catch(function (e) { say(e.message + ' Am Fernseher den QR-Code neu anzeigen und erneut scannen.'); });
})();
