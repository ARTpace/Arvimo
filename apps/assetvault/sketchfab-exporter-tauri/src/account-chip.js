/* 侧栏底部的账号条：显示当前登录的人，点开改密码，右侧一键退出。
 *
 * 单独一支小脚本、不进 app.js：它只是给 .side-footer 上面补一块 UI，
 * 和主工作台的启动流程完全解耦 —— 主界面渲染失败也不该连「我是谁、怎么退出」都看不到。
 *
 * 排版对齐「帮助 / 设置」那两枚 .nav：行高 48px、左内边距 14px、22px 图标位、
 * 12.5px 字、悬停 #131c26 + 右移 2px。账号条不再自带浅色底和大投影，
 * 否则它会像另一个控件跑进工具组里。
 */

const style = `
.av-account{display:flex;align-items:center;height:48px;min-height:48px;flex-shrink:0;margin:1px 0;
  border-radius:7px;color:#94a0b0;transition:background .18s ease,color .18s ease,transform .18s cubic-bezier(.22,.61,.36,1)}
.av-account:hover{background:var(--av-panel-hover,#131c26);transform:translateX(2px)}
.av-account-main{display:flex;align-items:center;gap:10px;flex:1;min-width:0;height:100%;
  padding:12px 0 12px 14px;background:none;border:0;border-radius:7px;
  /* 15px 是 .sidebar .nav 的实际字号（帮助 / 设置就是它），账号名必须一样大才对得齐 */
  font-size:15px;font-weight:500;color:inherit;justify-content:flex-start;text-align:left}
.av-account-main:hover:not(:disabled){color:#fff}
.av-account-avatar{flex:0 0 22px;width:22px;height:22px;display:grid;place-items:center;border-radius:6px;
  background:#c9f581;color:#1d2c13;font-size:11px;font-weight:700;line-height:1}
.av-account-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.av-account-out{flex:0 0 auto;display:grid;place-items:center;width:26px;height:26px;margin-right:8px;padding:5px;
  border:0;border-radius:6px;background:none;color:#6c7c8f}
.av-account-out:hover:not(:disabled){color:#f0a58f;background:#f0a58f14}
.av-account-out svg{width:100%;height:100%;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}

html.side-collapsed .av-account{transform:none}
html.side-collapsed .av-account-main{padding:12px 13px}
html.side-collapsed .av-account-name,html.side-collapsed .av-account-out{display:none}
@media(max-width:780px){
  .av-account-name,.av-account-out{display:none}
  .av-account-main{padding:12px 13px}
}

/* 改密码弹窗：外壳用全局 dialog（#141c26 / 1px #374557 / 14px），里面只补字段间距 */
#av-password-dialog .dialog-header{font-size:13px;font-weight:600}
#av-password-dialog .dialog-body{padding:16px 20px 20px}
#av-password-dialog .av-me{display:flex;align-items:center;gap:10px;padding:11px 12px;margin:0 0 14px;
  border:1px solid var(--av-line,#2b3c46);border-radius:9px;background:var(--av-panel,#10161f)}
#av-password-dialog .av-me .av-account-avatar{width:26px;height:26px;flex:0 0 26px;font-size:12px}
#av-password-dialog .av-me strong{display:block;font-size:12.5px;font-weight:600;color:#dfe7ef}
#av-password-dialog .av-me small{display:block;margin-top:3px;font-size:10.5px;color:#7f91a4}
#av-password-dialog .field{margin:0;padding:9px 0;border-bottom:1px solid #222c38;font-size:11.5px;color:#a9b8c9}
#av-password-dialog .field:last-of-type{border-bottom:0}
#av-password-dialog .field input{width:100%;padding:10px 11px;font-size:12.5px;border-radius:7px;background:var(--av-field,#10161f);border-color:var(--av-line,#27303d)}
#av-password-dialog .field input::placeholder{color:#5b6878}
#av-password-dialog .field input:focus{outline:none;border-color:#8fae63;box-shadow:0 0 0 2px #c9f58114}
#av-password-dialog .av-hint{margin:10px 0 0;font-size:11px;line-height:1.7;color:#7f91a4}
#av-password-dialog .av-msg{margin:8px 0 0;font-size:11.5px;line-height:1.6;color:#ff9d94}
#av-password-dialog .av-msg:empty{display:none}
#av-password-dialog .av-msg.good{color:#c9f581}
#av-password-dialog .av-actions{display:flex;gap:9px;justify-content:flex-end;margin-top:14px}
`;

const LOGOUT_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14.5 8V5.6A1.6 1.6 0 0 0 12.9 4H5.6A1.6 1.6 0 0 0 4 5.6v12.8A1.6 1.6 0 0 0 5.6 20h7.3a1.6 1.6 0 0 0 1.6-1.6V16"/><path d="M10.5 12h9"/><path d="m16.6 8.9 3.1 3.1-3.1 3.1"/></svg>';
const CLOSE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>';

function addStyle() {
  if (document.getElementById('av-account-style')) return;
  const tag = document.createElement('style');
  tag.id = 'av-account-style';
  tag.textContent = style;
  document.head.append(tag);
}

