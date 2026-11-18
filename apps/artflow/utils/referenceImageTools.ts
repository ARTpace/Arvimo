import type { ImageElement } from '../types';

/** New pixels get a new asset identity; the original remains available to undo. */
export async function transformReferenceImage(element: ImageElement, operation: 'flip-h' | 'flip-v' | 'grayscale'): Promise<Partial<ImageElement>> {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error('Image could not be loaded'));
        image.src = element.href;
    });
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas is unavailable');
    if (operation === 'flip-h') { context.translate(canvas.width, 0); context.scale(-1, 1); }
    if (operation === 'flip-v') { context.translate(0, canvas.height); context.scale(1, -1); }
    if (operation === 'grayscale') context.filter = 'grayscale(1)';
    context.drawImage(image, 0, 0);
    const href = canvas.toDataURL('image/png');
    return {href, originalHref:href, thumbnailHref:undefined, mediumHref:undefined,
        assetId:undefined, assetRef:undefined, fileSize:undefined, mimeType:'image/png',
        originalPixelWidth:canvas.width, originalPixelHeight:canvas.height};
}
