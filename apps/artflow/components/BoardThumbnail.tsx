import React, {useMemo} from 'react';
import type {Board} from '../types';
import {getElementBounds} from '../utils/canvasUtils';

/** Inline SVG can load library URLs; an SVG used as an img cannot load external images. */
export const BoardThumbnail = React.memo(({board, label}: {board: Board; label: string}) => {
    const images = useMemo(() => board.elements.filter(element => element.type === 'image').slice(0, 4), [board.elements]);
    const viewBox = useMemo(() => {
        const bounds = board.elements.map(element => getElementBounds(element, board.elements));
        const left = Math.min(...bounds.map(b => b.x));
        const top = Math.min(...bounds.map(b => b.y));
        const width = Math.max(...bounds.map(b => b.x + b.width)) - left;
        const height = Math.max(...bounds.map(b => b.y + b.height)) - top;
        if (!Number.isFinite(width + height) || width <= 0 || height <= 0) return '0 0 120 80';
        const padding = Math.max(width, height) / 20;
        return `${left - padding} ${top - padding} ${width + padding * 2} ${height + padding * 2}`;
    }, [board.elements]);
    return <svg xmlns="http://www.w3.org/2000/svg" role="img" aria-label={label}
        viewBox={images.length ? '0 0 120 80' : viewBox} className="w-full h-full" style={{backgroundColor: board.canvasBackgroundColor}}>
        {images.length ? images.map((element, index) => {
            const columns = images.length === 1 ? 1 : 2;
            const rows = images.length <= 2 ? 1 : 2;
            const width = 120 / columns, height = 80 / rows;
            return <svg key={element.id} x={(index % columns) * width + 1} y={Math.floor(index / columns) * height + 1}
                width={width - 2} height={height - 2} viewBox="0 0 120 80" preserveAspectRatio="none" overflow="hidden">
                <image href={element.mediumHref || element.href || element.thumbnailHref}
                    width="120" height="80" opacity={element.opacity ?? 1} preserveAspectRatio="xMidYMid slice"/>
            </svg>;
        }) : board.elements.map(element => {
            if (element.type === 'image') return <image key={element.id}
                href={element.thumbnailHref || element.mediumHref || element.href}
                x={element.x} y={element.y} width={element.width} height={element.height}
                opacity={element.opacity ?? 1} preserveAspectRatio="xMidYMid meet"
                transform={element.rotation ? `rotate(${element.rotation} ${element.x + element.width / 2} ${element.y + element.height / 2})` : undefined}/>;
            if (element.type === 'path') return <path key={element.id}
                d={element.points.map((point, index) => `${index ? 'L' : 'M'} ${point.x} ${point.y}`).join(' ')}
                stroke={element.strokeColor} strokeWidth={element.strokeWidth} opacity={element.opacity ?? 1}
                fill="none" strokeLinecap="round" strokeLinejoin="round"/>;
            return null;
        })}
    </svg>;
});
