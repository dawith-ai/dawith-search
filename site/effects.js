// Scroll effects shared by every page: sections rise into view as they enter
// the viewport, and the menu link for the section on screen is highlighted.
// Motion is skipped entirely when the visitor asks for reduced motion.
(function () {
  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var canObserve = 'IntersectionObserver' in window;

  // Keep the long guide legible: a tiny progress line gives the reader a sense of place.
  var progressBar = document.querySelector('.scroll-progress');
  if (progressBar && !reduceMotion) {
    var progressQueued = false;
    var updateProgress = function () {
      if (progressQueued) return;
      progressQueued = true;
      window.requestAnimationFrame(function () {
        var root = document.documentElement;
        var range = root.scrollHeight - root.clientHeight;
        var scrollTop = window.scrollY || root.scrollTop || document.body.scrollTop || 0;
        var percent = range > 0 ? (scrollTop / range) * 100 : 0;
        root.style.setProperty('--scroll-progress', Math.max(0, Math.min(100, percent)) + '%');
        progressQueued = false;
      });
    };
    window.addEventListener('scroll', updateProgress, { passive: true });
    window.addEventListener('resize', updateProgress, { passive: true });
    updateProgress();
  }

  var REVEAL = [
    '.content-section', '.support-section', '.workspace-panel', '.operation-panel',
    '.search-preview-panel', '.quick-start', '.kpi-card', '.download-card',
    '.dl-hero', '.dl-block', '.dl-section', '.dl-table-wrap',
    '.oss-group', '.oss-card', '.faq-item', '.help-section', '.contact-card'
  ].join(',');

  if (!reduceMotion && canObserve) {
    var revealObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('is-visible');
        revealObserver.unobserve(entry.target);
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });

    var items = document.querySelectorAll(REVEAL);
    items.forEach(function (element) {
      // Stagger siblings of the same kind a little so grids cascade in.
      var index = Array.prototype.indexOf.call(element.parentNode.children, element);
      element.style.setProperty('--reveal-delay', Math.min(index, 6) * 60 + 'ms');
      element.classList.add('reveal');
      revealObserver.observe(element);
    });
  }

  // Highlight the menu link whose section is currently on screen.
  if (!canObserve) return;
  var links = Array.prototype.filter.call(
    document.querySelectorAll('a[href^="#"], a[href*=".html#"]'),
    function (link) {
      var hash = link.getAttribute('href').split('#')[1];
      return hash && link.closest('nav, .sidebar, .side-nav, .dl-nav');
    }
  );
  var byId = {};
  links.forEach(function (link) {
    var id = link.getAttribute('href').split('#')[1];
    if (document.getElementById(id)) (byId[id] = byId[id] || []).push(link);
  });
  var ids = Object.keys(byId);
  if (!ids.length) return;
  var spy = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (!entry.isIntersecting) return;
      // The section on screen becomes the only highlighted menu item.
      links.forEach(function (link) { link.classList.remove('is-current', 'active'); });
      byId[entry.target.id].forEach(function (link) { link.classList.add('is-current'); });
    });
  }, { rootMargin: '-35% 0px -55% 0px' });
  ids.forEach(function (id) { spy.observe(document.getElementById(id)); });
})();
