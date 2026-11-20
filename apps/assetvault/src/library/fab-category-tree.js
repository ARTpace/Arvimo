/**
 * Fab 分类树：产品类型 → 母类 → 子类 → 子子类，默认全部折叠。
 *
 * 数据来自 scripts/fetch-fab-categories.mjs 生成的 fab-categories.js（Fab 官方分类树）。
 * 选中任意一层都会写成请求参数 categories=<slug path>（"a/b/c" 换成 "a--b--c"），
 * Fab 那边对三级 slug 实测有效，所以母类过滤和子子类过滤都能用同一套参数。
 *
 * 类型（material / 3d-model …）本身就是这棵树的根：Fab 的分类是分片存的，一份类型一套树。
 * 之前把「类型」「分类」分成两个分支，上面列 14 个类型、下面又把同样的 14 个名字当分组标题
 * 重画一遍 —— 看着就是一屏重复项。现在合成一棵：根行是类型，展开才是它的分类。
 *
 * 类型行只负责改类型（点名字选中/再点取消，点箭头展开），分类行负责选中分类；折叠与选中
 * 始终分开，免得点名字时把树抖开。
 */

const pathToSlug = path => String(path || '').replace(/\//g, '--');

/** 一行「圆点 + 文本」，与筛选树里的叶子同构，尺寸由 .ftree-leaf 决定。 */
function nameButton(label) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'ftree-leaf fab-cat-name';
  button.append(document.createElement('i'), document.createElement('span'));
  button.firstChild.className = 'ftree-dot';
  button.lastChild.className = 'ftree-leaf-label';
  button.lastChild.textContent = label;
  return button;
}

function caretSpan(empty) {
  const caret = document.createElement('span');
  caret.className = empty ? 'fab-cat-caret is-empty' : 'fab-cat-caret';
  return caret;
}

function renderCategory(node, depth, api, type) {
  const details = document.createElement('details');
  details.className = 'fab-cat-node';
  details.dataset.path = node.path;
  details.dataset.depth = String(depth);

  const summary = document.createElement('summary');
  summary.className = 'fab-cat-head';

  const children = node.children || [];
  // 有子类才画折叠箭头；没有的留一个同宽空位，让各层的圆点对齐在同一列。
  summary.append(caretSpan(!children.length));

  const name = nameButton(node.name);
  name.dataset.path = node.path;
  name.dataset.name = node.name;
  name.title = node.path;
  // summary 的默认行为是折叠/展开；点名字要选中分类，所以这里掐掉冒泡。
  name.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    api.pickCategory(node, type);
  });

  summary.append(name);
  details.append(summary);

  for (const child of children) details.append(renderCategory(child, depth + 1, api, type));
  return details;
}

export function createFabCategoryTree({mount, groups = [], types = [], onChange = () => {}}) {
  let pickedType = '';
  let pickedCategory = null;

  const api = {
    pickType(value, row) {
      pickedType = pickedType === value ? '' : value;
      pickedCategory = null;
      // 选类型顺手展开它、并把其它类型折回去（同屏只留一棵展开的树），省得来回点箭头。
      for (const node of mount.querySelectorAll('details.fab-cat-type')) {
        node.open = node === row && pickedType === value;
      }
      emit();
    },
    pickCategory(node, type) {
      const same = pickedCategory && pickedCategory.path === node.path;
      pickedCategory = same ? null : {path: node.path, slug: pathToSlug(node.path), name: node.name};
      pickedType = type;
      emit();
    },
  };

  function emit() {
    onChange({type: pickedType, category: pickedCategory});
    paint();
  }

  function paint() {
    for (const button of mount.querySelectorAll('.fab-cat-name')) {
      const on = button.dataset.role === 'type'
        ? button.dataset.type === pickedType
        : button.dataset.path === pickedCategory?.path;
      button.classList.toggle('active', !!on);
    }
  }

  /** 只铺第一层类型：分类按需在展开时才建 DOM，别一次性塞 700 多个节点进去。 */
  function render() {
    mount.textContent = '';
    const fragment = document.createDocumentFragment();

    for (const type of types) {
      const group = groups.find(item => item.type === type.value);
      const label = type.label || type.value;
      const row = nameButton(label);
      row.dataset.role = 'type';
      row.dataset.type = type.value;

      if (!group || !group.nodes.length) {
        // 没有分类树的类型也留一行，只用来选类型。
        const flat = document.createElement('div');
        flat.className = 'fab-cat-head';
        flat.append(caretSpan(true), row);
        row.addEventListener('click', () => api.pickType(type.value, null));
        fragment.append(flat);
        continue;
      }

      const details = document.createElement('details');
      details.className = 'fab-cat-node fab-cat-type';
      details.dataset.depth = '1';
      details.dataset.type = type.value;

      const summary = document.createElement('summary');
      summary.className = 'fab-cat-head';
      summary.append(caretSpan(false));
      row.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        api.pickType(type.value, details);
      });
      summary.append(row);
      details.append(summary);

      details.addEventListener('toggle', () => {
        if (!details.open || details.dataset.built) return;
        details.dataset.built = '1';
        for (const node of group.nodes) details.append(renderCategory(node, 2, api, type.value));
        paint();
      });

      fragment.append(details);
    }

    mount.append(fragment);
    paint();
  }

  function reset() {
    const changed = pickedType || pickedCategory;
    pickedType = '';
    pickedCategory = null;
    for (const node of mount.querySelectorAll('details')) node.open = false;
    paint();
    if (changed) onChange({type: '', category: null});
  }

  /** 外部（历史回放、重置）改了 #fab-type 时同步回来。 */
  function setType(value) {
    const next = value || '';
    if (next === pickedType) return;
    pickedType = next;
    pickedCategory = null;
    paint();
  }

  return {render, reset, setType, value: () => ({type: pickedType, category: pickedCategory})};
}
