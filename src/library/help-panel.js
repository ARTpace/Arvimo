// 使用说明 + 帮助与反馈合并成一个面板：同一个 dialog，顶部两个页签。
//
// 单独成一个模块，是因为 feedback.js 需要「把面板切到反馈页」，
// 而 feedback.js 不能反向被这里 import（会形成循环依赖）。
// 面板本体是 index.html 里的静态标记（#help-dialog + [data-help-panel]），
// 这里只负责切页签与打开，不生成任何 DOM。
const DIALOG_ID = 'help-dialog';
const TABS = ['guide', 'feedback'];

let wired = false;

const tabs = () => [...document.querySelectorAll('[data-help-tab]')];
const panels = () => [...document.querySelectorAll('[data-help-panel]')];

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

/** 打开合并面板；tab 决定先看哪一页。 */
export function openHelp(tab = 'guide') {
  const dialog = document.getElementById(DIALOG_ID);
  if (!dialog) return;
  if (!wired) {
    wired = true;
    for (const node of tabs()) {
      node.addEventListener('click', () => showHelpTab(node.dataset.helpTab));
    }
  }
  showHelpTab(tab);
  // 已经在面板里翻页时不重新 showModal，免得把「反馈草稿」的光标位置打断。
  if (!dialog.open) dialog.showModal();
}
