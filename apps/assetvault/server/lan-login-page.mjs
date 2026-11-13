/**
 * 局域网入口页（外面的人打开分享链接看到的那一屏）。
 *
 * 这一页不自己定义样式：卡片、字段、按钮、背景全部复用本机登录页那一套
 * （src/library/login.css + login-backdrop.svg），连密码框的「显示 / 隐藏」按钮
 * 也走同一个 /login-peek.js。这边的模板只决定「有哪些字段、写什么文案」，
 * 所以调风格只需要改 login.css，两个入口一起变。
 */
const attr = value => String(value)
  .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
  .replace(/</g, '&lt;').replace(/>/g, '&gt;');

export const lanLoginPage = (error = '', username = '') => `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<title>局域网访问 · Arvimo</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/login.css">
</head>
<body>
<div class="backdrop" aria-hidden="true"><img class="backdrop-art" src="/login-backdrop.svg" alt=""></div>
<main class="stage">
  <section class="card">
    <header class="card-head">
      <img class="brand-mark" src="/favicon.svg" alt="">
      <span class="brand-copy"><strong>Arvimo</strong><small>局域网访问</small></span>
    </header>
    <div class="card-body">
      <p class="lede">填写你的名字和主机设置的共享密码，即可访问同一资产库。</p>
      <form method="post" action="/api/lan/login" novalidate>
        <div class="field">
          <div class="field-label"><label for="username">你的名字</label><small>1–24 个字</small></div>
          <input id="username" name="username" type="text" maxlength="24" autocomplete="nickname" autocapitalize="none" spellcheck="false" placeholder="主机设备列表里会显示这个名字" required autofocus value="${attr(username)}">
        </div>
        <div class="field">
          <div class="field-label"><label for="password">访问密码</label><small>由主机设置</small></div>
          <div class="pass-wrap">
            <input id="password" name="password" type="password" maxlength="128" autocomplete="current-password" autocapitalize="none" spellcheck="false" placeholder="输入共享密码" required>
            <button class="peek" type="button" data-peek="password" aria-pressed="false">显示</button>
          </div>
        </div>
        <p class="status" role="status" aria-live="polite">${error ? attr(error) : ''}</p>
        <button class="primary" type="submit">进入资产库</button>
      </form>
      <p class="footnote">密码只用于这次访问校验，不会保存在这台设备上。</p>
    </div>
  </section>
  <p class="stage-note">局域网共享 · 内容由主机提供</p>
</main>
<script src="/login-peek.js" defer></script>
</body>
</html>`;
