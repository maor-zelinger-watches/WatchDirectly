/**
 * analytics.js — Google Analytics 4 (gtag.js) bootstrap.
 *
 * Google's snippet ships the dataLayer/gtag setup as an inline <script>; it
 * lives here instead so every page keeps a strict Content-Security-Policy
 * (script-src without 'unsafe-inline'). The loader itself is the async
 * <script src="https://www.googletagmanager.com/gtag/js?..."> tag next to
 * this one in each page's <head>; the CSP allowlists googletagmanager.com
 * (script/connect) and *.google-analytics.com / *.analytics.google.com
 * (connect). Loaded by index.html, terms.html, privacy.html, and 404.html.
 */
window.dataLayer = window.dataLayer || [];
function gtag() { window.dataLayer.push(arguments); }
window.gtag = gtag;
gtag('js', new Date());
gtag('config', 'G-LNXRS74XZ3');
