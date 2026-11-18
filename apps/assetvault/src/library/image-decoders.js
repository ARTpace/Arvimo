// 特殊格式只在实际预览时加载，避免TGA依赖的three.js进入启动主包。
export {TGALoader} from 'three/examples/jsm/loaders/TGALoader.js';
export {decodeTiff} from './tiff-decode.js';
export {decodePsd} from './psd-decode.js';
