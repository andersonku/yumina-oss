/** Local installs must fetch the sandbox policy from this running server.
 * The hosted document hash covers HTML bytes, but not response headers, so a
 * cached hash can otherwise retain an obsolete CSP after a server-only fix. */
export function prepareSandboxAppShell(html: string, localEdition: boolean): string {
  if (!localEdition) return html;
  // Module scripts execute after parsing; this final inline override runs
  // after the build's hashed pointer and before the app reads that pointer.
  return html.replace("</head>", '<script>window.__YUMINA_SANDBOX_DOC_URL="/sandbox/index.html";</script></head>');
}

export function isLocalSandboxDocument(requestPath: string, localEdition: boolean): boolean {
  return localEdition && (requestPath.startsWith("/sandbox/") || /^\/assets\/sandbox-doc-[A-Za-z0-9]+\.html$/.test(requestPath));
}

export const LOCAL_SANDBOX_CACHE_HEADERS = {
  "Cache-Control": "no-store, no-cache, must-revalidate",
  "CDN-Cache-Control": "no-store",
  "Surrogate-Control": "no-store",
} as const;
