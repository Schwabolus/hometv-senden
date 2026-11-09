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
  var kind = 'tv', openCat = null, lastSearch = null, lastId = null, reconnects = 0;
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
    var waiting = {}, answer = new Promise(function (resolve, reject) { waiting.reject = reject; pending[number] = {resolve:resolve, reject:reject}; });
    answer.catch(function () {});
    return keyFor().then(function (k) { return crypto.subtle.encrypt({name:'AES-GCM', iv:iv, additionalData:aad('u')}, k, new TextEncoder().encode(JSON.stringify(message))); })
      .then(function (sealed) { return post('v1.' + b64url(iv) + '.' + b64url(new Uint8Array(sealed)), 0); })
      .then(function () {
        // The wait for the answer starts once the message is at the relay (not during pauses of the relay).
        setTimeout(function () { if (pending[number]) { delete pending[number]; waiting.reject(Error('Der Fernseher antwortet nicht. Ist HomeTV noch offen?')); } }, 30000);
        return answer;
      }, function (e) { delete pending[number]; throw e; });
  }
  // "?tags=u" lets the device wait only for the phone's messages (fewer requests). ntfy.sh answers 429 when the home
  // connection (phone and TV share it) asks too often: wait (Retry-After if readable, else 5, 10, 20 s) and send again.
  function pause(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }
  function post(body, attempt) {
    return fetch('https://ntfy.sh/' + topic + '?tags=u', {method:'POST', body:body, credentials:'omit', cache:'no-store', referrerPolicy:'no-referrer'}).then(function (response) {
      if (response.ok) return;
      if (response.status === 429 && attempt < 3 && !ended) {
        var header = response.headers && typeof response.headers.get === 'function' ? Number(response.headers.get('Retry-After')) : NaN;
        var ms = header > 0 && header <= 60 ? header * 1000 : 5000 * Math.pow(2, attempt);
        toast('Übertragungsdienst bremst kurz, neuer Versuch in ' + Math.round(ms / 1000) + ' s …');
        return pause(ms).then(function () { return post(body, attempt + 1); });
      }
      throw Error(response.status === 429 ? 'Der Übertragungsdienst bremst gerade (zu viele Anfragen). Bitte eine Minute warten und dann erneut versuchen.' : 'Senden nicht möglich (' + response.status + ').');
    });
  }
  function act(message, done) { return send(message).then(function (reply) { if (reply && reply.msg) toast(reply.msg); if (done) done(reply); return reply; }).catch(function (e) { toast(e.message); }); }
  function receive(text) {
    var event; try { event = JSON.parse(text); } catch (_) { return; }
    if (event && typeof event.id === 'string' && /^[A-Za-z0-9]{6,32}$/.test(event.id)) lastId = event.id;
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
    ['tabs', 'targetBar', 'search', 'categories', 'favorites', 'resume', 'end'].forEach(function (id) { $(id).hidden = true; }); say(text);
  }

  // --- Building blocks
  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; }
  function button(text, cls, label, onclick) { var b = el('button', cls, text); b.type = 'button'; if (label) b.setAttribute('aria-label', label); b.onclick = onclick; return b; }
  function textBlock(title, sub, tag) { var t = el(tag || 'span', 'text'); t.appendChild(el('span', 'title', title)); if (sub) t.appendChild(el('span', 'sub', sub)); return t; }
  function row(item, buttons) { var li = el('li'); li.appendChild(textBlock(item.n, item.g)); buttons.forEach(function (b) { li.appendChild(b); }); return li; }
  function target() { return $('favTarget').value; }
  function playButton(item) { return button('▶', 'play', item.n + ' am Fernseher abspielen', function () { act({t:'play', k:item.k}); }); }
  // ☆ adds a channel to the chosen list, ★ (already in it) removes it again.
  function starButton(item) {
    var b = button('', 'star', '', function () {
      var list = target(); if (!list) { toast('Zuerst unter „Favoriten“ eine Liste anlegen.'); return; }
      var adding = !item.s;
      act({t:adding ? 'fav-add' : 'fav-remove', n:list, k:item.k}, function () { item.s = adding ? 1 : 0; paint(); toast(adding ? '„' + item.n + '“ zu „' + list + '“ hinzugefügt.' : '„' + item.n + '“ aus „' + list + '“ entfernt.'); });
    });
    function paint() { b.textContent = item.s ? '★' : '☆'; b.className = 'star' + (item.s ? ' on' : ''); b.setAttribute('aria-label', item.n + (item.s ? ' aus der Liste entfernen' : ' zur Liste hinzufügen')); }
    paint(); return b;
  }
  function titleButtons(item) { var list = [playButton(item)]; if (item.y === 'tv') list.push(starButton(item)); return list; }

  // --- State from the device: favorite lists and "Weiterschauen"
  function showState(d) {
    lists = Array.isArray(d.lists) ? d.lists : [];
    var select = $('favTarget'), chosen = select.value; select.textContent = '';
    lists.forEach(function (list) { var o = el('option', '', list.n + ' (' + list.c + ')'); o.value = list.n; select.appendChild(o); });
    if (!lists.length) { var none = el('option', '', 'noch keine Liste – unter „Favoriten“ anlegen'); none.value = ''; select.appendChild(none); }
    select.value = chosen && lists.some(function (l) { return l.n === chosen; }) ? chosen : (lists.length ? lists[0].n : '');
    var host = $('lists'); host.textContent = '';
    lists.forEach(function (list) {
      var li = el('li'), open = function () { showList(list.n, 0); };
      var text = textBlock(list.n, list.c + ' Sender', 'button'); text.type = 'button'; text.onclick = open; li.appendChild(text);
      li.appendChild(button('Öffnen', '', 'Liste ' + list.n + ' öffnen', open)); host.appendChild(li);
    });
    var resume = $('resumeItems'); resume.textContent = '';
    (d.resume || []).forEach(function (item) { resume.appendChild(row(item, [playButton(item), button('✕', '', item.n + ' aus Weiterschauen entfernen', function () { act({t:'resume-remove', k:item.k}, function () { toast('„' + item.n + '“ entfernt.'); }); })])); });
    $('resumeEmpty').hidden = !!(d.resume && d.resume.length);
    if (openList && !lists.some(function (l) { return l.n === openList; })) closeList();
    else if (openList && !$('favorites').hidden) showList(openList, 0, true);
  }

  // --- Favorites
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
      if (!d.total) host.appendChild(el('li', 'sub', 'Noch leer. Über „+ Sender aus Kategorien hinzufügen“ oder „Suchen“ füllen.'));
    });
  }
  function closeList() { openList = null; $('listView').hidden = true; $('lists').hidden = false; $('newList').hidden = false; }

  // --- Categories of the provider: browse, hide/show, add channels to the chosen favorite list
  function loadCats(offset) {
    closeCat(true);
    act({t:'cats', y:kind, o:offset}, function (d) {
      var host = $('catList'); if (!offset) host.textContent = '';
      d.items.forEach(function (cat) {
        var li = el('li', cat.h ? 'off' : ''), info = function () { return cat.c + ' Titel' + (cat.h ? ' · ausgeblendet' : '') + (cat.f ? ' · FSK' : ''); };
        var text = textBlock(cat.n, info(), 'button'); text.type = 'button'; text.onclick = function () { showCat(cat.n, 0); }; li.appendChild(text);
        var eye = button(cat.h ? '🚫' : '👁', '', '', function () {
          var hide = !cat.h;
          act({t:'cat-hide', y:kind, n:cat.n, h:hide ? 1 : 0}, function () { cat.h = hide; li.className = hide ? 'off' : ''; text.lastChild.textContent = info(); paintEye(); });
        });
        function paintEye() { eye.textContent = cat.h ? '🚫' : '👁'; eye.setAttribute('aria-label', cat.n + (cat.h ? ' wieder einblenden' : ' ausblenden')); }
        paintEye(); li.appendChild(eye); host.appendChild(li);
      });
      if (!d.total) host.appendChild(el('li', 'sub', 'Keine Kategorien.'));
      var shown = offset + d.items.length; $('catListMore').hidden = shown >= d.total;
      $('catListMore').onclick = function () { loadCats(shown); };
    });
  }
  // Sender categories: a check mark per channel (ticked = in the target list); "Übernehmen" saves all changes at once.
  // picks keeps the choice across "Weitere laden": number -> {was, now, box}.
  var picks = {};
  function pickCount() {
    var added = 0, removed = 0;
    Object.keys(picks).forEach(function (k) { var p = picks[k]; if (p.now && !p.was) added++; if (!p.now && p.was) removed++; });
    var apply = $('catApply'); apply.disabled = !added && !removed;
    apply.textContent = 'Übernehmen' + (added || removed ? ' (' + added + ' neu, ' + removed + ' entfernt)' : '');
    return {added:added, removed:removed};
  }
  function pickRow(item) {
    var p = picks[item.k] || (picks[item.k] = {was:!!item.s, now:!!item.s}), li = el('li'), label = el('label', 'pick'), box = el('input');
    box.type = 'checkbox'; box.checked = p.now; box.setAttribute('aria-label', item.n + ' in der Zielliste');
    box.onchange = function () { p.now = box.checked; pickCount(); };
    p.box = box; label.appendChild(box); label.appendChild(textBlock(item.n, item.g)); li.appendChild(label); li.appendChild(playButton(item));
    return li;
  }
  function setAll(on) { Object.keys(picks).forEach(function (k) { picks[k].now = on; if (picks[k].box) picks[k].box.checked = on; }); pickCount(); }
  // Sends the changes in packets (one relay message stays small), then reloads the category with the new state.
  function applyPicks(name, list) {
    var add = [], remove = [];
    Object.keys(picks).forEach(function (k) { var p = picks[k]; if (p.now && !p.was) add.push(Number(k)); if (!p.now && p.was) remove.push(Number(k)); });
    $('catApply').disabled = true; $('catApply').textContent = 'Wird gespeichert …';
    var packets = [];
    for (var i = 0; i < Math.max(add.length, remove.length); i += 300) packets.push({t:'fav-set', n:list, add:add.slice(i, i + 300), remove:remove.slice(i, i + 300)});
    packets.reduce(function (chain, packet) { return chain.then(function () { return send(packet); }); }, Promise.resolve())
      .then(function (reply) { toast(reply && reply.msg || 'Übernommen.'); showCat(name, 0); })
      .catch(function (e) { toast(e.message); pickCount(); });
  }
  function showCat(name, offset) {
    if (!offset) picks = {};
    openCat = name; $('catBrowse').hidden = true; $('catView').hidden = false; $('catTitle').textContent = name;
    act({t:'cat', y:kind, n:name, o:offset, fav:target()}, function (d) {
      var host = $('catItems'); if (!offset) host.textContent = '';
      $('catHide').textContent = d.h ? 'Wieder einblenden' : 'Am Fernseher ausblenden';
      $('catHide').onclick = function () { act({t:'cat-hide', y:kind, n:name, h:d.h ? 0 : 1}, function () { d.h = d.h ? 0 : 1; $('catHide').textContent = d.h ? 'Wieder einblenden' : 'Am Fernseher ausblenden'; }); };
      var list = target(), choosing = kind === 'tv' && !!list && d.total > 0;
      $('catAddAll').hidden = !choosing; $('catAddAll').textContent = 'Ganze Kategorie (' + d.total + ') zu „' + list + '“';
      $('catAddAll').onclick = function () { act({t:'fav-add-cat', n:list, c:name}, function () { showCat(name, 0); }); };
      $('pickHint').hidden = $('pickBar').hidden = $('catApply').hidden = !choosing;
      $('catAll').onclick = function () { setAll(true); }; $('catNone').onclick = function () { setAll(false); };
      $('catApply').onclick = function () { applyPicks(name, list); };
      if (kind === 'tv' && !list) host.appendChild(el('li', 'sub', 'Zum Auswählen zuerst unter „Favoriten“ eine Liste anlegen.'));
      d.items.forEach(function (item) { host.appendChild(choosing ? pickRow(item) : row(item, [playButton(item)])); });
      var shown = offset + d.items.length; $('catMore').hidden = shown >= d.total;
      $('catMore').onclick = function () { showCat(name, shown); };
      if (choosing) pickCount();
    });
  }
  function closeCat(keep) { openCat = null; picks = {}; $('catView').hidden = true; $('catBrowse').hidden = false; if (!keep) $('catItems').textContent = ''; }

  // --- Search
  function runSearch() {
    var q = $('query').value.trim(); if (q.length < 2) { toast('Mindestens 2 Zeichen.'); return; }
    lastSearch = q; var host = $('results'); host.textContent = ''; host.appendChild(el('li', 'sub', 'Suche …'));
    act({t:'search', q:q, scope:$('onlyTv').checked ? 'tv' : 'all', fav:target()}, function (d) {
      host.textContent = '';
      if (!d.items.length) host.appendChild(el('li', 'sub', 'Nichts gefunden.'));
      d.items.forEach(function (item) { host.appendChild(row(item, titleButtons(item))); });
      if (d.more) host.appendChild(el('li', 'sub', 'Weitere Treffer – Suche genauer eingeben.'));
    });
  }

  // --- Controls
  function showTab(name) {
    Array.prototype.forEach.call(document.querySelectorAll('#tabs button'), function (o) { o.className = o.getAttribute('data-tab') === name ? 'on' : ''; });
    ['search', 'categories', 'favorites', 'resume'].forEach(function (id) { $(id).hidden = id !== name; });
    $('targetBar').hidden = name !== 'search' && name !== 'categories';
    if (name === 'categories' && !openCat && !$('catList').children.length) loadCats(0);
  }
  Array.prototype.forEach.call(document.querySelectorAll('#tabs button'), function (b) { b.onclick = function () { showTab(b.getAttribute('data-tab')); }; });
  Array.prototype.forEach.call(document.querySelectorAll('#kinds button'), function (b) {
    b.onclick = function () {
      kind = b.getAttribute('data-kind');
      Array.prototype.forEach.call(document.querySelectorAll('#kinds button'), function (o) { o.className = o === b ? 'on' : ''; });
      loadCats(0);
    };
  });
  // Another target list: the stars of the open view follow it.
  $('favTarget').onchange = function () { if (openCat) showCat(openCat, 0); else if (lastSearch && !$('search').hidden) runSearch(); };
  $('searchForm').onsubmit = function (e) { e.preventDefault(); runSearch(); };
  $('catBack').onclick = function () { closeCat(); };
  $('newList').onsubmit = function (e) { e.preventDefault(); var name = $('newName').value.trim(); if (!name) return; act({t:'fav-create', n:name}, function () { $('newName').value = ''; toast('Liste „' + name + '“ angelegt.'); }); };
  $('listBack').onclick = closeList;
  $('listAdd').onclick = function () {
    var name = openList; if (!name) return; $('favTarget').value = name;
    kind = 'tv'; Array.prototype.forEach.call(document.querySelectorAll('#kinds button'), function (o) { o.className = o.getAttribute('data-kind') === 'tv' ? 'on' : ''; });
    showTab('categories'); loadCats(0);
  };
  $('renameDo').onclick = function () { var to = $('rename').value.trim(), from = openList; if (!to || !from || to === from) return; act({t:'fav-rename', n:from, to:to}, function () { openList = to; $('listTitle').textContent = to; toast('Umbenannt.'); }); };
  $('deleteList').onclick = function () { var name = openList; if (!name || !confirm('Liste „' + name + '“ löschen? Die Sender selbst bleiben.')) return; act({t:'fav-delete', n:name}, function () { closeList(); toast('Liste gelöscht.'); }); };
  $('end').onclick = function () { send({t:'bye'}).catch(function () {}); setTimeout(function () { finish('Verbindung beendet. Diese Seite kann geschlossen werden.'); }, 300); };

  // --- Connection: an event stream from the relay (from the start of this session) and a hello to the device.
  var since = Math.floor(Date.now() / 1000) - 60;
  // The browser reconnects by itself after network hiccups; after an answer like 429 it gives up (CLOSED): then a new
  // stream after a growing pause, continuing after the last message seen.
  function listen() {
    source = new EventSource('https://ntfy.sh/' + topic + '/sse?since=' + (lastId || since));
    source.onopen = function () { reconnects = 0; };
    source.onmessage = function (e) { reconnects = 0; receive(e.data); };
    source.onerror = function () {
      if (ended) return; say('Verbindung wackelt, versuche erneut …');
      var dead = source; if (dead.readyState !== 2) return;
      reconnects++; setTimeout(function () { if (!ended && source === dead) listen(); }, Math.min(60000, 5000 * Math.pow(2, reconnects - 1)));
    };
  }
  listen();
  send({t:'hello'}).then(function () {
    say('Mit dem Fernseher verbunden.'); $('tabs').hidden = false; $('end').hidden = false; showTab('search');
  }).catch(function (e) { say(e.message + ' Am Fernseher den QR-Code neu anzeigen und erneut scannen.'); });
})();
