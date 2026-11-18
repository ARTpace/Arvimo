export const ELEMENT_COLORS = [
  { id: 'cyan', name: '青绿色', hex: '#09bfd0' },
  { id: 'blue', name: '蓝色', hex: '#6b78ff' },
  { id: 'purple', name: '紫色', hex: '#ba60f5' },
  { id: 'orange', name: '橙色', hex: '#ff922e' },
  { id: 'yellow', name: '黄色', hex: '#ffd600' },
] as const;

export const isElementColor = (color: string) => ELEMENT_COLORS.some(item => item.id === color) || /^#[0-9a-f]{6}$/i.test(color);

export const resolveElementColor = (color?: string) => ELEMENT_COLORS.find(item => item.id === color)
  ?? (color && /^#[0-9a-f]{6}$/i.test(color) ? { id: color, name: `自定义 ${color}`, hex: color } : undefined);
