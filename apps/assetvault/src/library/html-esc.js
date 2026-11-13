// 唯一的一份 HTML 转义：界面里所有拼进标签的字符串（标题、标签、平台名、选项文本）都走它。
export const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
