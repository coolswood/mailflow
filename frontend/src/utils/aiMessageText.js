// The text an AI action (#202) sends to the model: what the user reads, not what the MIME
// part contains. HTML-only emails used to go in as raw HTML with tags stripped by a
// catch-all regex (#646), which left the contents of <style> blocks, the whole quoted
// history below the reply and bare tracking URLs in the prompt — Translate then
// "translated" CSS and previous turns of the thread instead of the message.
//
// Cutting is lossy, so who gets cut is narrow (#647 review): a built-in action gets the
// sender's message alone, with quoted history cut only where it trails the reply. Custom
// actions ({ full: true }) are left whole — their prompts may need the thread and the
// links, and a cut loses forwards, inline answers and quoted context they asked for.

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
// div.gmail_quote/div.gmail_attr and Yahoo's yahoo_quoted. Outlook's quotes are unclassed
// plain paragraphs — those are caught by the text-level pass (stripQuotedHistory) below.
const QUOTE_WRAPPER_SELECTOR = 'blockquote, [class*="gmail_quote"], [class*="gmail_attr"], [class*="yahoo_quoted"]';

// Forward markers: Gmail's "---------- Forwarded message ---------" (in the client's UI
// language) and Apple Mail's "Begin forwarded message:". A forward carries a whole other
// email, so it is content, never history: a wrapper that opens with one stays, and the
// text pass stops cutting past one. Gmail used to forward as a gmail_quote wrapper alone
// and the action went out empty or as just the note above the forward (#647 review).
const FORWARD_MARKER_RE = new RegExp(
  '^\\s{0,8}(?:begin\\s+forwarded\\s+message|начало\\s+пересылаемого\\s+сообщения'
  + '|[-–—_=]{4,}\\s*(?:begin\\s+)?(?:forwarded\\s+message|пересланное\\s+сообщение'
  + '|weitergeleitete\\s+nachricht|välitetty\\s+viesti|mensaje\\s+reenviado'
  + '|message\\s+transféré|messaggio\\s+inoltrato|doorgestuurd\\s+bericht'
  + '|przekazana\\s+wiadomość|mensagem\\s+encaminhada))', 'i');

// True when the first non-blank line of `text` is a forward marker.
function startsWithForward(text) {
  const line = (text || '').split('\n').find(l => l.trim());
  return !!line && FORWARD_MARKER_RE.test(line);
}

// Block-level elements: text inside gets line boundaries, so paragraphs survive extraction
// as separate lines (textContent alone welds every paragraph into one run).
const BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'caption', 'center', 'dd', 'div', 'dl', 'dt', 'fieldset',
  'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header',
  'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'tbody', 'td', 'tfoot', 'th',
  'thead', 'tr', 'ul',
]);

// Cut a wrapper only where it is trailing quoted history: real text above it (else the
// wrapper is the whole message — a Gmail forward with no note lives entirely inside
// div.gmail_quote), no real text after it (a newsletter pull-quote is a mid-document
// blockquote, an inline answer continues below its quote), and not a forward (#647
// review). Wrappers nested in wrappers are content of their parent, not their own call.
function cutTrailingQuoteWrappers(root) {
  const segments = [];
  let run = null;
  const flush = () => {
    if (run && run.join('').trim()) segments.push({ text: run });
    run = null;
  };
  const walk = (node, wrapped) => {
    for (const child of node.childNodes) {
      if (child.nodeType === 3 /* text */) {
        if (!wrapped) (run || (run = [])).push(child.nodeValue);
        continue;
      }
      if (child.nodeType !== 1 /* element */) continue;
      const name = child.tagName.toLowerCase();
      const breaks = name === 'br' || BLOCK_TAGS.has(name);
      if (breaks && !wrapped) (run || (run = [])).push('\n');
      const quote = !wrapped && child.matches(QUOTE_WRAPPER_SELECTOR);
      if (quote) { flush(); segments.push({ node: child }); }
      walk(child, wrapped || quote);
      if (breaks && !wrapped) (run || (run = [])).push('\n');
    }
  };
  walk(root, false);
  flush();

  const real = seg => seg.text && seg.text.join('').replace(/\s+/g, ' ').trim();
  const before = new Array(segments.length).fill(false);
  const after = new Array(segments.length).fill(false);
  let seen = false;
  for (let i = 0; i < segments.length; i++) { before[i] = seen; if (real(segments[i])) seen = true; }
  seen = false;
  for (let i = segments.length - 1; i >= 0; i--) { after[i] = seen; if (real(segments[i])) seen = true; }
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg.node && before[i] && !after[i] && !startsWithForward(seg.node.textContent)) seg.node.remove();
  }
}

