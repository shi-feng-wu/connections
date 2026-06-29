import type { VercelRequest } from "@vercel/node";

// Read query params via the WHATWG URL API instead of @vercel/node's `req.query` getter. That
// getter lazily calls the legacy `url.parse()`, which makes Node emit a DEP0169 deprecation
// warning ("`url.parse()` ... Use the WHATWG URL API instead") on EVERY request that reads a query
// param — pure noise that is the single highest-volume "error" in the runtime logs. `req.url` is a
// path+query like "/api/x?a=1", so the base passed to `new URL` is irrelevant; only `searchParams`
// is read. Leading underscore keeps Vercel from routing this file.
export function query(req: VercelRequest): URLSearchParams {
  try {
    return new URL(req.url ?? "", "http://localhost").searchParams;
  } catch {
    return new URLSearchParams();
  }
}
