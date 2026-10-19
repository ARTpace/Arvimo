"""Convert one glTF/GLB into FBX using Blender's own importer and exporter.

Called as:
    blender --background --factory-startup --python gltf-to-fbx.py -- <input.glb> <out_dir> <work_dir>

Textures are embedded in the FBX so the result is a single portable file; Blender's FBX exporter
also emits the loose maps next to it, which is what Unity users expect to be able to inspect.
"""
import os
import re
import sys

import bpy

# Characters Windows rejects in a filename, plus the separators FBX would read as a path.
ILLEGAL = re.compile(r'[<>:"/\\|?*\x00-\x1f]+')
IMAGE_SUFFIXES = ('.png', '.jpg', '.jpeg', '.tga', '.tif', '.tiff', '.bmp', '.exr', '.hdr', '.dds', '.webp')


def distinct_filename(image, taken):
    """A filesystem-safe basename that is unique within this export.

    The stem stays recognisable on purpose: Unity shows it as the texture name.
    """
    stem = ILLEGAL.sub('_', os.path.basename(image.name or '')).strip(' ._')
    if not stem:
        stem = 'texture'
    if os.path.splitext(stem)[1].lower() not in IMAGE_SUFFIXES:
        stem += '.' + (image.file_format.lower() if image.file_format else 'png')
    root, ext = os.path.splitext(stem)
    candidate, index = stem, 2
    while candidate.lower() in taken:
        candidate = '%s-%d%s' % (root, index, ext)
        index += 1
    taken.add(candidate.lower())
    return candidate


def name_every_texture(work_dir):
    """Give every image a distinct file path before the export.

    Blender's glTF importer leaves embedded (packed) images with an empty ``filepath``. The FBX
    exporter derives the media path from that path's basename, so with nothing to take a name from
    *every* texture collapsed onto the same ``<model>.fbm`` directory. Two things then went wrong:
    all materials pointed at one media path, and the exporter's "embed each file only once" dedup
    -- keyed on that same path -- embedded just the first image. Unity consequently showed the body
    texture on every part, clothing included.

    Returns ``(renamed, written)`` so the caller can report what happened.
    """
    target_dir = os.path.join(work_dir, 'textures')
    taken, renamed, written = set(), 0, 0
    for image in bpy.data.images:
        if image.type != 'IMAGE' or not all(image.size):
            continue
        source = bpy.path.abspath(image.filepath) if image.filepath else ''
        existing = os.path.basename(source) if source else ''
        if existing and os.path.isfile(source):
            # Backed by a real file already: the exporter can name and embed it unaided.
            taken.add(existing.lower())
            continue
        path = os.path.join(target_dir, distinct_filename(image, taken))
        image.filepath_raw = path
        renamed += 1
        if image.packed_file is None:
            # Nothing packed to embed from, so the exporter has to read this file: it must exist.
            try:
                os.makedirs(target_dir, exist_ok=True)
                if not image.file_format:
                    image.file_format = 'PNG'
                image.save()
                written += 1
            except Exception as error:  # noqa: BLE001 - never fail the export over one texture
                print("SFX_FBX_TEXTURE_WARNING could not write %s (%s)" % (path, error))
    return renamed, written


def main():
    argv = sys.argv[sys.argv.index("--") + 1:]
    source, out_dir, work_dir = argv[0], argv[1], argv[2]

    # Start from an empty scene: --factory-startup still loads the default cube, and a stray mesh
    # in the export is worse than useless.
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=source)

    renamed, written = name_every_texture(work_dir)
    print("SFX_FBX_TEXTURES renamed=%d written=%d" % (renamed, written))

    os.makedirs(out_dir, exist_ok=True)
    stem = os.path.splitext(os.path.basename(source))[0]
    destination = os.path.join(out_dir, stem + ".fbx")

    # Keep the argument set small on purpose: the FBX exporter's option names have moved between
    # Blender versions, and the defaults for everything omitted here are already what we want.
    bpy.ops.export_scene.fbx(
        filepath=destination,
        use_selection=False,
        path_mode="COPY",
        embed_textures=True,
        bake_anim=True,
        add_leaf_bones=False,
    )

    if not os.path.exists(destination):
        raise SystemExit("export_scene.fbx reported success but wrote no file")
    print("SFX_FBX_WRITTEN " + destination)


main()
