// Puts the saved skin on <html> before first paint, so nobody sees the default
// flash past. A blocking script in the head, and a file rather than an inline
// block because the Content Security Policy is script-src 'self': an inline
// script would be refused, and that policy is a control worth keeping as it is.
(function () {
  try {
    var skin = localStorage.getItem('josi.skin');
    if (skin === 'plum-gold' || skin === 'classic-navy') {
      document.documentElement.setAttribute('data-theme', skin);
      if (skin === 'classic-navy') document.querySelector('meta[name="theme-color"]').setAttribute('content', '#0B111E');
    }
  } catch (_) { /* Storage blocked: the default skin stands. */ }
})();
