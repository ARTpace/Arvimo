// 密码框的「显示 / 隐藏」按钮 —— 本机登录页和局域网入口页共用这一份。
// 约定：按钮写 data-peek="<input 的 id>"，图标文字由脚本切换，样式在 login.css 的 .peek。
// 单独成文件是为了两边不各写一遍：改这里，两个入口一起变。
for (const button of document.querySelectorAll('[data-peek]')) {
  button.addEventListener('click', () => {
    const input = document.getElementById(button.dataset.peek);
    if (!input) return;
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    button.textContent = show ? '隐藏' : '显示';
    button.setAttribute('aria-pressed', String(show));
    // 切完把焦点和光标还给输入框，否则连着打字会中断。
    input.focus();
    try { input.setSelectionRange(input.value.length, input.value.length); } catch { /* 部分类型不支持 */ }
  });
}