/** 改密码弹窗：账号行点开它。密码规则与登录页一致（6–64 位，不限字符）。 */
function buildDialog(name) {
  const dialog = document.createElement('dialog');
  dialog.id = 'av-password-dialog';
  dialog.className = 'settings-dialog';
  dialog.innerHTML = `
    <div class="dialog-header"><span>账号 · 修改密码</span>
      <button class="icon-button" type="button" data-av-close aria-label="关闭">${CLOSE_ICON}</button></div>
    <form class="dialog-body" id="av-password-form" novalidate>
      <div class="av-me">
        <span class="av-account-avatar">${name.slice(0, 1).toUpperCase()}</span>
        <span><strong>${name}</strong><small>本机账号 · 密码只存在这台电脑</small></span>
      </div>
      <label class="field"><span>当前密码</span>
        <input id="av-pw-current" type="password" placeholder="登录时用的那个" autocomplete="current-password" autocapitalize="none" spellcheck="false"></label>
      <label class="field"><span>新密码</span>
        <input id="av-pw-next" type="password" placeholder="至少 6 位" autocomplete="new-password" autocapitalize="none" spellcheck="false"></label>
      <label class="field"><span>再输一次</span>
        <input id="av-pw-again" type="password" placeholder="再输一遍新密码" autocomplete="new-password" autocapitalize="none" spellcheck="false"></label>
      <p class="av-hint">6–64 位，字母、数字、符号都可以，区分大小写。改完后这台设备保持登录。</p>
      <p class="av-msg" id="av-pw-msg" role="status" aria-live="polite"></p>
      <div class="av-actions">
        <button class="secondary" type="button" data-av-close>取消</button>
        <button class="primary" type="submit" id="av-pw-save">保存新密码</button>
      </div>
    </form>`;

  const form = dialog.querySelector('#av-password-form');
  const current = dialog.querySelector('#av-pw-current');
  const next = dialog.querySelector('#av-pw-next');
  const again = dialog.querySelector('#av-pw-again');
  const msg = dialog.querySelector('#av-pw-msg');
  const save = dialog.querySelector('#av-pw-save');

  const say = (text, good = false) => {
    msg.textContent = text;
    msg.classList.toggle('good', good);
  };

  for (const button of dialog.querySelectorAll('[data-av-close]')) {
    button.addEventListener('click', () => dialog.close());
  }
  dialog.addEventListener('click', event => {
    if (event.target === dialog) dialog.close(); // 点遮罩收起
  });
  for (const input of [current, next, again]) {
    input.addEventListener('input', () => { if (msg.textContent) say(''); });
  }

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (save.disabled) return;
    if (!current.value) return say('先填当前密码');
    if (next.value.length < 6) return say('新密码至少 6 位');
    if (next.value.length > 64) return say('新密码最多 64 位');
    if (next.value !== again.value) return say('两次输入的新密码不一样');

    save.disabled = true;
    say('');
    try {
      const response = await fetch('/api/auth/password', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({current: current.value, next: next.value})
      });
      const data = await response.json().catch(() => ({}));
      if (response.status === 401 && /请先登录/.test(data.error || '')) {
        location.replace('/login.html');
        return;
      }
      if (!response.ok) throw Error(data.error || '没能保存，请再试一次');
      current.value = next.value = again.value = '';
      say('密码已更新', true);
      setTimeout(() => dialog.close(), 700);
    } catch (error) {
      say(error.message || '没能保存，请再试一次');
      next.select();
    } finally {
      save.disabled = false;
    }
  });

  dialog.addEventListener('close', () => {
    current.value = next.value = again.value = '';
    say('');
  });

  document.body.append(dialog);
  return {dialog, current};
}

async function boot() {
  if (document.getElementById('av-account')) return;
  const sidebar = document.getElementById('sidebar');
  if (!sidebar) return;

  let data = null;
  try {
    const response = await fetch('/api/auth/me');
    if (!response.ok) return;
    data = await response.json();
  } catch {
    return;
  }
  if (!data?.user?.name) return;
  const name = data.user.name;

  addStyle();
  const {dialog, current} = buildDialog(name);

  const chip = document.createElement('div');
  chip.className = 'av-account';
  chip.id = 'av-account';

  const main = document.createElement('button');
  main.type = 'button';
  main.className = 'av-account-main';
  main.title = `当前账号：${name} · 点开修改密码`;
  main.setAttribute('aria-label', `账号 ${name}，修改密码`);

  const avatar = document.createElement('span');
  avatar.className = 'av-account-avatar';
  avatar.textContent = name.slice(0, 1).toUpperCase();

  const label = document.createElement('span');
  label.className = 'av-account-name';
  label.textContent = name;

  main.append(avatar, label);
  main.addEventListener('click', () => {
    dialog.showModal();
    current.focus();
  });

  const out = document.createElement('button');
  out.type = 'button';
  out.className = 'av-account-out';
  out.title = '退出登录';
  out.setAttribute('aria-label', '退出登录');
  out.innerHTML = LOGOUT_ICON;
  out.addEventListener('click', async () => {
    out.disabled = true;
    try {
      await fetch('/api/auth/logout', {method: 'POST'});
    } catch {/* 断网也照跳，反正 cookie 清不掉时后台会再拦一次 */}
    location.replace('/login.html');
  });

  chip.append(main, out);
  const footer = sidebar.querySelector('.side-footer');
  if (footer) sidebar.insertBefore(chip, footer);
  else sidebar.append(chip);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, {once: true});
else boot();
