"""Rename one legacy ArtStation package, preserving GLB buffers and FBX properties.
Backup and mapping are retained outside the asset library. No model re-export.
"""
import argparse, hashlib, json, re, shutil, struct
from datetime import datetime
from pathlib import Path


def patch_fbx(data, mapping, folder):
    version = struct.unpack_from('<I', data, 23)[0]
    fmt = '<QQQB' if version >= 7500 else '<IIIB'
    header = struct.calcsize(fmt)
    fixed = {'Y':2, 'C':1, 'I':4, 'F':4, 'D':8, 'L':8}
    changed = []

    def node(pos, output_pos):
        end, count, length, name_len = struct.unpack_from(fmt, data, pos)
        if not end:
            return data[pos:pos+header], pos+header
        name = data[pos+header:pos+header+name_len]
        cursor = pos+header+name_len
        props = bytearray()
        for _ in range(count):
            start = cursor
            kind = chr(data[cursor]); cursor += 1
            if kind in fixed:
                cursor += fixed[kind]
            elif kind in 'fdlibc':
                size = struct.unpack_from('<I',data,cursor+8)[0]
                cursor += 12+size
            elif kind in 'SR':
                size = struct.unpack_from('<I',data,cursor)[0]
                value = data[cursor+4:cursor+4+size]; cursor += 4+size
                if kind == 'S':
                    text = value.decode('utf-8',errors='surrogateescape')
                    new = text
                    for old, replacement in mapping.items():
                        if text == old:
                            new = replacement; break
                        if text.replace('\\','/').endswith('/'+old):
                            new = str(folder/replacement) if name in (b'FileName',b'Filename') else replacement
                            break
                    if new != text:
                        value = new.encode('utf-8',errors='surrogateescape')
                        props.extend(b'S'+struct.pack('<I',len(value))+value)
                        changed.append((text,new)); continue
            else:
                raise ValueError('Unsupported FBX property '+kind)
            props.extend(data[start:cursor])
        assert cursor == pos+header+name_len+length
        children = bytearray()
        while cursor < end:
            child,cursor = node(cursor,output_pos+header+name_len+len(props)+len(children))
            children.extend(child)
        assert cursor == end
        result = struct.pack(fmt,output_pos+header+name_len+len(props)+len(children),count,len(props),name_len)+name+props+children
        return result,end

    result = bytearray(data[:27]); pos = 27
    while any(data[pos:pos+header]):
        value,pos = node(pos,len(result)); result.extend(value)
    result.extend(data[pos:])
    return bytes(result),changed


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('folder',type=Path)
    parser.add_argument('--backup',type=Path,required=True)
    args=parser.parse_args(); folder=args.folder.resolve(); stem=folder.name
    roles={'c':'BaseColor','c_rgba':'BaseColor','n':'Normal','r_metalrough':'MetallicRoughness','c_metalrough':'MetallicRoughness_Color'}
    mapping={}
    for file in folder.iterdir():
        if re.fullmatch(r'scene\.(glb|fbx)',file.name,re.I): mapping[file.name]=stem+file.suffix
        match=re.fullmatch(r'mat(\d+)_([a-z_]+)(\.[a-z0-9]+)',file.name,re.I)
        if match and match[2] in roles: mapping[file.name]=f'{stem}_mat{match[1]}_{roles[match[2]]}{match[3]}'
    assert mapping and len(set(mapping.values()))==len(mapping)
    assert not any((folder/name).exists() for name in mapping.values())
    backup=args.backup.resolve()/datetime.now().strftime('%Y%m%d-%H%M%S')
    shutil.copytree(folder,backup/'original')
    glb=(folder/'scene.glb').read_bytes()
    length,kind=struct.unpack_from('<II',glb,12); assert kind==0x4e4f534a
    doc=json.loads(glb[20:20+length]); tail=glb[20+length:]
    for image in doc.get('images',[]):
        if image.get('name') in mapping: image['name']=mapping[image['name']]
        if image.get('uri') in mapping: image['uri']=mapping[image['uri']]
    body=json.dumps(doc,ensure_ascii=False,separators=(',',':')).encode(); body+=b' '*((-len(body))%4)
    updated=glb[:8]+struct.pack('<I',20+len(body)+len(tail))+struct.pack('<II',len(body),kind)+body+tail
    assert updated[20+len(body):]==tail
    fbx,changes=patch_fbx((folder/'scene.fbx').read_bytes(),mapping,folder)
    # A second parse must find no old names and must be byte-identical.
    checked,remaining=patch_fbx(fbx,mapping,folder); assert checked==fbx and not remaining
    (backup/'mapping.json').write_text(json.dumps({'folder':str(folder),'names':mapping,'fbxReferences':changes,'glbBufferSHA256':hashlib.sha256(tail).hexdigest()},ensure_ascii=False,indent=2),encoding='utf-8')
    try:
        for old,new in mapping.items(): (folder/old).rename(folder/new)
        (folder/mapping['scene.glb']).write_bytes(updated)
        (folder/mapping['scene.fbx']).write_bytes(fbx)
        for old,new in mapping.items():
            if old.endswith(('.png','.jpg')): assert hashlib.sha256((folder/new).read_bytes()).digest()==hashlib.sha256((backup/'original'/old).read_bytes()).digest()
    except Exception:
        for old,new in mapping.items():
            if (folder/new).exists(): (folder/new).unlink()
            shutil.copy2(backup/'original'/old,folder/old)
        raise
    print(json.dumps({'renamed':len(mapping),'fbxReferencesUpdated':len(changes),'backup':str(backup)},ensure_ascii=False))


if __name__=='__main__': main()
