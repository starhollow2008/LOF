// osu! Local Favorites - Page-world XHR/fetch interceptor
// Runs in the MAIN world (injected via <script src>)
// Intercepts jQuery's $.ajax calls to /favourites

(function() {
  var origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url) {
    if (typeof url === 'string' && url.indexOf('/favourites') !== -1) {
      this.__blocked = true;
    }
    return origOpen.apply(this, arguments);
  };
  var origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function() {
    if (this.__blocked) {
      try {
        Object.defineProperty(this, 'readyState', { value: 4, writable: true, configurable: true });
        Object.defineProperty(this, 'status', { value: 200, writable: true, configurable: true });
        Object.defineProperty(this, 'responseText', { value: '{}', writable: true, configurable: true });
      } catch(e) {}
      var self = this;
      setTimeout(function() {
        if (self.onload) self.onload();
        if (self.onreadystatechange) self.onreadystatechange();
      }, 0);
      return;
    }
    return origSend.apply(this, arguments);
  };
  var origFetch = window.fetch;
  window.fetch = function(url, options) {
    var urlStr = typeof url === 'string' ? url : (url && url.url) || '';
    if (urlStr.indexOf('/favourites') !== -1) {
      return Promise.resolve(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
    }
    return origFetch.apply(this, arguments);
  };
})();
