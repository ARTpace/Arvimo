import test from 'node:test';
import assert from 'node:assert/strict';
import {PICTURE_SITES as server} from '../server/picture-sites.mjs';
import {PICTURE_SITES as front, PICTURE_SITE_GROUPS} from '../src/library/platforms.js';
test('all platform ids, resolvers, routes and groups agree', () => {
  assert.deepEqual(Object.keys(server).sort(), Object.keys(front).sort());
  for (const [id, site] of Object.entries(server)) {
    assert.equal(site.id, id);
    assert.equal(typeof site.resolve, 'function');
    assert.equal(front[id].id, id);
    assert.ok(front[id].hosts?.length, id);
  }
  const grouped = PICTURE_SITE_GROUPS.flatMap(group => group.sites.map(site => site.id));
  assert.equal(new Set(grouped).size, grouped.length);
  assert.deepEqual(grouped.sort(), Object.keys(front).sort());
});
