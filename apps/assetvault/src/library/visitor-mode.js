export const isLanVisitor=(hostname=globalThis.location?.hostname||'localhost')=>!['localhost','127.0.0.1','[::1]'].includes(hostname);
