require('./register-typescript.cjs');
const assert = require('node:assert/strict');
const react = require('react');
const original = Object.fromEntries(['useCallback', 'useRef', 'useMemo', 'useSyncExternalStore'].map(key => [key, react[key]]));
try {
  react.useCallback = callback => callback;
  react.useRef = current => ({current});
  react.useMemo = calculate => calculate();
  react.useSyncExternalStore = (_subscribe, read) => read();
  const canvas = require('../hooks/useCanvasState.ts').useCanvasState();
  assert.equal(canvas.documentState.getSnapshot().boards.length, 1);
  assert.equal(canvas.loadBoardData({format:'artflow-project',version:2,boards:[],nodes:[],assets:[]}), true);
  assert.deepEqual(canvas.documentState.getSnapshot().boards, []);
  assert.equal(canvas.documentState.getSnapshot().activeBoardId, '');
  assert.throws(() => canvas.loadBoardData({broken:true}));
  assert.deepEqual(canvas.documentState.getSnapshot().boards, []);
  console.log('Empty board restore clears stale boards; invalid documents remain rejected.');
} finally {
  Object.assign(react, original);
}
