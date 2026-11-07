// HomeTV phone page: encrypts the playlist link for exactly one device and posts it to the relay.
// The QR code of the device carries "#t=<topic>&k=<key>"; the fragment never reaches a server. Same protocol as
// HomeSecurity.openTransfer in core/security.js: AES-256-GCM, 12-byte IV, AAD "HomeTV-Send-v1|<topic>",
// message "v1.<iv>.<ciphertext>" in base64url.
(function () {
  'use strict';
  var params = {};
  location.hash.replace(/^#/, '').split('&').forEach(function (part) { var i = part.indexOf('='); if (i > 0) params[part.slice(0, i)] = decodeURIComponent(part.slice(i + 1)); });
  // Remove the key from the address bar and the history right away.
  if (location.hash) history.replaceState(null, '', location.pathname);
  var topic = /^hometv-[0-9a-f]{32}$/.test(params.t || '') ? params.t : '', key = /^[A-Za-z0-9_-]{43}$/.test(params.k || '') ? params.k : '';
  var form = document.getElementById('form'), link = document.getElementById('link'), button = document.getElementById('send'), status = document.getElementById('status');
  function say(text, kind) { status.textContent = text; status.className = kind || ''; }
  if (!topic || !key || !window.crypto || !crypto.subtle) { say('Bitte den QR-Code am Fernseher („Link vom Handy senden“) mit der Kamera scannen.', 'error'); return; }
  form.hidden = false; link.focus();
  function b64url(bytes) { var s = ''; bytes.forEach(function (b) { s += String.fromCharCode(b); }); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
  function fromB64url(text) { var t = text.replace(/-/g, '+').replace(/_/g, '/'); while (t.length % 4) t += '='; return Uint8Array.from(atob(t), function (c) { return c.charCodeAt(0); }); }
  form.addEventListener('submit', function (event) {
    event.preventDefault();
    var value = link.value.trim();
    if (!/^https?:\/\/[^\s]+$/i.test(value) || value.length > 2000) { say('Bitte einen vollständigen Link mit https:// (oder http://) einfügen.', 'error'); return; }
    button.disabled = true; say('Wird verschlüsselt und gesendet …');
    var iv = crypto.getRandomValues(new Uint8Array(12));
    crypto.subtle.importKey('raw', fromB64url(key), {name:'AES-GCM'}, false, ['encrypt']).then(function (k) {
      return crypto.subtle.encrypt({name:'AES-GCM', iv:iv, additionalData:new TextEncoder().encode('HomeTV-Send-v1|' + topic)}, k, new TextEncoder().encode(JSON.stringify({url:value})));
    }).then(function (sealed) {
      var message = 'v1.' + b64url(iv) + '.' + b64url(new Uint8Array(sealed));
      return fetch('https://ntfy.sh/' + topic, {method:'POST', body:message, credentials:'omit', cache:'no-store', referrerPolicy:'no-referrer'});
    }).then(function (response) {
      if (!response.ok) throw Error('relay');
      link.value = ''; form.hidden = true;
      say('Gesendet. Der Link erscheint gleich auf dem Fernseher im Feld „Playlist-Link“. Diese Seite kann geschlossen werden.', 'ok');
    }).catch(function () {
      button.disabled = false; say('Senden hat nicht geklappt. Internetverbindung prüfen und erneut versuchen.', 'error');
    });
  });
})();
