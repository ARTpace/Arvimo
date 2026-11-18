export const FILE_WRITE_PROTOCOL='1';
const FLAG='file-write-protocol-required';

/** 在认领/开启整理的同一事务内持久启用；撤销移动或关闭权限不撤销协议要求。 */
export function requireFileWriteProtocol(conn){
 conn.run(`INSERT INTO state_meta (key,value,updated_at) VALUES (?,?,?)
  ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`,[FLAG,FILE_WRITE_PROTOCOL,Date.now()]);
}

/** 只守旧快照写入；定点操作仍使用其已有的版本及稳定位置兼容规则。 */
export function assertFileWriteProtocol(conn,clientProtocol){
 if(!conn)throw Object.assign(Error('数据库不可用，无法核验文件整理协议，暂不接受快照保存'),{status:503,code:'write_protocol_unavailable'});
 const required=conn.all('SELECT value FROM state_meta WHERE key=?',[FLAG])[0]?.value;
 // 兼容此保护上线前已经整理/迁移的库，不能仅靠新写入的标记判断。
 const adopted=required||conn.all('SELECT 1 FROM file_roots WHERE writable=1 LIMIT 1').length
  ||conn.all("SELECT 1 FROM file_operations WHERE state<>'cancelled' LIMIT 1").length
  ||conn.all("SELECT 1 FROM audit_log WHERE actor='location-migration' LIMIT 1").length;
 if(adopted&&clientProtocol!==FILE_WRITE_PROTOCOL)throw Object.assign(Error('当前资产库已启用稳定文件定位，请刷新或升级页面后再保存；本次写入未执行'),{
  status:426,code:'client_upgrade_required',requiredProtocol:FILE_WRITE_PROTOCOL
 });
}