function htmlToText(html, keepQuotes) {
  let doc;
  try {
    doc = new DOMParser().parseFromString(html, 'text/html');
  } catch {
    return html;
  }
  doc.querySelectorAll(INERT_SELECTOR).forEach(el => el.remove());
  if (!keepQuotes) cutTrailingQuoteWrappers(doc.body || doc.documentElement);
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
// signature footer, so a cut needs a header run — and a full one: who sent it, when and
// about what. Two or three generic labels used to be enough, and structured mail paid
// for it (#647 review): a shipping notice's "From: Berlin / To: Paris / Date: …" read as
// a quote header and the itinerary below was cut, an event notice lost its details.
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

const HEADER_FROM_RE = /^\s{0,8}(?:from|von|de|da|od|van|lähettäjä|от)\s*:/i;
const HEADER_DATE_RE = /^\s{0,8}(?:sent|date|gesendet|datum|envoyé|enviado|inviato|wysłano|odesláno|verzonden|enviada|lähetetty|päiväys|дата|отправлено)\s*:/i;
const HEADER_SUBJECT_RE = /^\s{0,8}(?:subject|betreff|objet|asunto|oggetto|onderwerp|aihe|тема|temat|předmět|assunto)\s*:/i;

// A quote header is a tight block of label lines naming a From, a Sent/Date and a
// Subject; any ordinary line ends it. Bounded, so hostile input stays linear.
function isQuoteHeaderRun(lines, from) {
  const kinds = new Set();
  let seen = 0;
  for (let i = from; i < lines.length && seen < 12; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    seen++;
    if (HEADER_FROM_RE.test(line)) kinds.add('from');
    else if (HEADER_DATE_RE.test(line)) kinds.add('date');
    else if (HEADER_SUBJECT_RE.test(line)) kinds.add('subject');
    else if (!QUOTE_HEADER_LINE_RE.test(line)) break;
  }
  return kinds.has('from') && kinds.has('date') && kinds.has('subject');
}

// A quote a reader appended under their own words runs to the end of the message. Real
// text after a quote — an inline answer, a signature — means the quote is not the tail,
// and cutting there would take the reader's own words (#647 review).
function quoteRunsToEnd(lines, from) {
  for (let i = from + 1; i < lines.length; i++) {
    if (lines[i].trim() && !/^\s{0,8}>/.test(lines[i])) return false;
  }
  return true;
}

// Cut the message at the line that opens trailing quoted history — the previous turn,
// which the sender did not write. Four shapes, in order:
//   1. a forward marker: content, not history — stop cutting for the rest of the message;
//   2. an attribution line ("On … X wrote:", "… X kirjoitti:") naming a time or address,
//      with the quote below it `>`-quoted to the end (an unprefixed body could be the
//      reader's own continuation, so no cut);
//   3. a full quote-header run (From + Sent/Date + Subject);
//   4. `>`-quoted lines running to the end.
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
    if (isQuoteLine) {
      if (sawContent && quoteRunsToEnd(lines, i)) return lines.slice(0, i).join('\n');
    } else if (FORWARD_MARKER_RE.test(line)) {
      return text;
    } else if (QUOTE_HEADER_LINE_RE.test(line) && isQuoteHeaderRun(lines, i)) {
      if (sawContent) return lines.slice(0, i).join('\n');
    } else {
      sawContent = true;
    }
  }
  return text;
}

// Junk that carries nothing the model needs (mirrors the backend snippet cleanup in
// services/messageParser.js): zero-width filler, [image: …] placeholders from
// HTML-to-text converters and, unless keepLinks, bare link targets — the anchor's own
// words stay — plus the empty wrappers the URL strip leaves behind.
export function cleanForAi(text, { keepLinks = false } = {}) {
  let out = text
    .replace(/[\u00ad\u200b-\u200d\ufeff]/g, '')
    .replace(/\[image:[^\]]*\]|(\[image:[^\]]*)/gi, '$1');
  if (!keepLinks) {
    out = out
      .replace(/(?:https?:\/\/|mailto:)[^\s<>()[\]]+/gi, '')
      .replace(/(?<![\w@.])www\.[^\s<>()[\]]+/gi, '')
      .replace(/\(\s*\)|\[\s*\]|<\s*>/g, ' ');
  }
  return out
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// The model-facing text of a message: the text/plain part when it is real text, otherwise
// the HTML part extracted to visible text (or the degenerate text part parsed as HTML).
// Junk is cleaned on either path. Default (built-in actions) also cuts trailing quoted
// history; { full: true } (custom actions) keeps quotes and links. Empty input stays empty.
export function aiMessageText(body, { full = false } = {}) {
  if (!body) return '';
  const text = typeof body.text === 'string' ? body.text : '';
  const html = typeof body.html === 'string' ? body.html : '';
  const finish = (t) => {
    const cleaned = cleanForAi(t, { keepLinks: full });
    return full ? cleaned : stripQuotedHistory(cleaned);
  };
  if (text && !looksLikeHtml(text)) return finish(text);
  if (html || text) return finish(htmlToText(html || text, full));
  return '';
}
