require('./register-typescript.cjs');
const assert = require('node:assert/strict');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { CanvasElement } = require('../components/CanvasElement.tsx');
const group = { id: 'group', type: 'group', name: 'Group', x: 0, y: 0, width: 100, height: 100, rotation: 0 };
const props = { elements: [group], selectedElementIds: ['group'], zoom: 1, editingElement: null, croppingState: null, aiRotationState: null, setEditingElement() {} };
const render = element => renderToStaticMarkup(React.createElement('svg', null, React.createElement(CanvasElement, { ...props, element })));
const html = render(group);
assert.doesNotMatch(html, /Card unavailable|foreignObject/, 'builtin group must not render a missing-plugin card');
assert.match(render({ ...group, id: 'missing', type: 'missing-plugin-card' }), /Card unavailable/, 'unknown plugin cards retain their recovery placeholder');
console.log('PASS builtin groups render as containers; missing plugin cards retain their placeholder');

// Cover every built-in Element member, so another omitted renderer cannot silently
// fall through to the missing-plugin placeholder like group did.
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const { CARD_PLUGINS } = require('../builtin-plugins/cards/index.tsx');
const { materializeRendererContributions, getMaterializedCardComponent } = require('../plugin-runtime/renderer-materialization.ts');
const contributions = [];
for (const plugin of CARD_PLUGINS) plugin.activate({ contributions: {
  register(slot, entry) { assert.equal(slot, 'canvas_node_types'); contributions.push(entry); return () => {}; },
} });
materializeRendererContributions({ contributions: { list: () => contributions } });
const source = ts.createSourceFile('types.ts', fs.readFileSync(path.join(__dirname, '../types.ts'), 'utf8'), ts.ScriptTarget.Latest, true);
const union = source.statements.find(node => ts.isTypeAliasDeclaration(node) && node.name.text === 'Element');
const primitiveTypes = new Set(['group', 'path', 'arrow', 'line', 'text', 'shape', 'image', 'frame']);
const fixture = { ...group, points: [{ x: 0, y: 0 }, { x: 20, y: 20 }], strokeColor: '#fff', strokeWidth: 2,
  shapeType: 'rectangle', fillColor: '#fff', text: 'test', fontSize: 16, fontColor: '#fff', href: '/test.png', mimeType: 'image/png' };
let checked = 0;
for (const member of union.type.types) {
  const declaration = source.statements.find(node => ts.isInterfaceDeclaration(node) && node.name.text === member.typeName.text);
  const discriminator = declaration.members.find(node => node.name?.getText(source) === 'type');
  const type = discriminator.type.literal.text;
  if (type === 'plugin-node') continue; // Plugin-owned nodes intentionally require their plugin.
  if (primitiveTypes.has(type)) {
    assert.doesNotMatch(render({ ...fixture, id: `builtin-${type}`, type }), /Card unavailable/, `${type} needs a core renderer`);
  } else {
    assert.ok(getMaterializedCardComponent(type), `${type} needs a registered built-in card`);
  }
  checked++;
}
assert.equal(checked, 18);
console.log(`PASS all ${checked} built-in element types have a core renderer or registered card`);
