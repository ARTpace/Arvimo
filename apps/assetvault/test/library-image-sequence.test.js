import test from 'node:test';
import assert from 'node:assert/strict';
import {groupImageSequences, parseSequenceName, MIN_FRAMES} from '../src/library/image-sequence.js';

const file=(rel,extra={})=>({root:'R',rel,name:rel.split('/').pop(),ext:rel.split('.').pop(),kind:'image',bytes:10,mtime:1,...extra});

test('parseSequenceName 只认尾部编号',()=>{
 assert.deepEqual(parseSequenceName('frame_0012.png'),{prefix:'frame_',index:12,ext:'png',digits:4});
 assert.deepEqual(parseSequenceName('001.png'),{prefix:'',index:1,ext:'png',digits:3});
 assert.equal(parseSequenceName('render_final.png'),null);
 assert.equal(parseSequenceName('0012'),null);
});

test('同前缀同扩展名的连续图折叠成一条序列，帧按编号升序',()=>{
 const files=[file('seq/frame_0003.png'),file('seq/frame_0001.png'),file('seq/frame_0002.png')];
 const {sequences,memberKeys}=groupImageSequences(files);
 assert.equal(sequences.length,1);
 const seq=sequences[0];
 assert.equal(seq.count,3);
 assert.deepEqual(seq.frames.map(frame=>frame.index),[1,2,3]);
 assert.equal(seq.label,'frame_0001–0003.png');
 assert.equal(seq.bytes,30);
 assert.equal(memberKeys.size,3);
});

test('不到 3 帧不叫序列，文件原样留在 loose 里',()=>{
 const files=[file('a_1.png'),file('a_2.png')];
 const {sequences,loose}=groupImageSequences(files);
 assert.equal(sequences.length,0);
 assert.equal(loose.length,2);
 assert.ok(MIN_FRAMES>=3);
});

test('前缀或扩展名不同就分组',()=>{
 const files=[file('x_1.png'),file('x_2.png'),file('x_3.png'),file('y_1.png'),file('y_2.png'),file('y_3.png'),file('x_1.jpg'),file('x_2.jpg'),file('x_3.jpg')];
 const {sequences}=groupImageSequences(files);
 assert.equal(sequences.length,3);
 assert.deepEqual(sequences.map(seq=>`${seq.prefix}${seq.ext}`).sort(),['x_jpg','x_png','y_png']);
});

test('撞号（a_1 与 a_01）整组作废，避免吞掉正常的独立图',()=>{
 const files=[file('a_1.png'),file('a_01.png'),file('a_2.png'),file('a_3.png')];
 const {sequences}=groupImageSequences(files);
 assert.equal(sequences.length,0);
});

test('非 image 文件不参与序列',()=>{
 const files=[file('t_1.mov',{kind:'video'}),file('t_2.mov',{kind:'video'}),file('t_3.mov',{kind:'video'})];
 const {sequences,loose}=groupImageSequences(files);
 assert.equal(sequences.length,0);
 assert.equal(loose.length,3);
});

test('不同目录即使前缀相同也分开',()=>{
 const files=[file('a/s_1.png'),file('a/s_2.png'),file('a/s_3.png'),file('b/s_1.png'),file('b/s_2.png'),file('b/s_3.png')];
 const {sequences}=groupImageSequences(files);
 assert.equal(sequences.length,2);
 assert.deepEqual(sequences.map(seq=>seq.dir).sort(),['a','b']);
});

test('memberKeys 只包含已成序列的帧，loose 不含它们',()=>{
 const files=[file('k_1.png'),file('k_2.png'),file('k_3.png'),file('other.png')];
 const {memberKeys,loose,sequences}=groupImageSequences(files);
 assert.equal(sequences.length,1);
 assert.deepEqual(loose.map(item=>item.name),['other.png']);
 assert.ok(memberKeys.has('R|k_1.png'));
 assert.ok(!memberKeys.has('R|other.png'));
});
