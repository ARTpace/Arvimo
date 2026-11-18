// 应用内问答弹窗：标题栏 + 一段说明 + 可选输入框 + 确定/取消。
//
// 为什么不用 window.prompt / confirm / alert：WebView2 会把它们画成
// 「127.0.0.1:xxxx 显示」的系统框，配色、圆角、按钮全和工具不是一套，
// 而且会盖住整个窗口、连遮罩都没有。
//
// 这里复用 index.html 里既有的 <dialog> + .dialog-header / .dialog-body 体系，
// 一个 dialog 复用到底（不每次建节点），四种交互：
//   askText    输入一行文字 → string | null
//   askConfirm 确认一件事   → boolean
//   askNotice  只告知       → undefined
//   askChoice  从列表里选   → value | null
// 全部返回 Promise；Esc、右上角 ×、取消按钮都走同一条 settle 路径，绝不悬挂。

import {showActionCard} from './action-card.js';
let ui = null;
let pending = null;

const isTextMode = mode => mode === 'text';

function ensureUi() {
  if (ui) return ui;
  if (typeof document === 'undefined' || !document.body) return null;
  const dialog = document.createElement('dialog');
  dialog.className = 'av-ask-dialog';
  dialog.innerHTML = `<div class="dialog-header"><span data-ask-title></span><button type="button" class="icon-button" data-ask-close aria-label="关闭">×</button></div>
    <form class="av-ask-form" novalidate>
      <div class="av-ask-body">
        <p class="av-ask-message" data-ask-message hidden></p>
        <input class="av-ask-input" type="text" data-ask-input spellcheck="false" autocomplete="off" aria-label="输入内容">
        <div class="av-ask-choices" data-ask-choices hidden></div>
      </div>
      <div class="av-ask-foot">
        <button type="button" class="secondary" data-ask-cancel>取消</button>
        <button type="submit" class="primary" data-ask-ok>确定</button>
      </div>
    </form>`;
  document.body.appendChild(dialog);

  const q = selector => dialog.querySelector(selector);
  ui = {
    dialog,
    form: q('.av-ask-form'),
    title: q('[data-ask-title]'),
    message: q('[data-ask-message]'),
    input: q('[data-ask-input]'),
    choices: q('[data-ask-choices]'),
    ok: q('[data-ask-ok]'),
    cancel: q('[data-ask-cancel]'),
  };

  // 原生 close 事件是唯一兜底：Esc、点遮罩外部、代码 close() 都会回到这里。
  dialog.addEventListener('close', () => {
    const entry = pending;
    pending = null;
    if (!entry) return;
    entry.resolve(cancelValue(entry.mode));
  });

  const cancelNow = () => settle(pending ? cancelValue(pending.mode) : undefined);
  q('[data-ask-close]').addEventListener('click', cancelNow);
  ui.cancel.addEventListener('click', cancelNow);

  ui.form.addEventListener('submit', event => {
    event.preventDefault();
    if (!pending || pending.mode === 'choice') return;
    settle(pending.mode === 'text' ? ui.input.value : pending.mode === 'confirm' ? true : undefined);
  });

  return ui;
}

/** 每种交互「取消」对应的返回值。 */
function cancelValue(mode) {
  return isTextMode(mode) || mode === 'choice' ? null : false;
}

function settle(value) {
  const entry = pending;
  pending = null;
  if (ui?.dialog?.open) { try { ui.dialog.close(); } catch { /* 已经关了 */ } }
  entry?.resolve(value);
}

function open({
  mode = 'confirm',
  title = '请确认',
  message = '',
  value = '',
  placeholder = '',
  confirmText = '确定',
  cancelText = '取消',
  danger = false,
  maxLength = 200,
  choices = null,
  hideCancel = false,
} = {}) {
  const view = ensureUi();
  if (!view) return Promise.resolve(cancelValue(mode));
  // 上一个还没答完就被新问题顶掉：先当取消收尾，免得调用方永久 await。
  if (pending) settle(cancelValue(pending.mode));

  const text = isTextMode(mode);
  view.title.textContent = title;
  view.message.textContent = message || '';
  view.message.hidden = !message;
  view.input.hidden = !text;
  view.input.value = text ? String(value ?? '') : '';
  view.input.placeholder = placeholder || '';
  view.input.maxLength = Math.max(1, maxLength);
  view.choices.hidden = !choices?.length;
  view.choices.replaceChildren();
  for (const item of choices || []) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'av-ask-choice';
    button.textContent = item.label;
    button.addEventListener('click', () => settle(item.value));
    view.choices.append(button);
  }
  view.ok.hidden = mode === 'choice';
  view.ok.textContent = confirmText;
  view.ok.classList.toggle('danger', !!danger && mode !== 'choice');
  view.cancel.textContent = cancelText;
  view.cancel.hidden = hideCancel;

  return new Promise(resolve => {
    pending = {mode, resolve};
    showActionCard(view.dialog);
    if (text) { view.input.focus(); view.input.select(); }
    else if (choices?.length) view.choices.querySelector('button')?.focus();
    else if (!view.ok.hidden) view.ok.focus();
    else view.cancel.focus();
  });
}

/** 输入一行文字。返回去掉首尾空白的字符串；取消返回 null。 */
export async function askText(options) {
  const value = await open({title: '输入', ...toOption(options), mode: 'text'});
  return typeof value === 'string' ? value.trim() : null;
}

/** 确认一件事。返回 true / false。 */
export function askConfirm(options) {
  return open({title: '请确认', ...toOption(options), mode: 'confirm'});
}

/** 只告知，不需要选择。 */
export function askNotice(options) {
  const opts = toOption(options);
  return open({title: '提示', ...opts, mode: 'notice', hideCancel: true, confirmText: opts.confirmText || '知道了'});
}

/** 从一组选项里挑一个，返回 item.value；取消返回 null。 */
export function askChoice(options) {
  return open({title: '请选择', ...toOption(options), mode: 'choice'});
}

/** 允许 askXxx('一句话') 的简写：当成 message 用。 */
function toOption(options) {
  if (typeof options === 'string') return {message: options};
  return options || {};
}
