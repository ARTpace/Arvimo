// 右键菜单「打开所在文件夹」：把 {root, rel} 交给本机服务，由系统文件管理器定位。
//
// 两条硬约束（都是踩过坑的）：
//  1. 必须带 X-SFX-Local: 1 —— 这条路由只对本机窗口放开，别让网页里的一条链接就能去拨动文件管理器；
//  2. 失败要把服务端那句人话原样抛出去（「打不开这个位置：文件不存在或已被移动」），
//     不要吞成一句「操作失败」——用户下一步要知道的是「文件还在不在」。
//
// 传文件时打开的是它所在的文件夹并选中它；传目录时直接打开那个目录（素材包就是这种）。
export async function revealLocalPath(root, rel = '', {fetchImpl = globalThis.fetch, log = globalThis.console} = {}) {
  if (!root) throw Error('这个资产没有本地路径，打不开文件夹');
  if (!fetchImpl) throw Error('当前环境无法打开文件夹');
  const response = await fetchImpl('/api/local/reveal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-SFX-Local': '1' },
    body: JSON.stringify({ root, rel: String(rel ?? '') }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    // 这条功能失败时最容易被当成「点了没反应」：界面只有一个 toast，控制台什么都没有。
    // 所以把状态码、目标路径和服务端原话一起留在控制台 —— 用户截个 console 就能定位是
    // 路由没换（404）、根目录没索引（403）、还是文件真没了（404 + 打不开这个位置）。
    log?.warn?.(`[reveal] ${response.status} root=${root} rel=${rel} → ${data.error || '(无 error 字段)'}`);
    throw Error(data.error || `HTTP ${response.status}`);
  }
  log?.info?.(`[reveal] ok root=${root} rel=${rel}`);
  return data;
}
