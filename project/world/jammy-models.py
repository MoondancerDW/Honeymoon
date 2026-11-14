"""Build the Jammy furniture quad and collision catalog from the 1.4.7 client."""

import argparse
from contextlib import ExitStack
import io
import json
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
from zipfile import ZipFile

from PIL import Image


PROJECT = Path(__file__).resolve().parents[1]
SOURCES = PROJECT.parent / 'sources' / 'Honeymoon'
MOD = 'mods/1.4.7_Jammy_Furniture_Mod_V4.1.zip'
PACK = 'texturepacks/My-Little-Ponyach-147f.zip'
CLIENT = 'minecraft.jar'
TRACE = Path(__file__).with_name('jammy-trace')
ATLAS_WIDTH = 1024
GUTTER = 2
BOX_FIELDS = ('x0', 'y0', 'z0', 'x1', 'y1', 'z1')
SOFA_CONFIG = {'chair': 'arm_chair', 'left': 'sofa_left', 'right': 'sofa_right',
               'center': 'sofa_center', 'corner': 'sofa_corner'}


def java_bin(name, java_home):
    if java_home:
        path = java_home / 'bin' / (name + '.exe' if os.name == 'nt' else name)
        if not path.is_file():
            raise FileNotFoundError(path)
        return str(path)
    path = shutil.which(name)
    if not path:
        raise FileNotFoundError(f'{name}: add a Java 8 JDK to PATH or pass --java-home')
    return path


def run(command):
    result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or f'{command[0]} exited with {result.returncode}')
    return result.stdout


def capture(source, java_home):
    config = (source / 'config' / 'JammyFurnitureMod.conf').read_text(encoding='utf-8-sig')
    block_ids = re.findall(r'(?m)^(\w+)\s*\{\s*(?:#[^\n]*\n\s*)*id\s*\{\s*I:block=(\d+)', config)
    if len({id_ for _, id_ in block_ids}) != len(block_ids):
        raise ValueError('Jammy configuration contains duplicate block IDs')

    work = PROJECT / 'work' / 'models'
    work.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='jammy-', dir=work) as compiled:
        classpath = [str(source / CLIENT), str(source / MOD)]
        run([java_bin('javac', java_home), '-cp', os.pathsep.join(classpath), '-d', compiled,
             *(str(file) for file in sorted(TRACE.rglob('*.java')))])
        output = run([java_bin('java', java_home), '-cp', os.pathsep.join([compiled, *classpath]),
                      'CaptureJammy', *(f'{name}={id_}' for name, id_ in block_ids)])

    models = {}
    surfaces = []
    for line in output.splitlines():
        kind, *fields = line.split('\t')
        if kind == 'model':
            id_, meta, renderer = fields
            key = f'legacy:{id_}:{meta}'
            model = {'renderer': renderer, 'surfaces': [], 'collision': [], 'selection': []}
            models[key] = model
            surfaces = model['surfaces']
        elif kind == 'open':
            id_, meta = fields
            model = models[f'legacy:{id_}:{meta}']
            surfaces = model['openSurfaces'] = []
        elif kind == 'quad':
            texture, positions, uv = fields
            surfaces.append({'texture': texture.lstrip('/'), 'positions': numbers(positions, 12),
                             'uv': numbers(uv, 8)})
        elif kind in ('collision', 'selection'):
            model[kind].append(bounds(fields[0]))
        else:
            raise ValueError(f'Unexpected output from Java model capture: {line!r}')
    if len(models) != 16 * len(block_ids) or any(not model['surfaces'] for model in models.values()):
        raise ValueError('Incomplete Jammy model capture')
    ids = dict(block_ids)
    sofa_ids = {role: int(ids[name]) for role, name in SOFA_CONFIG.items()}
    return models, sofa_ids


def parsed_numbers(string, expected):
    values = [float(value) for value in string.split(',')]
    if len(values) != expected or not all(map(math.isfinite, values)):
        raise ValueError(f'Invalid capture values: {string}')
    return values


def numbers(string, expected):
    return [round(value, 8) + 0.0 for value in parsed_numbers(string, expected)]


def bounds(string):
    # A standing player must start exactly on the source AABB plane. Rounding
    # floating-point bounds down can put the player's feet inside the block.
    values = parsed_numbers(string, 6)
    if any(lo >= hi for lo, hi in zip(values[:3], values[3:])):
        raise ValueError(f'Invalid AABB: {string}')
    return dict(zip(BOX_FIELDS, values))


