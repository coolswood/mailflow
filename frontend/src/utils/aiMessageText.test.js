// The text AI actions send to the model: visible content of the message, without CSS,
// quoted history or bare URLs (#646). Extraction needs a DOM parser, so like the other
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

  it('drops quote wrappers (blockquote, gmail_quote/gmail_attr) with everything inside', () => {
    const out = aiMessageText({ html: '<p>My answer.</p><blockquote><p>Old message</p></blockquote>'
      + '<div class="gmail_quote"><div class="gmail_attr">On Mon, Oct 19, 2026 at 8:27 AM X &lt;x@y.z&gt; wrote:</div>'
      + '<p>Quoted body</p></div>' });
    assert.equal(out, 'My answer.');
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

  it('cuts an "On … wrote:" attribution with a date or address, but not prose ending in wrote:', () => {
    const cut = stripQuotedHistory('My answer.\nOn Mon, Oct 19, 2026 at 8:27 AM X <x@y.z> wrote:\nOld body');
    assert.equal(cut, 'My answer.');
    const cutRu = stripQuotedHistory('Мой ответ.\n19 окт. 2026 г., 15:53 пользователь X написал:\nСтарое письмо');
    assert.equal(cutRu, 'Мой ответ.');
    const kept = stripQuotedHistory('Please focus on what the author wrote:\nMore of my own text.');
    assert.match(kept, /More of my own text/);
  });

  it('cuts >-quoted lines', () => {
    const out = aiMessageText({ text: 'My answer.\n> Old line one\n> Old line two' });
    assert.equal(out, 'My answer.');
  });

  it('drops bare URLs and [image:] placeholders, keeps the words around them', () => {
    const out = aiMessageText({ html: '<p>See <a href="https://www.asus.com/fi/support/">ASUS Support</a>'
      + ' or https://example.com/track?x=1 and <https://example.com/2></p><p>[image: Banner]</p>' });
    assert.equal(out, 'See ASUS Support or and');
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
