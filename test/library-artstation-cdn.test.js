// Covers for the ArtStation CDN: the grid asks for `medium`, but the search API only advertises the
// square rendition, and that one lives inside a timestamp folder its siblings do not have.
//
// Regression anchor: asking for a sibling while keeping the timestamp (`…/20181004021932/medium/x.jpg`)
// used to 403, which silently blanked ~39% of the ArtStation grid. Every case below is a real URL
// shape taken from the live API (sorted=likes, asset_types=marmoset, 300 samples).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ARTSTATION_COVER_RENDITION,ARTSTATION_COVER_LADDER,
  artstationCdnUrl,artstationRenditionUrl,coverUrl,coverLadder,
} from '../server/artstation-cdn.mjs';

// Plain shape: no timestamp folder, so only the rendition changes. This is the one the old test
// covered — and the only shape the old code got right.
const plain='https://cdna.artstation.com/p/assets/covers/images/011/655/236/smaller_square/artvostok-stumb.jpg?1530700342';
// Nested shape: the square rendition sits under `YYYYMMDDHHMMSS/`, every sibling does not.
const dated='https://cdna.artstation.com/p/assets/images/images/013/225/918/20181004021932/smaller_square/frederic-arsenault-full-beauty-name.jpg?1538637573';

test('artstation-cdn: the square rendition is upgraded to the requested one',()=>{
  assert.equal(coverUrl(plain),plain.replace('/smaller_square/','/medium/'));
  assert.equal(coverUrl(dated),dated.replace('/20181004021932/smaller_square/','/medium/'));
  assert.equal(ARTSTATION_COVER_RENDITION,'medium');
});

test('artstation-cdn: the timestamp folder is dropped, never kept alongside a sibling rendition',()=>{
  // The exact URL that broke the grid: keeping `20181004021932/` makes the bucket answer 403.
  const kept=dated.replace('/smaller_square/','/medium/');
  assert.equal(coverUrl(dated).includes('/20181004021932/'),false);
  assert.notEqual(coverUrl(dated),kept);
  for(const rendition of ['medium','large','small'])assert.equal(artstationRenditionUrl(dated,rendition).href.includes('/20181004021932/'),false);
  // Rendition names are matched structurally (`<rendition>/<file>` tail), not from a fixed list,
  // so an unknown rendition name upstream still gets repointed instead of silently passing through.
  assert.equal(coverUrl(dated,{rendition:'gigantic'}),dated.replace('/20181004021932/smaller_square/','/gigantic/'));
});

test('artstation-cdn: host, scheme and query string are preserved',()=>{
  assert.equal(coverUrl(plain.replace('cdna.','cdnb.')).startsWith('https://cdnb.artstation.com/'),true);
  assert.equal(new URL(coverUrl(plain)).search,'?1530700342');
  // User-avatar style paths (`/p/users/covers/…/small/x.jpg`) follow the same tail rule.
  assert.equal(coverUrl('https://cdna.artstation.com/p/users/covers/000/152/514/small/9d7.jpg?1'),'https://cdna.artstation.com/p/users/covers/000/152/514/medium/9d7.jpg?1');
  // A directory-ish path has no `<rendition>/<file>` tail: hand it back untouched rather than guess.
  assert.equal(coverUrl('https://cdna.artstation.com/p/assets/covers/011/655/236/smaller_square/'),'https://cdna.artstation.com/p/assets/covers/011/655/236/smaller_square/');
});

test('artstation-cdn: only ArtStation HTTPS assets are ever rewritten',()=>{
  assert.equal(coverUrl('https://evil.example.com/smaller_square/x.jpg'),null);
  assert.equal(coverUrl('http://cdna.artstation.com/smaller_square/x.jpg'),null);
  assert.equal(coverUrl('https://cdna.artstation.com.evil.example/smaller_square/x.jpg'),null);
  assert.equal(coverUrl(null),null);
  assert.equal(coverUrl(''),null);
  assert.equal(coverUrl('not a url'),null);
  assert.equal(coverUrl('https://media.sketchfab.com/models/x/thumbnails/large.jpg'),null);
  assert.equal(artstationCdnUrl('https://media.sketchfab.com/x.jpg'),null);
  assert.equal(artstationCdnUrl('https://cdna.artstation.com/x.jpg').hostname,'cdna.artstation.com');
});

test('artstation-cdn: the ladder starts with the requested URL and stays deduped',()=>{
  assert.deepEqual(coverLadder(dated),[
    dated, // as requested — the proxy tries this first and only falls back on a 4xx
    dated.replace('/20181004021932/smaller_square/','/medium/'),
    dated.replace('/20181004021932/smaller_square/','/large/'),
    dated.replace('/20181004021932/smaller_square/','/small/'),
  ]);
  // Already the wanted rendition: no duplicate entries, no pointless extra requests.
  const medium=dated.replace('/20181004021932/smaller_square/','/medium/');
  assert.equal(coverLadder(medium)[0],medium);
  assert.equal(coverLadder(medium)[1],medium.replace('/medium/','/large/'));
  assert.equal(new Set(coverLadder(medium)).size,coverLadder(medium).length);
  // Not an ArtStation CDN asset (e.g. a Sketchfab thumbnail): exactly one candidate, never touched.
  assert.deepEqual(coverLadder('https://media.sketchfab.com/x/large.jpg'),['https://media.sketchfab.com/x/large.jpg']);
  assert.deepEqual(coverLadder(null),[]);
  assert.equal(ARTSTATION_COVER_LADDER[0],ARTSTATION_COVER_RENDITION);
});
