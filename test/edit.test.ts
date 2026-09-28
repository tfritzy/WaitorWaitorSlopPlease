import assert from 'node:assert/strict';
import test from 'node:test';
import { parseEdit, requestBody } from '../src/edit';

test('request includes only instruction, cursor, and current file', () => {
  const body = requestBody('openrouter/auto', 'rename this', { line: 2, column: 3 }, 'a\nb');
  assert.deepEqual(JSON.parse(body.messages[1].content), {
    instruction: 'rename this', cursor: { line: 2, column: 3 }, file: 'a\nb'
  });
  assert.equal(body.response_format.type, 'json_schema');
  assert.equal(body.response_format.json_schema.strict, true);
  assert.deepEqual(body.response_format.json_schema.schema.required,
    ['oldText', 'replacement']);
  assert.equal(body.provider.require_parameters, true);
});

test('applies an exact multiline edit with CRLF and UTF-16 text before it', () => {
  const content = '😀\r\nalpha\r\nbeta\r\n';
  const edit = parseEdit(JSON.stringify({ oldText: 'alpha\r\nbeta', replacement: 'gamma\r\ndelta' }), content, 0);
  assert.deepEqual(edit, { startOffset: 4, endOffset: 15, replacement: 'gamma\r\ndelta' });
  assert.equal(content.slice(0, edit.startOffset) + edit.replacement + content.slice(edit.endOffset), '😀\r\ngamma\r\ndelta\r\n');
});

test('inserts at the actual cursor offset', () => {
  assert.deepEqual(parseEdit('{"oldText":"","replacement":"X"}', 'abc', 2), {
    startOffset: 2, endOffset: 2, replacement: 'X'
  });
});

test('rejects text that is missing or ambiguous', () => {
  assert.throws(() => parseEdit('{"oldText":"xyz","replacement":"X"}', 'abc', 0), /does not exactly match/);
  assert.throws(() => parseEdit('{"oldText":"abc","replacement":"X"}', 'abc abc', 0), /more than once/);
});

test('uses an exclusive end offset at both file edges', () => {
  const first = parseEdit('{"oldText":"a","replacement":""}', 'abc', 0);
  assert.deepEqual(first, { startOffset: 0, endOffset: 1, replacement: '' });
  assert.equal('abc'.slice(0, first.startOffset) + first.replacement + 'abc'.slice(first.endOffset), 'bc');

  const last = parseEdit('{"oldText":"c","replacement":"X"}', 'abc', 0);
  assert.deepEqual(last, { startOffset: 2, endOffset: 3, replacement: 'X' });
  assert.equal('abc'.slice(0, last.startOffset) + last.replacement + 'abc'.slice(last.endOffset), 'abX');
});

test('rejects partial line endings and surrogate pairs', () => {
  assert.throws(() => parseEdit('{"oldText":"\\n","replacement":"X"}', 'a\r\nb', 0), /cuts through/);
  assert.throws(() => parseEdit(JSON.stringify({ oldText: '\ud83d', replacement: 'X' }), '😀', 0), /cuts through/);
});
