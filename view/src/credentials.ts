/**
 * Getting the bearer token into a page the daemon served without a token.
 *
 * `astir view` opens `/view#<token>`. A URL fragment is never transmitted to
 * the server — it appears in no request line, access log or proxy trace — which
 * is what makes it usable for this where a query string would not be.
 *
 * It is then moved into `sessionStorage` and cleared from the address bar. Two
 * reasons: a reload keeps working (the token would otherwise be gone the moment
 * anyone pressed F5), and the token stops being visible in a screenshot or a
 * shoulder-surfed address bar. `sessionStorage` rather than `localStorage`
 * because the credential should die with the tab.
 */

const KEY = "astir.token";

export function takeToken(): string | null {
  const fromHash = window.location.hash.replace(/^#/, "").trim();
  if (fromHash.length > 0) {
    try {
      window.sessionStorage.setItem(KEY, fromHash);
    } catch {
      // Private mode, or storage disabled. The token still works for this page
      // load; only surviving a reload is lost.
    }
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
    return fromHash;
  }
  try {
    return window.sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export const authHeaders = (token: string): HeadersInit => ({ authorization: `Bearer ${token}` });
