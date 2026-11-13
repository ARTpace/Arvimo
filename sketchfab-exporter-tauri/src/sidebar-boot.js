/* 首帧脚本：在 <head> 里同步执行，早于第一次绘制，先把「侧边栏折叠态」挂到 <html> 上。
 *
 * 为什么不是内联 <script>：页面 CSP 是 `script-src 'self'`，内联脚本会被直接拒绝执行
 * （只在控制台留一条 Refused to execute inline script），结果就是 -- 每次刷新都要等
 * app.js 加载完才收起侧栏，用户看到「先展开、再收起」闪一下。同源文件不受此限。
 *
 * 为什么不用 defer：defer 要等文档解析完才执行，那时侧栏已经画出来了，闪躲不掉。
 * 这一行必须阻塞解析，代价是几百字节的同源请求（与 app.css 并行，且被浏览器缓存）。
 *
 * KEY 与 sidebar-collapse.js 共用；那边负责交互与最终状态，这里只负责「首帧别画错」。
 */
try {
  if (localStorage.getItem('av:sidebar:collapsed') === '1') {
    document.documentElement.classList.add('side-collapsed');
  }
} catch (e) {
  // 隐私模式 / 存储被禁用时读不到，按展开态画即可，交互时 sidebar-collapse.js 会再判一次。
}
