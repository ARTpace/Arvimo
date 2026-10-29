/** 界面统一使用中文错误；原始任务日志保留，便于定位底层问题。 */
export function chineseError(value,{fallback=false}={}){
 const message=String(value?.message??value??'').trim();
 if(!message)return fallback?'操作失败，请稍后重试。':'';
 const system=message.match(/\b(ENOENT|EACCES|EPERM|ENOSPC|EBUSY|EEXIST|ENOTDIR|EISDIR|EROFS|EMFILE):[^\r\n]*/);
 if(system){
  const reasons={ENOENT:'找不到文件或目录，文件可能已移动、删除或路径失效',EACCES:'没有访问权限，请检查文件夹权限',EPERM:'操作被系统拒绝，请检查权限或文件是否被占用',ENOSPC:'磁盘空间不足，请清理空间后重试',EBUSY:'文件或目录正在被占用，请关闭相关程序后重试',EEXIST:'目标文件或目录已存在',ENOTDIR:'路径中的某一项不是文件夹',EISDIR:'需要文件，但指定路径是文件夹',EROFS:'目标位置只读，请选择可写入的文件夹',EMFILE:'同时打开的文件过多，请稍后重试'};
  const operation=system[0].match(/\b(mkdir|open|stat|scandir|unlink|rename|copyfile|read|write)\b/)?.[1];
  const labels={mkdir:'创建文件夹失败',open:'打开文件失败',stat:'读取文件信息失败',scandir:'读取文件夹失败',unlink:'删除文件失败',rename:'移动或重命名失败',copyfile:'复制文件失败',read:'读取文件失败',write:'写入文件失败'};
  const paths=[...system[0].matchAll(/'([^']+)'/g)].map(match=>match[1]);
  return message.slice(0,system.index)+(operation?labels[operation]+'：':'')+reasons[system[1]]+(paths.length?'。路径：'+paths.join(' → '):'');
 }
 const rules=[
  [/\b(?:ECONNREFUSED|connection refused)\b/i,'无法连接服务，请确认服务已启动'],
  [/\b(?:ECONNRESET|socket hang up|connection reset)\b/i,'连接中断，请检查网络后重试'],
  [/\b(?:ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|ESOCKETTIMEDOUT)\b|timed? ?out/i,'连接超时，请稍后重试'],
  [/\b(?:ENOTFOUND|EAI_AGAIN)\b|getaddrinfo/i,'无法解析服务器地址，请检查网络或代理设置'],
  [/failed to fetch|fetch failed|networkerror|network request failed|load failed/i,'网络请求失败，请检查网络、代理及后台服务'],
  [/certificate|CERT_HAS_EXPIRED|UNABLE_TO_VERIFY_LEAF_SIGNATURE/i,'安全证书验证失败，请检查系统时间、代理或服务器证书'],
  [/unexpected (?:token|end).*json|json.*unexpected|is not valid json/i,'服务器返回的数据格式异常，请稍后重试'],
  [/\bAbortError\b|the operation was aborted|the user aborted a request/i,'操作已取消或请求已超时'],
  [/\bHTTP\s*401\b/i,'登录已失效，请重新登录'],
  [/\bHTTP\s*403\b/i,'网站拒绝访问，请检查登录状态或稍后重试'],
  [/\bHTTP\s*404\b/i,'找不到请求的资源，内容可能已删除'],
  [/\bHTTP\s*429\b/i,'请求过于频繁，请稍后重试'],
  [/\bHTTP\s*5\d\d\b/i,'远端服务暂时异常，请稍后重试']
 ];
 for(const [pattern,translation] of rules)if(pattern.test(message))return translation;
 return fallback&&!/[\u3400-\u9fff]/.test(message)?'操作失败，请稍后重试；详细原因请查看任务日志。':message;
}
