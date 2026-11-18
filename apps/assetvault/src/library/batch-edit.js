import {showActionCard} from './action-card.js';
// 批量整理：选中一批资产后统一打标 / 评分 / 收藏 / 写备注。
//
// 为什么不直接 POST /api/library/tags/mutate：那条接口要自己处理 uid 格式校验、
// 800 条 op 上限、rev 冲突与事件广播。这里只改 state 的用户域，再走既有的
// persistNow() —— tag-ops 差量层会把它翻译成同样的集合语义 op，单资产打标也是这条路。
// 两处各写一套写入逻辑必然走样，所以这里一处 fetch 都不发。
import {setUserMeta} from './library-state.js';

export function createBatchEdit({
  state, esc = value => String(value), toast = () => {},
  persistNow = () => {}, renderGrid = () => {}, document: doc = globalThis.document,
} = {}) {
  if (!state) throw Error('批量整理缺少 state');
  const dialog = doc.createElement('dialog');
  dialog.className = 'bd-dialog be-dialog';
  dialog.setAttribute('aria-label', '批量整理选中资产');
  dialog.innerHTML = `
    <div class="bd-head"><span class="bd-head-ic">✎</span>
      <strong>批量整理</strong><span class="be-count" role="status"></span>
      <button type="button" class="icon-button" data-act="close" aria-label="关闭">×</button></div>
    <div class="dialog-body be-body">
      <p class="compact-note">留空的项一律不改；标签用逗号分隔，可一次写多个。改动只落在用户域，平台标签与 AI 标签不受影响。</p>
      <label class="field"><span>添加标签</span><input type="text" class="be-add" maxlength="400" placeholder="例如：角色, 待精修" aria-label="添加标签"></label>
      <label class="field"><span>移除标签</span><input type="text" class="be-remove" maxlength="400" placeholder="只移除「我的标签」" aria-label="移除标签"></label>
      <div class="be-row">
        <label class="field"><span>评分</span><select class="be-rating" aria-label="评分">
          <option value="">不改</option>${[0, 1, 2, 3, 4, 5].map(n => `<option value="${n}">${n} 星</option>`).join('')}
        </select></label>
        <label class="field"><span>收藏</span><select class="be-fav" aria-label="收藏">
          <option value="">不改</option><option value="yes">设为收藏</option><option value="no">取消收藏</option>
        </select></label>
      </div>
      <label class="field"><span>备注（填 - 清空）</span><textarea class="be-note" rows="2" maxlength="2000" placeholder="留空不改" aria-label="备注"></textarea></label>
      <p class="be-status compact-note" role="status" aria-live="polite"></p>
    </div>
    <div class="bd-foot"><span></span><button type="button" class="primary" data-act="apply">应用</button></div>`;
  doc.body.appendChild(dialog);

  const field = selector => dialog.querySelector(selector);
  const tags = value => [...new Set(String(value || '').split(/[,，;；]/)
    .map(item => item.trim()).filter(Boolean))].slice(0, 50);
  let uids = [];

  function open() {
    uids = [...new Set([...(state.selected || [])])].filter(Boolean);
    if (!uids.length) { toast('先选中资产，再批量整理'); return; }
    field('.be-count').textContent = `${uids.length} 个资产`;
    field('.be-status').textContent = '';
    for (const selector of ['.be-add', '.be-remove', '.be-note']) field(selector).value = '';
    field('.be-rating').value = '';
    field('.be-fav').value = '';
    showActionCard(dialog);
  }

  function apply() {
    const add = tags(field('.be-add').value);
    const remove = tags(field('.be-remove').value);
    const rating = field('.be-rating').value;
    const favorite = field('.be-fav').value;
    const note = field('.be-note').value;
    if (!add.length && !remove.length && rating === '' && favorite === '' && note === '') {
      field('.be-status').textContent = '没有填写任何改动';
      return;
    }
    for (const uid of uids) {
      if (add.length || remove.length) {
        const current = new Set(Array.isArray(state.userTags?.[uid]) ? state.userTags[uid] : []);
        for (const tag of add) current.add(tag);
        for (const tag of remove) current.delete(tag);
        state.userTags = {...(state.userTags || {}), [uid]: [...current]};
      }
      if (rating !== '' || note !== '') {
        setUserMeta(state, uid, {
          ...(rating !== '' ? {rating: Number(rating)} : {}),
          ...(note !== '' ? {note: note === '-' ? '' : note} : {}),
        });
      }
      if (favorite === 'yes') state.favorites?.add(uid);
      else if (favorite === 'no') state.favorites?.delete(uid);
    }
    persistNow();
    renderGrid();
    toast(`已整理 ${uids.length} 个资产`);
    dialog.close();
  }

  dialog.addEventListener('click', event => {
    const action = event.target.closest?.('[data-act]')?.dataset.act;
    if (action === 'close') dialog.close();
    if (action === 'apply') apply();
  });

  const bar = doc.querySelector('#selection-bar');
  if (bar) {
    const button = doc.createElement('button');
    button.type = 'button';
    button.className = 'secondary be-open';
    button.title = '批量给选中资产打标签、改评分与收藏';
    button.textContent = '整理';
    button.addEventListener('click', open);
    bar.appendChild(button);
  }

  return {open, apply, dialog, esc};
}
