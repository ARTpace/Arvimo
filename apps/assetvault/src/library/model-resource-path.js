/** glTF 本地 URI 相对模型目录解析，保留子目录，禁止越过已登记根或访问网络。 */
export function modelResourceRel(modelRel,uri){
 if(typeof uri!=='string'||!uri||uri.length>4096)throw Error('模型依赖 URI 无效');
 let value;try{value=decodeURIComponent(uri.split(/[?#]/)[0]);}catch{throw Error('模型依赖 URI 编码无效');}
 value=value.replace(/\\/g,'/');
 if(!value||value.startsWith('/')||/^[a-z][a-z0-9+.-]*:/i.test(value)||/[\x00-\x1f:<>"|?*]/.test(value))throw Error('模型依赖仅支持根目录内的相对路径');
 const parts=String(modelRel).replace(/\\/g,'/').split('/');parts.pop();
 for(const part of value.split('/')){
  if(!part||part==='.')continue;
  if(part==='..'){if(!parts.length)throw Error('模型依赖路径越过登记根');parts.pop();}
  else parts.push(part);
 }
 if(!parts.length)throw Error('模型依赖路径无效');return parts.join('/');
}
