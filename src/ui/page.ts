import { renderPageHtml } from './markup.js';

/** Local UI: static markup + client modules served from /ui/ (compiled from local-client.ts). */
export const UI_HTML = renderPageHtml('local', '<script type="module" src="/ui/local-client.js"></script>');

export const CLIENT_FILES = ['local-client.js', 'common.js', 'strings.js'];
