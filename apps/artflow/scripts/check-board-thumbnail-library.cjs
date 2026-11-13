const assert = require('node:assert/strict');
require('./register-typescript.cjs');
const React = require('react');
const {renderToStaticMarkup} = require('react-dom/server');
const {BoardThumbnail} = require('../components/BoardThumbnail.tsx');
const board = {name: '库内画板', canvasBackgroundColor: '#123456', elements: [
  {id: 'image', type: 'image', x: 10, y: 20, width: 100, height: 80,
    href: '/api/local/file?root=library&rel=图片.png', opacity: 0},
]};
const html = renderToStaticMarkup(React.createElement(BoardThumbnail, {board, label: board.name}));
assert.match(html, /^<svg /);
assert.match(html, /<image[^>]+href="\/api\/local\/file\?root=library&amp;rel=图片.png"/);
assert.doesNotMatch(html, /data:image\/svg|<img /);
assert.match(html, /opacity="0"/);
assert.match(html, /background-color:#123456/);
const crowded = {...board, elements: Array.from({length: 30}, (_, id) => ({...board.elements[0], id: String(id)}))};
const collage = renderToStaticMarkup(React.createElement(BoardThumbnail, {board: crowded, label: '多图画板'}));
assert.equal((collage.match(/<image /g) || []).length, 4);
assert.match(collage, /viewBox="0 0 120 80"/);
assert.match(collage, /preserveAspectRatio="xMidYMid slice"/);
assert.doesNotMatch(renderToStaticMarkup(React.createElement(BoardThumbnail, {board: {...board, elements: []}, label: '空画板'})), /Infinity|NaN/);
console.log('board-thumbnail: inline library references, XML escaping and empty boards passed');
