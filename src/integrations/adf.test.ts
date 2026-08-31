import assert from 'node:assert/strict';
import { test } from 'node:test';

import { firstParagraph } from './adf.js';

const doc = (...content: unknown[]) => ({ type: 'doc', version: 1, content });
const para = (...text: string[]) => ({
  type: 'paragraph', content: text.map((t) => ({ type: 'text', text: t })),
});

test('takes the first paragraph of an ADF document', () => {
  assert.equal(
    firstParagraph(doc(para('The storage adapter still uses SDK v2.'), para('Second paragraph.'))),
    'The storage adapter still uses SDK v2.',
  );
});

test('flattens mentions, links and breaks into readable text', () => {
  const node = doc({
    type: 'paragraph',
    content: [
      { type: 'text', text: 'Ask ' },
      { type: 'mention', attrs: { text: '@a.ruiz' } },
      { type: 'hardBreak' },
      { type: 'text', text: 'about it' },
    ],
  });
  assert.equal(firstParagraph(node), 'Ask @a.ruiz about it');
});

test('skips leading structure that carries no text', () => {
  assert.equal(firstParagraph(doc({ type: 'rule' }, para('Actual text.'))), 'Actual text.');
});

test('reads Jira Server wiki markup too', () => {
  assert.equal(
    firstParagraph('h2. Heading\n*Bold* text with a [link|http://x].\n\nSecond block.'),
    'Heading Bold text with a link.',
  );
});

test('truncates long paragraphs on a word boundary', () => {
  const long = `${'word '.repeat(200)}end`;
  const out = firstParagraph(long, 40) as string;
  assert.ok(out.length <= 41, `got ${out.length}`);
  assert.ok(out.endsWith('…'));
  assert.ok(!out.includes('wor…'));
});

test('empty and missing descriptions come back as null', () => {
  assert.equal(firstParagraph(null), null);
  assert.equal(firstParagraph(undefined), null);
  assert.equal(firstParagraph(''), null);
  assert.equal(firstParagraph(doc()), null);
  assert.equal(firstParagraph(doc(para(''))), null);
});
