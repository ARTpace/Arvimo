import test from 'node:test';
import assert from 'node:assert/strict';
import {parse500pxUrl} from '../server/picture-sites.mjs';

test('500px profile routes preserve usernames including digits', () => {
  for (const path of ['/p/lichtgespiele', '/user/lichtgespiele', '/lichtgespiele', '/p/artist123', '/p/123']) {
    assert.deepEqual(parse500pxUrl(`https://500px.com${path}`), {username: path.split('/').pop()});
  }
});

test('500px photo routes preserve the complete numeric or node ID', () => {
  assert.deepEqual(parse500pxUrl('https://500px.com/photo/312711831/title'), {photoId: '312711831'});
  assert.deepEqual(parse500pxUrl('https://500px.com/photo/abc123_X'), {photoId: 'abc123_X'});
  for (const path of ['/p/', '/user/', '/photo/', '/popular', '/search']) {
    assert.throws(() => parse500pxUrl(`https://500px.com${path}`));
  }
  assert.throws(() => parse500pxUrl('https://example.com/p/lichtgespiele'));
});
