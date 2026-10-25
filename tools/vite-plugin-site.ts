import type { Plugin } from 'vite';

/**
 * The site's address in the page, where a link preview needs it whole (its image): `%SITE%` in
 * index.html becomes `VITE_SITE_URL` with a trailing slash when the build is told it (the Pages
 * workflow tells it the Pages address), and `./` otherwise, which local previews accept.
 */
export function siteHtml(html: string, siteUrl: string | undefined): string {
  const base = siteUrl ? (siteUrl.endsWith('/') ? siteUrl : `${siteUrl}/`) : './';
  return html.replaceAll('%SITE%', base);
}

export function sitePlugin(siteUrl: string | undefined = process.env.VITE_SITE_URL): Plugin {
  return {
    name: 'trenchline-site',
    transformIndexHtml: (html) => siteHtml(html, siteUrl),
  };
}
