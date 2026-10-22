/** The sandbox has an opaque origin, so 'self' cannot authorize its assets.
 * Local HTTP installs must name the document's exact serving origin. Never
 * allow the whole http: scheme or relax the sandbox's network isolation. */
export function sandboxContentSecurityPolicy(documentUrl: string, localEdition: boolean): string {
  const url = new URL(documentUrl);
  const assetSources = localEdition && url.protocol === "http:" ? `https: ${url.origin}` : "https:";
  return [
    `default-src ${assetSources} 'unsafe-inline' 'unsafe-eval'`,
    `img-src ${assetSources} data: blob:`,
    `font-src ${assetSources} data:`,
    `media-src ${assetSources} data: blob:`,
    "connect-src 'none'",
    // Embeds are restricted to the existing static hosting allowlist.
    "frame-src https://*.pages.dev https://*.vercel.app https://*.netlify.app https://*.github.io",
    "frame-ancestors 'self'",
  ].join("; ");
}
