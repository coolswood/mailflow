// The text an AI action (#202) sends to the model: what the user reads, not what the MIME
// part contains. HTML-only emails used to go in as raw HTML with tags stripped by a
// catch-all regex (#646), which left the contents of <style> blocks, the whole quoted
// history below the reply and bare tracking URLs in the prompt — Translate then
// "translated" CSS and previous turns of the thread instead of the message.

// A text/plain part that is really a raw HTML document (some senders put one in). Same
// detection as the backend snippet builder (services/messageParser.js looksLikeHtml).
function looksLikeHtml(text) {
  const head = text.slice(0, 2048);
  if (/^\s*<(?:!doctype|html|head|body)[\s>]/i.test(head)) return true;
  if (/<[a-z][a-z0-9]*\s[^>]*=[^>]*>/i.test(head)) return true;
  if (/<(?:style|script)[\s>]/i.test(head)) return true;
  const closingTags = head.match(/<\/[a-z][a-z0-9]*\s*>/gi);
  return closingTags !== null && closingTags.length >= 3;
}

// Elements whose text content never renders, so leaving them in would hand the model CSS
// and script debris as if it were body text.
const INERT_SELECTOR = 'script, style, head, title, noscript, template';

// Wrappers mail clients put around quoted history: the classic blockquote, plus Gmail's
// div.gmail_quote/div.gmail_attr. Outlook's quotes are unclassed plain paragraphs — those
// are caught by the text-level pass (stripQuotedHistory) below.
const QUOTE_WRAPPER_SELECTOR = 'blockquote, [class*="gmail_quote"], [class*="gmail_attr"]';

// Block-level elements: text inside gets line boundaries, so paragraphs survive extraction
// as separate lines (textContent alone welds every paragraph into one run).
const BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'caption', 'center', 'dd', 'div', 'dl', 'dt', 'fieldset',
  'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header',
  'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'tbody', 'td', 'tfoot', 'th',
  'thead', 'tr', 'ul',
]);

function htmlToText(html) {
  let doc;
  try {
    doc = new DOMParser().parseFromString(html, 'text/html');
  } catch {
    return html;
  }
  doc.querySelectorAll(INERT_SELECTOR).forEach(el => el.remove());
  doc.querySelectorAll(QUOTE_WRAPPER_SELECTOR).forEach(el => el.remove());
  const out = [];
  const walk = (node) => {
    for (const child of node.childNodes) {
      if (child.nodeType === 3 /* text */) { out.push(child.nodeValue); continue; }
      if (child.nodeType !== 1 /* element */) continue;
      const name = child.tagName.toLowerCase();
      if (name === 'br') { out.push('\n'); continue; }
      const block = BLOCK_TAGS.has(name);
      if (block) out.push('\n');
      walk(child);
      if (block) out.push('\n');
    }
  };
  walk(doc.body || doc.documentElement);
  return out.join('');
}

// "On Mon, Oct 19, 2026 at 8:27 AM X <x@y.z> wrote:" — the attribution line Gmail, Apple
// Mail and Thunderbird put above the quoted history, including localized variants.
const QUOTE_INTRO_RE = new RegExp(
  '^\\s{0,8}.{1,220}(?:wrote|schrieb|schreef|a écrit|ha scritto|escribió|escreveu'
  + '|kirjoitti|napisał(?:a)?|написал(?:а)?|写道|작성)\\s*[:：]\\s*$', 'i');

// Real attributions name a time or an address; prose can end in "wrote:" too
// ("focus on what the author wrote:") and must not cut.
const looksAttributed = line => /\d/.test(line) || /<[^<>]+@[^<>]+>/.test(line);

// Localized quote-header labels (Outlook desktop quotes are unclassed paragraphs of
// `Label: value` lines in the sender's UI language). One such line alone could be a
// signature footer, so a cut needs a second label among the next few lines.
const QUOTE_HEADER_LINE_RE = new RegExp(
  '^\\s{0,8}(?:from|sent|to|cc|bcc|subject|date|reply|sender'
  + '|от|отправлено|кому|копия|тема|дата|ответ'
  + '|lähettäjä|lähetetty|vastaanottaja|aihe|kopio|päiväys'
  + '|von|an|gesendet|betreff|datum|kopie'
  + '|de|à|envoyé|objet'
  + '|para|enviado|asunto|fecha'
  + '|da|inviato|oggetto'
  + '|enviada|assunto'
  + '|van|aan|verzonden|onderwerp'
  + '|od|do|wysłano|temat|komu|odesláno|předmět'
  + ')\\s*:', 'i');

function hasHeaderRun(lines, from) {
  let seen = 0;
  for (let i = from + 1; i < lines.length && seen < 3; i++) {
    if (!lines[i].trim()) continue;
    seen++;
    if (QUOTE_HEADER_LINE_RE.test(lines[i])) return true;
  }
  return false;
}

// Cut the message at the first line that opens quoted history — everything below it is
// the previous turn, which the sender did not write. Three quote shapes:
//   1. an attribution line ("On … X wrote:", "… X kirjoitti:") naming a time or address;
//   2. a run of at least two localized quote-header lines ("Lähettäjä: …" / "Lähetetty: …");
//   3. `>`-quoted lines.
// A cut only lands where the message has real content above it: a body that is nothing
// but a quote, or that opens with a pasted header block, keeps its text.
export function stripQuotedHistory(text) {
  const lines = text.split('\n');
  let sawContent = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const isQuoteLine = /^\s{0,8}>/.test(line)
      || (QUOTE_INTRO_RE.test(line) && looksAttributed(line));
    if (isQuoteLine || (QUOTE_HEADER_LINE_RE.test(line) && hasHeaderRun(lines, i))) {
      if (sawContent) return lines.slice(0, i).join('\n');
    } else {
      sawContent = true;
    }
  }
  return text;
}

// Junk that carries nothing the model needs (mirrors the backend snippet cleanup in
// services/messageParser.js): zero-width filler, [image: …] placeholders from
// HTML-to-text converters, bare link targets — the anchor's own words stay — and the
// empty wrappers the URL strip leaves behind ("label ( https://… )" → "label").
export function cleanForAi(text) {
  return text
    .replace(/[\u00ad\u200b-\u200d\ufeff]/g, '')
    .replace(/\[image:[^\]]*\]|(\[image:[^\]]*)/gi, '$1')
    .replace(/(?:https?:\/\/|mailto:)[^\s<>()[\]]+/gi, '')
    .replace(/(?<![\w@.])www\.[^\s<>()[\]]+/gi, '')
    .replace(/\(\s*\)|\[\s*\]|<\s*>/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// The model-facing text of a message: the text/plain part when it is real text, otherwise
// the HTML part extracted to visible text (or the degenerate text part parsed as HTML).
// Quoted history and junk are cut on either path; empty input stays empty.
export function aiMessageText(body) {
  if (!body) return '';
  const text = typeof body.text === 'string' ? body.text : '';
  const html = typeof body.html === 'string' ? body.html : '';
  if (text && !looksLikeHtml(text)) return cleanForAi(stripQuotedHistory(text));
  if (html || text) return cleanForAi(stripQuotedHistory(htmlToText(html || text)));
  return '';
}
