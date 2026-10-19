// The text AI actions send to the model: visible content of the message, with junk
// cleaned; built-in actions additionally get trailing quoted history cut, custom actions
// are left whole (#646, #647 review). Extraction needs a DOM parser, so like the other
// DOM-bound utils this runs under jsdom.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>');
globalThis.DOMParser = dom.window.DOMParser;
const { aiMessageText, stripQuotedHistory } = await import('./aiMessageText.js');

describe('aiMessageText', () => {
  it('extracts visible text from HTML: no style contents, paragraphs on their own lines', () => {
    const out = aiMessageText({ html: '<style>p{margin-bottom: 0;}</style><p>Hello Daniil,</p><p>Thank you for the update.</p>' });
    assert.equal(out, 'Hello Daniil,\n\nThank you for the update.');
  });

  it('cuts trailing quote wrappers (blockquote, gmail_quote/gmail_attr) with everything inside', () => {
    const out = aiMessageText({ html: '<p>My answer.</p><blockquote><p>Old message</p></blockquote>'
      + '<div class="gmail_quote"><div class="gmail_attr">On Mon, Oct 19, 2026 at 8:27 AM X &lt;x@y.z&gt; wrote:</div>'
      + '<p>Quoted body</p></div>' });
    assert.equal(out, 'My answer.');
  });

  it('keeps a wrapper that is the whole message: a Gmail forward with no note (#647 review 1)', () => {
    const html = '<div class="gmail_quote"><div class="gmail_attr">---------- Forwarded message ---------<br />'
      + 'From: Anna &lt;anna@exempel.fi&gt;<br />Date: Sun, Oct 18, 2026 at 9:14 PM<br />'
      + 'Subject: Fwd: Invoice 42<br />To: me &lt;me@example.com&gt;</div>'
      + '<div dir="ltr"><p>Invoice attached, please pay before Friday.</p></div></div>';
    const out = aiMessageText({ html });
    assert.match(out, /Invoice attached, please pay before Friday/);
    assert.match(out, /Forwarded message/);
  });

  it('keeps a forward below a note: Gmail wrapper, Apple blockquote, plain text (#647 review 2)', () => {
    const gmail = aiMessageText({ html: '<div dir="ltr">See below.</div><br />'
      + '<div class="gmail_quote"><div class="gmail_attr">---------- Forwarded message ---------<br />'
      + 'From: Anna &lt;anna@exempel.fi&gt;<br />Subject: Invoice 42</div>'
      + '<div dir="ltr"><p>Invoice attached.</p></div></div>' });
    assert.match(gmail, /See below\./);
    assert.match(gmail, /Invoice attached\./);

    const apple = aiMessageText({ html: '<div>See below.</div>'
      + '<blockquote type="cite"><div>Begin forwarded message:</div>'
      + '<div>From: Anna</div><p>Invoice attached.</p></blockquote>' });
    assert.match(apple, /See below\./);
    assert.match(apple, /Invoice attached\./);

    const plain = stripQuotedHistory('Переслал счёт.\n\n-------- Пересланное сообщение --------\n'
      + 'От: Бухгалтерия\nДата: 18 октября 2026 г.\nТема: Счёт\nКому: мне\n\nСчёт во вложении.');
    assert.match(plain, /Переслал счёт\./);
    assert.match(plain, /Счёт во вложении\./);
  });

  it('keeps a Finnish forward with its note intact (#647 review 2)', () => {
    const fwd = aiMessageText({ text: 'Katso alta.\n\n---------- Välitetty viesti ---------\n'
      + 'Lähettäjä: Anna\nLähetetty: lauantai 18. lokakuuta 2026 klo 21.14\nAihe: Lasku 42\n\nTässä lasku.' });
    assert.match(fwd, /Katso alta\./);
    assert.match(fwd, /Tässä lasku\./);
  });

  it('cuts an Outlook-style localized header quote after real content, keeps the signature above it', () => {
    const html = '<p>Hello Daniil,</p><p>Thanks — the case is closed.</p>'
      + '<p>Jim, ASUS Tekninen tuki</p>'
      + '<p><b>Lähettäjä:</b>Daniil Sugonyaev<br /><b>Lähetetty</b><b>:</b>2026-10-16 17:57:42.409<br />'
      + '<b>Aihe</b><b>:</b>Re:Re:Re:Vivo PC GX10<br /><br />Hello Jim, here is the previous message.</p>';
    const out = aiMessageText({ html });
    assert.match(out, /case is closed/);
    assert.match(out, /Jim, ASUS Tekninen tuki/);
    assert.doesNotMatch(out, /previous message/);
  });

  it('needs a full header run (From + Sent/Date + Subject) to cut (#647 review 5)', () => {
    // From + To + Date, no Subject: a structured shipping notice, not a quote header.
    const kept = stripQuotedHistory('Booking confirmed.\nFrom: Berlin\nTo: Paris\nDate: 12 Nov 2026\n\nDeparture 08:40, gate B2.');
    assert.match(kept, /Departure 08:40, gate B2\./);
    // From + Sent + Subject: an Outlook-style quote header; the unprefixed body below still cuts.
    const cut = stripQuotedHistory('My answer.\nFrom: X Y\nSent: Mon, Oct 19, 2026 at 10:00 AM\nSubject: Re: hi\n\nquoted body');
    assert.equal(cut, 'My answer.');
  });

  it('cuts an "On … wrote:" attribution when the quote below is marked, not prose or a bare body', () => {
    const cut = stripQuotedHistory('My answer.\nOn Mon, Oct 19, 2026 at 8:27 AM X <x@y.z> wrote:\n> Old body');
    assert.equal(cut, 'My answer.');
    const cutRu = stripQuotedHistory('Мой ответ.\n19 окт. 2026 г., 15:53 пользователь X написал:\n> Старое письмо');
    assert.equal(cutRu, 'Мой ответ.');
    const keptProse = stripQuotedHistory('Please focus on what the author wrote:\nMore of my own text.');
    assert.match(keptProse, /More of my own text/);
    // Thunderbird-style unprefixed quote: cutting could eat the reader's own continuation.
    const keptBare = stripQuotedHistory('My answer.\nOn Mon, Oct 19, 2026 at 8:27 AM X <x@y.z> wrote:\nOld body without markers');
    assert.match(keptBare, /Old body without markers/);
  });

  it('cuts >-quoted lines, but keeps an inline answer that continues below a quote (#647 review 4)', () => {
    const out = aiMessageText({ text: 'My answer.\n> Old line one\n> Old line two' });
    assert.equal(out, 'My answer.');
    const inline = stripQuotedHistory('Answer part one.\n> quoted line\nAnswer part two.');
    assert.match(inline, /Answer part one\./);
    assert.match(inline, /quoted line/);
    assert.match(inline, /Answer part two\./);
  });

  it('keeps a newsletter pull-quote: a mid-document blockquote with text after it (#647 review 6)', () => {
    const out = aiMessageText({ html: '<p>Our readers say:</p><blockquote><p>Best tool of the year.</p></blockquote>'
      + '<p>Subscribe at the link below.</p>' });
    assert.match(out, /Our readers say:/);
    assert.match(out, /Best tool of the year\./);
    assert.match(out, /Subscribe at the link below\./);
  });

  it('drops bare URLs and [image:] placeholders, keeps the words around them', () => {
    const out = aiMessageText({ html: '<p>See <a href="https://www.asus.com/fi/support/">ASUS Support</a>'
      + ' or https://example.com/track?x=1 and <https://example.com/2></p><p>[image: Banner]</p>' });
    assert.equal(out, 'See ASUS Support or and');
  });

  it('custom actions ({ full: true }) keep quoted history and links; built-ins get neither', () => {
    const body = { text: 'Yes.\n> the original request, see https://example.com/t/42' };
    assert.equal(aiMessageText(body), 'Yes.');
    const full = aiMessageText(body, { full: true });
    assert.match(full, /the original request/);
    assert.match(full, /https:\/\/example\.com\/t\/42/);
    const fullHtml = aiMessageText({ html: '<p>Note</p><blockquote><p>Old</p></blockquote>' }, { full: true });
    assert.match(fullHtml, /Old/);
  });

  it('prefers a real text/plain part, and still cuts its quoted history', () => {
    const out = aiMessageText({ text: 'My answer.\n> quoted', html: '<p>Ignored HTML</p>' });
    assert.equal(out, 'My answer.');
  });

  it('parses a text/plain part that is really HTML, and prefers the HTML part over it', () => {
    assert.match(aiMessageText({ text: '<p>Hello</p><div>x</div><b>y</b><i>z</i>' }), /Hello/);
    assert.equal(aiMessageText({ text: '<p>Not rendered</p><div>a</div><b>b</b><i>c</i>', html: '<p>Rendered</p>' }), 'Rendered');
  });

  it('keeps a body that only pastes a header block at the top', () => {
    const out = stripQuotedHistory('From: postmaster@example.com\nTo: me@example.com\nSubject: Delivery report\n\nYour message could not be delivered.');
    assert.match(out, /could not be delivered/);
  });

  it('keeps a body that is nothing but a quote (a cut would leave nothing)', () => {
    const out = stripQuotedHistory('On Mon, Oct 19, 2026 at 8:27 AM X <x@y.z> wrote:\nOnly the quoted part.');
    assert.match(out, /Only the quoted part/);
  });

  it('drops zero-width filler and collapses whitespace to lines and paragraphs', () => {
    const out = aiMessageText({ html: '<p>Text\u200b more</p><p></p><p>Second</p>' });
    assert.equal(out, 'Text more\n\nSecond');
  });

  it('handles empty and missing bodies', () => {
    assert.equal(aiMessageText(null), '');
    assert.equal(aiMessageText({}), '');
    assert.equal(aiMessageText({ text: '', html: '' }), '');
  });
});
