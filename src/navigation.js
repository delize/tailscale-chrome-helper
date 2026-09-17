// One definition of "the same navigation", shared by the moved-on guard and the suppressor.
//
// They used to disagree, and every symptom of that disagreement was a separate bug. The
// guard compared hostnames, so Chrome's https-to-http fallback read as one navigation. The
// suppressor compared whole URLs, so the same fallback read as two. From that gap:
//
//   - the guidance page fired twice for one failed address
//   - the host counter recorded two hits for one visit
//   - a user who moved to another path on the same host was dragged back to guidance for
//     the URL they had just left, because hostname-only comparison is wider than the
//     fallback case it was added for
//   - and worst, Retry from the page the user was actually shown cleared only that URL's
//     suppression slot, while the other attempt's slot still held, so the retry was
//     suppressed and the user landed on Chrome's raw error page. That is the exact failure
//     this extension exists to prevent, reintroduced by the fix for a different bug.
//
// Scheme is ignored because Chrome upgrades a typed address to https and falls back to
// http, and that is the browser retrying rather than the user going elsewhere. Path and
// query are significant, because a different path IS the user going elsewhere.
//
// Pure and dependency-free, so both callers can be tested without a browser.

export function navKey(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl) return null;
  try {
    const url = new URL(rawUrl);
    // Only real page navigations have an identity worth comparing. Chrome commits its own
    // error page as chrome-error://chromewebdata/, and this extension's guidance page is a
    // chrome-extension:// URL; neither is the user choosing to go somewhere.
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    // Trailing dot on a hostname is the same host. Port is deliberately included: a
    // different port is a different service.
    const host = url.hostname.replace(/\.$/, '').toLowerCase() + (url.port ? ':' + url.port : '');
    return host + url.pathname + url.search;
  } catch {
    return null;
  }
}

export function sameNavigation(a, b) {
  const ka = navKey(a);
  const kb = navKey(b);
  return ka !== null && ka === kb;
}
