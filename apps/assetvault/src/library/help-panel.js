// 使用说明 + 帮助与反馈合并成一个面板：同一个 dialog，顶部两个页签。
//
// 单独成一个模块，是因为 feedback.js 需要「把面板切到反馈页」，
// 而 feedback.js 不能反向被这里 import（会形成循环依赖）。
// 面板本体是 index.html 里的静态标记（#help-dialog + [data-help-panel]），
// 这里只负责切页签、开合章节与打开，不生成任何 DOM。
const DIALOG_ID = 'help-dialog';
const TABS = ['guide', 'feedback'];

let wired = false;

const tabs = () => [...document.querySelectorAll('[data-help-tab]')];
const panels = () => [...document.querySelectorAll('[data-help-panel]')];
const sections = () => [...document.querySelectorAll('[data-help-sec]')];
const jumps = () => [...document.querySelectorAll('[data-help-jump]')];

/** 切页签：guide = 使用说明，feedback = 问题反馈 / 功能建议。 */
export function showHelpTab(name = 'guide') {
  const next = TABS.includes(name) ? name : 'guide';
  for (const tab of tabs()) {
    const on = tab.dataset.helpTab === next;
    tab.classList.toggle('active', on);
    tab.setAttribute('aria-selected', String(on));
  }
  for (const panel of panels()) panel.hidden = panel.dataset.helpPanel !== next;
  return next;
}

/** 顶部章节速览跟着当前展开的一节高亮。 */
function paintJumps(name) {
  for (const chip of jumps()) {
    const on = chip.dataset.helpJump === name;
    chip.classList.toggle('active', on);
    chip.setAttribute('aria-current', on ? 'true' : 'false');
  }
}

/** 章节手风琴：同一时刻只展开一节，避免「又长又杂」。点速览时顺带滚到该节。 */
export function openSection(name, { scroll = false } = {}) {
  const target = sections().find(node => node.dataset.helpSec === name);
  if (!target) return;
  for (const node of sections()) node.open = node === target;
  paintJumps(name);
  if (scroll) target.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
  return name;
}

/** 章节互斥 + 速览点选。测试环境的 document 桩对这两个选择器返回空数组，天然跳过。 */
function wireGuide() {
  for (const node of sections()) {
    node.addEventListener('toggle', () => {
      if (node.open) openSection(node.dataset.helpSec);
    });
  }
  for (const chip of jumps()) {
    chip.addEventListener('click', () => openSection(chip.dataset.helpJump, { scroll: true }));
  }
}

/** 打开合并面板；tab 决定先看哪一页。 */
export function openHelp(tab = 'guide') {
  const dialog = document.getElementById(DIALOG_ID);
  if (!dialog) return;
  if (!wired) {
    wired = true;
    for (const node of tabs()) {
      node.addEventListener('click', () => showHelpTab(node.dataset.helpTab));
    }
    wireGuide();
  }
  showHelpTab(tab);
  // 已经在面板里翻页时不重新 showModal，免得把「反馈草稿」的光标位置打断。
  if (!dialog.open) dialog.showModal();
}
