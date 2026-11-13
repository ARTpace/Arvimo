/* 登录页的交互：登录 / 创建账号、密码长度提示、错误提示与回跳。
 *
 * 只做体验层的事：真正的规则（账号名格式、密码长度、口令校验、会话签发）都在 server/auth.mjs，
 * 这里前端挡一遍只是为了少一次往返，改前端绕过也进不来。
 */

const $ = id => document.getElementById(id);
const card = $('clay-card');
const form = $('auth-form');
const nameInput = $('account-name');
const passInput = $('account-password');
const statusEl = $('auth-status');
const submit = $('submit');
const submitLabel = $('submit-label');
const tabs = $('tabs');
const passHint = $('pass-hint');
const peek = $('peek');
const footnote = $('footnote');

/** 只接受站内路径：/xxx 可以，//evil.com 与 http://… 一律退回首页。 */
const next = (() => {
  const raw = new URLSearchParams(location.search).get('next') || '';
  return /^\/(?!\/)/.test(raw) ? raw : '/';
})();

const COPY = {
  login: '账号和密码只留在本机的 AssetVault 数据目录，不上传、不同步。',
  register: '账号只用于进入本机工作台：多个账号共用同一份资产库。'
};

let mode = 'login';
let busy = false;

const PASSWORD_MIN = 6;
const PASSWORD_MAX = 64;

/** 密码框右侧的计数：空着显示门槛，输入后显示实际位数，够了就转绿。
 *  密码不再限定 8 位数字，所以这里只是提示长度，不拦字符种类。 */
function paintCount() {
  const length = passInput.value.length;
  passHint.textContent = length ? `${length} 位` : `至少 ${PASSWORD_MIN} 位`;
  passHint.classList.toggle('done', length >= PASSWORD_MIN);
}

function say(message, tone = 'error') {
  statusEl.textContent = message;
  statusEl.className = `status${tone === 'error' ? '' : ` ${tone}`}`;
}

function fail(message, target) {
  say(message);
  card.classList.remove('shake');
  void card.offsetWidth;
  card.classList.add('shake');
  target?.focus();
}

function setBusy(value) {
  busy = value;
  submit.disabled = value;
  nameInput.readOnly = value;
  passInput.readOnly = value;
}

function setMode(nextMode) {
  mode = nextMode;
  tabs.dataset.mode = mode;
  for (const tab of tabs.querySelectorAll('.tab')) {
    const on = tab.dataset.mode === mode;
    tab.classList.toggle('active', on);
    tab.setAttribute('aria-selected', String(on));
    tab.tabIndex = on ? 0 : -1;
  }
  submitLabel.textContent = mode === 'login' ? '进入工作台' : '创建并进入';
  passInput.autocomplete = mode === 'login' ? 'current-password' : 'new-password';
  // 登录时别再说「至少 6 位」——老密码可能是旧的 8 位数字，这里只提示「输入密码」。
  passInput.placeholder = mode === 'login' ? '输入密码' : '至少 6 位，字母数字符号都行';
  footnote.textContent = COPY[mode];
  say('');
}

tabs.addEventListener('click', event => {
  const tab = event.target.closest('.tab');
  if (!tab || busy || tab.dataset.mode === mode) return;
  setMode(tab.dataset.mode);
  nameInput.focus();
});

tabs.addEventListener('keydown', event => {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
  event.preventDefault();
  const nextMode = mode === 'login' ? 'register' : 'login';
  setMode(nextMode);
  tabs.querySelector(`.tab[data-mode="${nextMode}"]`).focus();
});

passInput.addEventListener('input', () => {
  // 不再过滤字符：大小写字母、数字、符号都留着，只在超长时截断（和 maxlength 双保险）。
  if (passInput.value.length > PASSWORD_MAX) passInput.value = passInput.value.slice(0, PASSWORD_MAX);
  paintCount();
  if (statusEl.textContent) say('');
});

nameInput.addEventListener('input', () => {
  if (statusEl.textContent) say('');
});

peek.addEventListener('click', () => {
  const show = passInput.type === 'password';
  passInput.type = show ? 'text' : 'password';
  peek.textContent = show ? '隐藏' : '显示';
  peek.setAttribute('aria-pressed', String(show));
  passInput.focus();
  passInput.setSelectionRange(passInput.value.length, passInput.value.length);
});

form.addEventListener('submit', async event => {
  event.preventDefault();
  if (busy) return;
  const name = nameInput.value.trim();
  const password = passInput.value;

  if (!name) return fail('先填账号名，这是登录要用到的名字', nameInput);
  if (mode === 'register' && name.length < 2) return fail('账号名至少 2 个字', nameInput);
  if (password.length < PASSWORD_MIN) return fail(`密码至少 ${PASSWORD_MIN} 位`, passInput);
  if (password.length > PASSWORD_MAX) return fail(`密码最多 ${PASSWORD_MAX} 位`, passInput);

  setBusy(true);
  say(mode === 'login' ? '正在核对…' : '正在创建…', 'quiet');
  try {
    const response = await fetch(`/api/auth/${mode === 'login' ? 'login' : 'register'}`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({name, password})
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw Error(data.error || '没能完成，请再试一次');
    say(mode === 'login' ? '欢迎回来，正在进入工作台…' : '账号建好了，正在进入工作台…', 'good');
    setTimeout(() => location.replace(next), 420);
  } catch (error) {
    setBusy(false);
    passInput.select();
    fail(error.message || '没能完成，请再试一次');
  }
});

(async () => {
  paintCount();
  // ?mode=register 可以直接落到创建账号（分享一个「来建个账号」的链接时用得上）
  setMode(new URLSearchParams(location.search).get('mode') === 'register' ? 'register' : 'login');
  let data = null;
  try {
    const response = await fetch('/api/auth/me');
    if (response.status === 404) {
      // 这个服务没开登录（比如内部脚本直接起的调试实例），别把人关在一张进不去的登录页上。
      location.replace(next);
      return;
    }
    data = await response.json();
  } catch {
    say('连不上本地服务，请确认 AssetVault 后台还在运行', 'error');
    return;
  }
  if (data?.user) {
    location.replace(next);
    return;
  }
  if (data?.hasUsers === false) {
    setMode('register');
    say('这台电脑还没有账号，先建一个再进工作台。', 'quiet');
  }
  nameInput.focus();
})();
