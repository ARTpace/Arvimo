import type { PathElement, Point } from '../types';

/** Distance-based stabilizer: suppress sub-pixel tremor without depending on event rate. */
export function stabilizeDrawingPoint(last: Point, input: Point, zoom: number): Point | null {
    const distance = Math.hypot(input.x-last.x,input.y-last.y)*zoom;
    if (distance < 1.5) return null;
    const weight = Math.max(0, (distance-1.5)/distance);
    const follow = weight * distance/(distance+4);
    return {x:last.x+(input.x-last.x)*follow,y:last.y+(input.y-last.y)*follow};
}

export function drawingArrowHead(path: Pick<PathElement, 'points' | 'penStyle' | 'strokeWidth'>): Point[] {
    if (path.penStyle !== 'arrow' || path.points.length < 2) return [];
    const end = path.points[path.points.length - 1];
    let previous = end;
    for (let i = path.points.length - 2; i >= 0; i--) {
        previous = path.points[i];
        if (Math.hypot(end.x-previous.x,end.y-previous.y) >= Math.max(8,path.strokeWidth*2)) break;
    }
    const distance = Math.hypot(end.x-previous.x,end.y-previous.y);
    if (distance < 0.1) return [];
    const angle = Math.atan2(end.y-previous.y,end.x-previous.x);
    const length = Math.min(Math.max(10,path.strokeWidth*3.5),distance*0.8);
    return [
        {x:end.x-length*Math.cos(angle-Math.PI/6),y:end.y-length*Math.sin(angle-Math.PI/6)},
        end,
        {x:end.x-length*Math.cos(angle+Math.PI/6),y:end.y-length*Math.sin(angle+Math.PI/6)},
    ];
}

/** One geometry owner for live drawing, thumbnails and exported pixels. */
export function drawingPathData(path: Pick<PathElement,'points'|'smooth'|'penStyle'|'strokeWidth'>): string {
    const points = path.points;
    if (!points.length) return '';
    let result = `M ${points[0].x} ${points[0].y}`;
    if (points.length === 1) return `${result} l 0.001 0`;
    if (path.smooth && points.length > 2) {
        for (let i=1;i<points.length-1;i++) {
            const point=points[i],next=points[i+1];
            result += ` Q ${point.x} ${point.y} ${(point.x+next.x)/2} ${(point.y+next.y)/2}`;
        }
        const end=points[points.length-1];result+=` L ${end.x} ${end.y}`;
    } else for (const point of points.slice(1)) result+=` L ${point.x} ${point.y}`;
    const head=drawingArrowHead(path);
    if(head.length) result+=` M ${head[0].x} ${head[0].y} L ${head[1].x} ${head[1].y} L ${head[2].x} ${head[2].y}`;
    return result;
}

export const drawingDash = (path: Pick<PathElement,'penStyle'|'strokeWidth'>): string | undefined =>
    path.penStyle==='dotted' ? `0 ${Math.max(1,path.strokeWidth*2.5)}` : undefined;

function distanceToSegment(point:Point,a:Point,b:Point):number {
    const dx=b.x-a.x,dy=b.y-a.y,length=dx*dx+dy*dy;
    const t=length?Math.max(0,Math.min(1,((point.x-a.x)*dx+(point.y-a.y)*dy)/length)):0;
    return Math.hypot(point.x-a.x-t*dx,point.y-a.y-t*dy);
}

/** Clip a polyline against the swept circular eraser, including sparse long segments. */
export function eraseDrawingPoints(points:readonly Point[],from:Point,to:Point,radius:number):Point[][] {
    if (!points.length) return [];
    const inside=(point:Point)=>distanceToSegment(point,from,to)<radius-1e-7;
    if(points.length===1)return inside(points[0])?[]:[points as Point[]];
    const fragments:Point[][]=[];let fragment:Point[]=[];let changed=false;
    const finish=()=>{if(fragment.length>1)fragments.push(fragment);fragment=[];};
    const sweepX=to.x-from.x,sweepY=to.y-from.y,sweepLength=Math.hypot(sweepX,sweepY);
    for(let i=1;i<points.length;i++){
        const a=points[i-1],b=points[i],dx=b.x-a.x,dy=b.y-a.y,A=dx*dx+dy*dy;
        if(!A)continue;
        const cuts=[0,1];
        const add=(t:number)=>{if(t>0&&t<1)cuts.push(t);};
        for(const center of [from,to]){
            const ox=a.x-center.x,oy=a.y-center.y,B=2*(ox*dx+oy*dy),C=ox*ox+oy*oy-radius*radius;
            const discriminant=B*B-4*A*C;
            if(discriminant>=0){const root=Math.sqrt(discriminant);add((-B-root)/(2*A));add((-B+root)/(2*A));}
        }
        if(sweepLength){
            const cross=(a.x-from.x)*sweepY-(a.y-from.y)*sweepX,delta=dx*sweepY-dy*sweepX;
            if(Math.abs(delta)>1e-9)for(const side of [-1,1])add((side*radius*sweepLength-cross)/delta);
        }
        cuts.sort((left,right)=>left-right);
        const at=(t:number)=>({x:a.x+t*dx,y:a.y+t*dy});
        for(let j=1;j<cuts.length;j++){
            if(cuts[j]-cuts[j-1]<1e-9)continue;
            if(inside(at((cuts[j]+cuts[j-1])/2))){changed=true;finish();continue;}
            const start=at(cuts[j-1]),end=at(cuts[j]);
            if(!fragment.length)fragment.push(start);
            fragment.push(end);
        }
    }
    finish();return changed?fragments:[points as Point[]];
}
