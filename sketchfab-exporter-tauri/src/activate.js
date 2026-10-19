/* AssetVault 激活面板。
   主路径是「纯离线签发」：用户把机器指纹发给发行方，拿到授权文件后粘贴进来激活。
   全程不联网；Rust 侧只做验签 + 比对硬件因子（activate_with 命令）。
   在线激活保留为备用入口（将来部署授权服务时用得上）。 */
(function () {
  const api = window.__TAURI__;
  const $ = (id) => document.getElementById(id);
  const state = {server: '', machineCode: '', fingerprint: '', factors: []};

  function setStatus(text, kind) {
    const el = $('act-status');
    el.textContent = text || '';
    el.className = 'act-status' + (kind ? ' ' + kind : '');
  }

  function showPanel() {
    $('boot').hidden = true;
    $('activation').hidden = false;
  }

  function showBoot(msg) {
    $('activation').hidden = true;
    $('boot').hidden = false;
    if (msg) $('boot-msg').textContent = msg;
  }

  function copyText(text, okMsg) {
    const done = (ok) => setStatus(ok ? okMsg : '复制失败，请手动选中复制', ok ? 'ok' : 'err');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => done(true), () => fallbackCopy(text, done));
      return;
    }
    fallbackCopy(text, done);
  }

  function fallbackCopy(text, done) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    done(ok);
  }

  /** 把授权文件交给 Rust：验签 + 比对机器，通过才落盘并拉起本地服务。 */
  async function submitLicense(license, btn) {
    btn.disabled = true;
    setStatus('正在本机校验授权…');
    try {
      await api.core.invoke('activate_with', {license});
    } catch (err) {
      const msg = typeof err === 'string' ? err : (err && err.message) || String(err);
      setStatus('校验未通过：' + msg, 'err');
      btn.disabled = false;
      return false;
    }
    setStatus('激活成功，正在启动本地服务…', 'ok');
    $('act-form').hidden = true;
    $('act-online').hidden = true;
    showBoot('激活成功，正在启动本地模型库服务…');
    return true;
  }

  /** 主路径：粘贴授权文件（离线）。 */
  async function activateOffline() {
    const raw = $('act-license').value.trim();
    if (!raw) { setStatus('请先粘贴发行方回传的授权文件', 'err'); return; }
    if (!raw.startsWith('AVLIC1.')) { setStatus('授权文件格式不对：应以 AVLIC1. 开头，请确认复制完整', 'err'); return; }
    await submitLicense(raw, $('act-submit'));
  }

  /** 备用路径：输入密钥 → 联网向授权服务换取授权文件。 */
  async function activateOnline() {
    const btn = $('act-submit-online');
    const key = normalizeKey($('act-key').value);
    $('act-key').value = key;
    if (key.replace(/-/g, '').length < 22) {
      setStatus('密钥格式不对，应为 AV-XXXXX-XXXXX-XXXXX-XXXXX', 'err');
      return;
    }
    btn.disabled = true;
    setStatus('正在连接授权服务…');

    let data;
    try {
      const res = await fetch(state.server, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({key, machineId: state.machineCode, factors: state.factors}),
      });
      try { data = await res.json(); } catch (e) { data = {}; }
      if (!res.ok || !data.license) {
        setStatus(data.message || data.error || '激活失败（HTTP ' + res.status + '）', 'err');
        btn.disabled = false;
        return;
      }
    } catch (err) {
      setStatus('连不上授权服务，请检查网络后重试（' + state.server + '）', 'err');
      btn.disabled = false;
      return;
    }
    setStatus('授权已签发，正在本机校验…');
    await submitLicense(data.license, btn);
  }

  /** 用户手输 / 粘贴的密钥统一规整成 AV-XXXXX-XXXXX-XXXXX-XXXXX */
  function normalizeKey(raw) {
    let s = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (s.startsWith('AV')) s = s.slice(2);
    return 'AV-' + (s.match(/.{1,5}/g) || []).join('-');
  }

  async function init() {
    if (!api || !api.core) {
      showPanel();
      setStatus('当前环境不支持激活（请通过安装包启动）', 'err');
      $('act-submit').disabled = true;
      return;
    }
    let status;
    try {
      status = await api.core.invoke('license_info');
    } catch (err) {
      showPanel();
      setStatus('无法读取授权状态：' + String(err), 'err');
      return;
    }
    state.server = status.server || '';
    state.machineCode = status.machineCode || '';
    state.fingerprint = status.fingerprint || '';
    state.factors = status.factors || [];
    // 免激活发布（闸门关着）时不再摆激活面板：Rust 那边已经把本地服务拉起来了，
    // 就绪后会自己跳到启动画面，这里只负责显示「正在启动」。
    if (status.gate === false || status.licensed) {
      showBoot('正在启动本地模型库服务…');
      return;
    }
    $('act-machine').textContent = state.fingerprint || state.machineCode || '（读取失败）';
    showPanel();
    setStatus(status.reason && status.reason !== '尚未激活' ? status.reason : '');
    $('act-license').focus();
  }

  document.addEventListener('DOMContentLoaded', () => {
    $('act-copy').addEventListener('click', () => {
      const text = state.fingerprint || state.machineCode;
      if (text) copyText(text, '机器指纹已复制，发给发行方即可');
    });
    $('act-submit').addEventListener('click', activateOffline);
    $('act-submit-online').addEventListener('click', activateOnline);
    $('act-license').addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.ctrlKey) activateOffline(); });
    $('act-mode-online').addEventListener('click', () => {
      const form = $('act-online');
      form.hidden = !form.hidden;
      if (!form.hidden) $('act-key').focus();
    });
    $('act-key').addEventListener('keydown', (e) => { if (e.key === 'Enter') activateOnline(); });
    $('act-key').addEventListener('input', (e) => {
      const el = e.target;
      const atEnd = el.selectionStart === el.value.length;
      const next = normalizeKey(el.value);
      if (next !== el.value) el.value = next;
      if (atEnd) el.setSelectionRange(el.value.length, el.value.length);
    });
    init();
  });
})();