def all_surfaces(models):
    for model in models.values():
        yield from model['surfaces']
        yield from model.get('openSurfaces', ())


def extract_textures(source, models):
    textures = {surface['texture'] for surface in all_surfaces(models)}
    images = {}
    with ExitStack() as files:
        archives = {name: files.enter_context(ZipFile(source / name)) for name in (PACK, CLIENT, MOD)}
        for texture in sorted(textures):
            for name, archive in archives.items():
                try:
                    content = archive.read(texture)
                except KeyError:
                    continue
                with Image.open(io.BytesIO(content)) as image:
                    images[texture] = (image.convert('RGBA'), name)
                break
            else:
                raise FileNotFoundError(f'Missing source texture: {texture}')
    return images


def pack_atlas(images):
    x = y = row_height = 0
    entries = {}
    for texture, (image, archive) in sorted(images.items(), key=lambda entry: (-entry[1][0].height, entry[0])):
        width = image.width + GUTTER * 2
        height = image.height + GUTTER * 2
        if width > ATLAS_WIDTH:
            raise ValueError(f'Texture {texture} is wider than the Jammy atlas')
        if x + width > ATLAS_WIDTH:
            x = 0
            y += row_height
            row_height = 0
        entries[texture] = {'x': x + GUTTER, 'y': y + GUTTER, 'width': image.width,
                            'height': image.height, 'archive': archive}
        row_height = max(row_height, height)
        x += width

    atlas_height = 1 << (y + row_height - 1).bit_length()
    atlas = Image.new('RGBA', (ATLAS_WIDTH, atlas_height))
    for texture, entry in entries.items():
        image = images[texture][0]
        px, py = entry['x'], entry['y']
        width, height = image.size
        # Repeat edge texels into the gutter so UVs on the texture border stay local.
        atlas.paste(image, (px, py))
        atlas.paste(image.crop((0, 0, 1, height)).resize((GUTTER, height), Image.Resampling.NEAREST), (px - GUTTER, py))
        atlas.paste(image.crop((width - 1, 0, width, height)).resize((GUTTER, height), Image.Resampling.NEAREST),
                    (px + width, py))
        for edge, destination in ((py, py - GUTTER), (py + height - 1, py + height)):
            strip = atlas.crop((px - GUTTER, edge, px + width + GUTTER, edge + 1))
            atlas.paste(strip.resize((width + GUTTER * 2, GUTTER), Image.Resampling.NEAREST), (px - GUTTER, destination))
    return atlas, entries


def generate(source, output, java_home):
    models, sofa_ids = capture(source, java_home)
    images = extract_textures(source, models)
    atlas, entries = pack_atlas(images)
    for surface in all_surfaces(models):
        texture = entries[surface.pop('texture')]
        uvs = surface['uv']
        if any(value < 0 or value > 1 for value in uvs):
            raise ValueError('Cannot pack wrapped UVs')
        for i in range(0, len(uvs), 2):
            uvs[i] = round((texture['x'] + uvs[i] * texture['width']) / atlas.width, 9)
            uvs[i + 1] = round((texture['y'] + uvs[i + 1] * texture['height']) / atlas.height, 9)

    output.mkdir(parents=True, exist_ok=True)
    atlas.save(output / 'jammy.png')
    catalog = {'schemaVersion': 4, 'atlas': {'width': atlas.width, 'height': atlas.height, 'textures': entries},
               'sofaIds': sofa_ids, 'models': models}
    (output / 'jammy.json').write_text(json.dumps(catalog, separators=(',', ':')) + '\n', encoding='utf-8')
    faces = sum(1 for _ in all_surfaces(models))
    print(f'Jammy: {len(models)} states, {faces} quads, {len(images)} textures, atlas {atlas.width}x{atlas.height}')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, default=SOURCES)
    parser.add_argument('--output', type=Path, default=PROJECT / 'generated' / 'models')
    parser.add_argument('--java-home', type=Path, default=os.environ.get('JAVA_HOME'))
    args = parser.parse_args()
    java_home = args.java_home
    if not java_home and not shutil.which('javac'):
        candidate = PROJECT / 'work' / 'legacy-reference' / 'java' / 'jdk8u512-b09'
        if candidate.is_dir():
            java_home = candidate
    generate(args.source.resolve(), args.output.resolve(), java_home)


if __name__ == '__main__':
    main()
