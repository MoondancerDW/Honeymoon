"""Port Minecraft 1.4.7 BiblioCraft ModelRenderer meshes and source textures."""

import argparse
from base64 import b64decode
from contextlib import ExitStack
import json
from math import cos, pi, sin
from pathlib import Path
from csv import DictReader
import re
from subprocess import run

from PIL import Image, ImageChops

from textures import DEFAULT_SOURCE, TextureAtlas


HERE = Path(__file__).resolve().parent
DEFAULT_OUTPUT = HERE.parent / 'generated' / 'models'
DEFAULT_WORLD_DATA = HERE.parent / 'generated' / 'world'
MODEL_BOXES = HERE / 'biblio-model-boxes.json'
ITEM_TEXTURES = HERE / 'biblio-item-textures.json'
FLAT_ITEM_REGISTRY = HERE / 'flat-item-registry.tsv'
MODELS = ('ArmorStand', 'Bookcase', 'GenericShelf', 'Label', 'PotionShelf', 'ToolRack',
          'WeaponCase', 'WritingDesk')
TEXTURE_DIR = 'jds/bibliocraft/textures/'
EXTRA_ARCHIVES = {
    'lilium': 'mods/Lilium.Items.zip',
    'mocreatures': 'mods/DrZharks MoCreatures Mod v4.7.0.zip',
    'redpower': 'mods/RedPowerCore-2.0pr6.zip',
}


def numbers(text):
    return [float(value.strip().removesuffix('f')) for value in text.split(',')]


def extract_model_boxes(decompiled):
    """Read the ModelRenderer constructor calls from CFR's BiblioCraft output."""
    result = {}
    for name in MODELS:
        source = (decompiled / 'jds/bibliocraft/models' / f'Model{name}.java').read_text(encoding='utf-8')
        constructor = source.split(f'public Model{name}() {{', 1)[1].split('\n    }', 1)[0]
        width, height = map(int, re.findall(r'this\.[tu] = (\d+);', constructor))
        named_uv = {key: [int(u), int(v)] for key, u, v in re.findall(
            r'this\.a\("([\w.]+)", (\d+), (\d+)\);', constructor)}
        renderers, boxes = {}, []
        for line in constructor.splitlines():
            if match := re.search(r'this\.(\w+) = new ayf\(\(axa\)this, (.*)\);', line):
                part, offset = match.groups()
                renderers[part] = {
                    'uv': offset.strip('"') if offset.startswith('"') else numbers(offset),
                    'pivot': [0, 0, 0], 'rotation': [0, 0, 0], 'mirror': False,
                }
            elif match := re.search(r'this\.(\w+)\.a\((.*)\);', line):
                part, args = match.groups()
                renderer = renderers[part]
                uv = renderer['uv']
                if args.startswith('"'):
                    child, args = args.split(', ', 1)
                    part = uv + '.' + child.strip('"')
                    uv = named_uv[part]
                values = numbers(args)
                if len(values) == 3:
                    renderer['pivot'] = values
                elif len(values) in (6, 7):
                    boxes.append((part, renderer, renderer['mirror'], uv, values))
                else:
                    raise ValueError(f'Unexpected ModelRenderer box arguments: {line}')
            elif match := re.search(r'this\.(\w+)\.i = (true|false);', line):
                part, mirror = match.groups()
                renderers[part]['mirror'] = mirror == 'true'
            elif match := re.search(r'this\.setRotation\(this\.(\w+), (.*)\);', line):
                part, angles = match.groups()
                renderers[part]['rotation'] = numbers(angles)
        result[name] = {'textureSize': [width, height], 'parts': {
            part: [uv, values, renderer['pivot'], renderer['rotation'], mirror]
            for part, renderer, mirror, uv, values in boxes
        }}
    return result


def rotate(point, axis, radians):
    point = list(point)
    first, second = (axis + 1) % 3, (axis + 2) % 3
    a, b = point[first], point[second]
    point[first] = a * cos(radians) - b * sin(radians)
    point[second] = a * sin(radians) + b * cos(radians)
    return point


class PackedTextures:
    def __init__(self, textures, height=1024):
        self.textures = textures
        self.image = Image.new('RGBA', (2048, height))
        self.offsets = {}
        self.x = self.y = self.row = 0

    def add(self, resource, image=None):
        if resource in self.offsets:
            return self.offsets[resource]
        if image is None:
            image = self.textures.resolve(TEXTURE_DIR + resource + '.png', 'biblio')
        if self.x + image.width > self.image.width:
            self.x = 0
            self.y += self.row
            self.row = 0
        if self.y + image.height > self.image.height:
            raise ValueError('BiblioCraft textures exceed the atlas size')
        self.image.paste(image, (self.x, self.y))
        result = (self.x, self.y, image)
        self.offsets[resource] = result
        self.x += image.width + 1
        self.row = max(self.row, image.height + 1)
        return result

    def sprite(self, resource, image):
        x, y, _ = self.add(resource, image)
        # Pixel centers keep sampling inside a sprite even on very thin quads.
        return [(x + .25) / self.image.width, (y + .25) / self.image.height,
                (x + image.width - .25) / self.image.width, (y + image.height - .25) / self.image.height]

    def quad(self, resource, size, points, uv):
        x, y, image = self.add(resource)
        u_scale, v_scale = image.width / size[0], image.height / size[1]
        texels = [(u * u_scale, v * v_scale) for u, v in uv]
        left, right = sorted((texels[0][0], texels[1][0]))
        top, bottom = sorted((texels[0][1], texels[2][1]))
        patch = image.crop((int(left), int(top), int(right), int(bottom)))
        alpha = patch.getchannel('A').getextrema()
        if alpha is None or alpha[1] == 0:
            return None
        # With nearest filtering, keep shared model edges inside their UV rectangle.
        texels = [(u + (.25 if u == left else -.25), v + (.25 if v == top else -.25))
                  for u, v in texels]
        result = {
            'positions': [round(v, 7) for point in points for v in point],
            'uv': [round(value, 8) for u, v in texels for value in (
                (x + u) / self.image.width, (y + v) / self.image.height)],
            'mode': 'opaque' if alpha[0] == 255 else 'cutout',
        }
        return result


def model_box(part, atlas, resource, size, translate, rotations=(), scale=1/16, lid=0):
    """Minecraft ModelBox (aya) constructs UVs from the pre-mirror corner order."""
    (u, v), bounds, pivot, angles, mirror = part
    x, y, z, w, h, d, *inflate = bounds
    extra = inflate[0] if inflate else 0
    x0, x1 = x - extra, x + w + extra
    y0, y1 = y - extra, y + h + extra
    z0, z1 = z - extra, z + d + extra
    if mirror:
        x0, x1 = x1, x0
    vertices = ((x0, y0, z0), (x1, y0, z0), (x1, y1, z0), (x0, y1, z0),
                (x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1))

    def transform(point):
        for axis, angle in enumerate(angles):
            if angle:
                point = rotate(point, axis, angle)
        if lid:
            point = rotate(point, 2, lid)
        point = [(position + offset) * scale for position, offset in zip(point, pivot)]
        for axis, angle in rotations:
            point = rotate(point, axis, angle)
        return [position + offset for position, offset in zip(point, translate)]

    a, b, c, e = u + d, u + d + w, u + 2 * d + w, u + 2 * d + 2 * w
    top, bottom = v + d, v + d + h
    quads = [
        ((5, 1, 2, 6), (b, top, c, bottom)), ((0, 4, 7, 3), (u, top, a, bottom)),
        ((5, 4, 0, 1), (a, v, b, top)), ((2, 3, 7, 6), (b, top, b + w, v)),
        ((1, 0, 3, 2), (a, top, b, bottom)), ((4, 5, 6, 7), (c, top, e, bottom)),
    ]
    surfaces = []
    for indices, (u0, v0, u1, v1) in quads:
        points = [transform(vertices[index]) for index in indices]
        uv = [(u1, v0), (u0, v0), (u0, v1), (u1, v1)]
        if mirror:
            points.reverse()
            uv.reverse()
        if surface := atlas.quad(resource, size, points, uv):
            surfaces.append(surface)
    return surfaces


def build_models(raw, atlas):
    models = {}

    def add(block, meta, parts=(), groups=None):
        models[f'legacy:{block}:{meta}'] = {'surfaces': parts, **({'groups': groups} if groups else {})}

    def model(name, resource, translate, rotations=(), scale=1/16, lid=0):
        spec = raw[name]
        return {part: model_box(params, atlas, resource, spec['textureSize'], translate, rotations, scale, lid)
                for part, params in spec['parts'].items()}

    def mesh(parts, names=None):
        return [surface for name in (names if names is not None else parts) for surface in parts[name]]

    flip = ((0, pi),)
    add(2240, 0)
    stand = mesh(model('ArmorStand', 'armorstand', (.5, 1.5, .5), flip))
    for meta in range(8):
        add(2249, meta, stand if meta < 4 else [])
    desk_books = model('WritingDesk', 'writingdeskbooks', (.5, 1, .5), flip, 1/32)
    desk_groups = {'written': mesh(desk_books, ('wBookBack', 'wBookRight', 'wBookLeft'))}
    for side, prefix in [('left', 'lbook'), ('right', 'rbook')]:
        for index in range(1, 5):
            desk_groups[side + str(index)] = desk_books[prefix + str(index)]
    for meta in range(4):
        desk = model('WritingDesk', f'writingdesk{meta + 1}', (.5, 1, .5), flip, 1/32)
        add(2248, meta, mesh(desk, (part for part in desk if 'book' not in part.lower())), desk_groups)
        bookcase = model('Bookcase', f'BookcaseTexture{meta + 1}', (.5, .5, .5), scale=1/32)
        books = {('top' if index <= 8 else 'bottom') + str(1 + (index - 1) % 8): bookcase[f'Book{index}']
                 for index in range(1, 17)}
        add(2250, meta, mesh(bookcase, (part for part in bookcase if not part.startswith('Book'))), books)
        add(2251, meta, mesh(model('Label', f'woodlabel{meta}', (.5, .3, .01), flip, 1/32)))
        add(2252, meta, mesh(model('PotionShelf', f'potionshelf{meta + 1}', (.5, .46875, .5), flip, 1/32)))
        rack_rotations = ((1, pi/2), (0, pi), (1, pi))
        add(2253, meta, mesh(model('ToolRack', f'toolrack{meta + 1}', (.5, 1.5, .5), rack_rotations)))
        add(2254, meta, mesh(model('GenericShelf', f'genericshelf{meta + 1}', (.5, 1, .5), flip)))

    for meta in range(16):
        shell = f'weaponcase{meta // 4 + 1}'
        liner = f'weaponcaseinner{meta % 4 + 1}'
        variants = {}
        for key, translate, rotations, open_lid in (
            ('floor', (.5, 1.5, .5), ((0, pi), (1, pi/2)), .8),
            ('wall', (.5, .5, 1.5), ((0, -pi/2),), 1.5),
        ):
            case = model('WeaponCase', shell, translate, rotations)
            inner = model('WeaponCase', liner, translate, rotations)
            variants[key] = (mesh(case, (part for part in case if not part.startswith(('inner', 'innter', 'lid.')))) +
                             mesh(inner, (part for part in inner if part.startswith(('inner', 'innter')))))
            lids = [part for part in case if part.startswith('lid.')]
            variants[key + 'Lid'] = mesh(case, lids)
            variants[key + 'LidOpen'] = mesh(model('WeaponCase', shell, translate, rotations, lid=open_lid), lids)
        add(2255, meta, variants.pop('floor'), variants)
    return models


def texture_dependency(resource):
    prefixes = {'pam/': 'pam', 'assets/Lilium.Items/': 'lilium', 'MLB/': 'cloud',
                'mods/mocreatures/': 'mocreatures', 'eloraam/world/': 'mechanical', 'eloraam/': 'redpower'}
    return next((archive for prefix, archive in prefixes.items() if resource.startswith(prefix)), 'vanilla')


def paint(image, color):
    shade = (color >> 16, color >> 8 & 255, color & 255, 255)
    return ImageChops.multiply(image, Image.new('RGBA', image.size, shade))


def build_item_textures(raw, atlas):
    sheets, result = {}, {}

    def tile(resource, index):
        if resource not in sheets:
            dependency = texture_dependency(resource)
            image = atlas.textures.resolve(resource, dependency, required=False)
            if image is None:
                # A mod can return an old unnamespaced sheet path in getTextureFile.
                for archive in atlas.textures.archive_paths:
                    if archive in ('pack', 'vanilla', dependency):
                        continue
                    source = atlas.textures.open_archive(archive)
                    if source is not None and resource in source.NameToInfo:
                        image = atlas.textures.resolve(resource, archive, required=False)
                        break
            sheets[resource] = image
        image = sheets[resource]
        if image is None:
            return None
        if index is None:
            return image
        if not 0 <= index < 256 or image.width % 16 or image.height % 16:
            return None
        x, y = index % 16, index // 16
        w, h = image.width // 16, image.height // 16
        return image.crop((x * w, y * h, (x + 1) * w, (y + 1) * h))

    for key, (resource, passes, *block) in raw.items():
        if block and block[0][0] == 0:
            _, texture, faces, *shape = block[0]
            face_images = [tile(texture, index) for index in faces]
            if all(face_images):
                result[key] = {'faces': [atlas.sprite(f'{texture}:{index}', image)
                                         for index, image in zip(faces, face_images)]}
                if shape:
                    result[key]['cover'] = shape[0] == 'cover'
            continue
        image = None
        for index, tint in passes:
            layer = tile(resource, index)
            if layer is None:
                break
            layer = paint(layer, tint)
            image = layer if image is None else Image.alpha_composite(image, layer)
        if image is not None and image.getchannel('A').getbbox():
            signature = resource + ':' + json.dumps(passes,separators=(',', ':'))
            result[key] = {'uv': atlas.sprite(signature, image), 'block': bool(block)}
    return result


def inventory(registry):
    defaults = {
        '260:0': (10, 'Яблоко', 'Apple'),
        '264:0': (55, 'Алмаз', 'Diamond'),
        '265:0': (23, 'Железный слиток', 'Iron Ingot'),
        '266:0': (39, 'Золотой слиток', 'Gold Ingot'),
        '280:0': (53, 'Палка', 'Stick'),
        '287:0': (8, 'Нить', 'String'),
        '288:0': (24, 'Перо', 'Feather'),
        '328:0': (135, 'Вагонетка', 'Minecart'),
        '331:0': (56, 'Красная пыль', 'Redstone'),
        '339:0': (58, 'Бумага', 'Paper'),
        '340:0': (59, 'Книга', 'Book'),
        '389:0': (206, 'Рамка для предметов', 'Item Frame'),
        '388:0': (186, 'Изумруд', 'Emerald'),
    }
    textures = {key:['gui/items.png',[[tile,0xffffff]]] for key,(tile,_,_) in defaults.items()}
    names = {key:(name,english,'Minecraft') for key,(_,name,english) in defaults.items()}
    armor = {}
    for start,prefix,suffix in [(12,'reptile',''),(60,'fur',''),(94,'hide',''),
                                (106,'',''),(110,'','frost'),(114,'','black'),(118,'','nether')]:
        armor.update({start+offset:prefix+part+suffix
                      for offset,part in enumerate(('plate','helmet','legs','boots'))})
    chisel = {0:'chisel',1:'cloudinabottle',2:'ballomoss'}
    if registry:
        with registry.open(encoding='utf-8-sig') as source:
            for item in DictReader(source,delimiter='\t'):
                id, damage = int(item['id']), int(item['damage'])
                if not 1 <= id <= 32767 or not 0 <= damage <= 32767:
                    continue
                passes = [tuple(map(int,pair.split(':'))) for pair in item['passes'].split(',') if pair]
                resource = item['textureFile'].strip().lstrip('/')
                if not resource or not passes or any(not 0 <= index < 256 for index,_ in passes):
                    continue
                index = passes[0][0]
                if resource == 'mocreatures/items.png' and index in armor:
                    resource = 'mods/mocreatures/textures/items/' + armor[index] + '.png'
                    passes = [[None,0xffffff]]
                if resource == 'atlas_72_items' and index in chisel:
                    resource = 'assets/chisel/textures/items/' + chisel[index] + '.png'
                    passes = [[None,0xffffff]]
                key = f'{id}:{damage}'
                english = item.get('nameEn', '').strip()
                name = item.get('nameRu', '').strip() or english
                class_name = item.get('class', '')
                mod = '.'.join(class_name.split('.')[:-1]) or 'Minecraft'
                textures[key] = [resource,passes]
                names[key] = (name or key,english or name or key,mod)
    return textures,names


def build_armor(atlas):
    # ModelDummy inherits these boxes from the original ModelBiped (aww).
    head = [([0, 0], [-4, -8, -4, 8, 8, 8], [0, 0, 0], [0, 0, 0], False),
            ([32, 0], [-4, -8, -4, 8, 8, 8, .5], [0, 0, 0], [0, 0, 0], False)]
    torso = [([16, 16], [-4, 0, -2, 8, 12, 4], [0, 0, 0], [0, 0, 0], False),
             ([40, 16], [-3, -2, -2, 4, 12, 4], [-5, 2, 0], [0, 0, 0], False),
             ([40, 16], [-1, -2, -2, 4, 12, 4], [5, 2, 0], [0, 0, 0], True)]
    legs = [([0, 16], [-2, 0, -2, 4, 12, 4], [-1.9, 12, 0], [0, 0, 0], False),
            ([0, 16], [-2, 0, -2, 4, 12, 4], [1.9, 12, 0], [0, 0, 0], True)]
    pieces = (
        (298, 'armor/cloth_1.png', 1.55, 1.02, head, (10511680, 5000268)),
        (299, 'armor/cloth_1.png', 1.6, 1.12, torso, (10511680,)),
        (300, 'armor/cloth_2.png', 1.8, 1.05, legs, (10511680, 5000268, 1644825)),
        (301, 'armor/cloth_1.png', 1.7, 1.1, legs, (10511680,)),
        (6310, 'assets/Lilium.Items/textures/models/armor/CapDragon.png', 1.55, 1.02, head, (0xffffff,)),
    )
    armor = {}
    for id, resource, height, scale, boxes, colors in pieces:
        image = atlas.textures.resolve(resource, texture_dependency(resource), required=False)
        if image is None:
            continue
        for color in colors:
            key = f'{id}:{color}'
            atlas.add(key, paint(image, color))
            armor[key] = [surface for part in boxes for surface in
                          model_box(part, atlas, key, (64, 32), (.5, height, .5), ((0, pi),), scale / 16)]
    return armor


def framed_map_ids(world_data):
    manifest = world_data / 'world.json'
    if not manifest.is_file():
        return set()
    world = json.loads(manifest.read_text(encoding='utf-8'))
    ids = set()
    for x, z in (*world['chunks'], *world.get('visualChunks', [])):
        chunk = json.loads((world_data / 'chunks' / f'{x}.{z}.json').read_text(encoding='utf-8'))
        for entity in chunk.get('entities', []):
            if entity['type'] == 'ItemFrame':
                item = entity.get('data', {}).get('Item', {})
                if item.get('id') == 358 and isinstance(item.get('Damage'), int) and item['Damage'] >= 0:
                    ids.add(item['Damage'])
    return ids


def build_framed_maps(world, world_data, atlas, items, map_ids):
    if not (world / 'data').is_dir():
        return
    ids = set(map_ids) | framed_map_ids(world_data)
    if not ids:
        return
    maps = run(['node', str(HERE / 'item-frame-maps.mjs'), str(world), *map(str, sorted(ids))],
               capture_output=True, check=True, text=True, encoding='utf-8')
    parchment = atlas.textures.resolve('misc/mapbg.png', 'vanilla')
    for map_id, rgba in json.loads(maps.stdout).items():
        image = parchment.resize((142, 142), Image.Resampling.NEAREST)
        image.alpha_composite(Image.frombytes('RGBA', (128, 128), b64decode(rgba)), (7, 7))
        items[f'358:{map_id}'] = {'uv': atlas.sprite(f'map:{map_id}', image), 'map': True}


def build(source, output, vanilla_jar=None, world=None, world_data=DEFAULT_WORLD_DATA, map_ids=(), flat_registry=None):
    with ExitStack() as stack:
        textures = TextureAtlas(source, stack, vanilla_jar)
        textures.archive_paths.update({name: source / path for name, path in EXTRA_ARCHIVES.items()})
        textures.archive_labels.update(EXTRA_ARCHIVES)
        tracked_archives = {path.resolve() for path in textures.archive_paths.values()}
        for path in sorted((source / 'mods').glob('*')):
            if path.suffix.lower() in ('.jar','.zip') and path.resolve() not in tracked_archives:
                archive = 'mods/' + path.name
                textures.archive_paths[archive] = path
                textures.archive_labels[archive] = archive
        native,names = inventory(flat_registry)
        atlas = PackedTextures(textures,2048 if len(native) > 350 else 1024)
        models = build_models(json.loads(MODEL_BOXES.read_text(encoding='utf-8')), atlas)
        items = build_item_textures(json.loads(ITEM_TEXTURES.read_text(encoding='utf-8')), atlas)
        sprites = build_item_textures(native,atlas)
        items.update(sprites)
        armor = build_armor(atlas)
        build_framed_maps(world or source / 'saves' / 'equestria', world_data, atlas, items, map_ids)
        flat = []
        for key,(name,english,mod) in names.items():
            if not items.get(key, {}).get('uv'):
                continue
            id,damage = map(int,key.split(':'))
            flat.append({'id':id,'damage':damage,'name':name,'english':english,'mod':mod})
        output.mkdir(parents=True, exist_ok=True)
        atlas.image.save(output / 'biblio.png', optimize=True)
        (output / 'biblio.json').write_text(json.dumps({
            'schemaVersion': 2, 'models': models, 'items': items, 'armor': armor, 'resources': textures.resources,
            'flatItems': flat,
        }, separators=(',', ':')) + '\n', encoding='utf-8')
    print(f'Extracted {len(flat)} creative flat item variants from {len(names)} native entries')
    return len(models)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, default=DEFAULT_SOURCE)
    parser.add_argument('--output', type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument('--vanilla-jar', type=Path)
    parser.add_argument('--world', type=Path, help='Read filled item maps from this legacy save')
    parser.add_argument('--world-data', type=Path, default=DEFAULT_WORLD_DATA,
                        help='Find mounted maps in this generated world manifest and chunks')
    parser.add_argument('--map-id', type=int, action='append', default=[],
                        help='Include an additional source map even when no generated world is present')
    parser.add_argument('--flat-registry', type=Path, default=FLAT_ITEM_REGISTRY,
                        help='Flat item registry TSV from the native creative registry probe')
    parser.add_argument('--refresh-boxes', type=Path, metavar='CFR_OUTPUT',
                        help='Refresh the checked-in ModelRenderer specification from decompiled BiblioCraft.zip')
    args = parser.parse_args()
    if args.refresh_boxes:
        boxes = extract_model_boxes(args.refresh_boxes)
        lines = ['{']
        for index, (name, model) in enumerate(boxes.items()):
            lines.append(f'  "{name}": {{"textureSize": {json.dumps(model["textureSize"])}, "parts": {{')
            lines.append(',\n'.join(f'    "{part}": {json.dumps(params)}' for part, params in model['parts'].items()))
            lines.append('  }}' + (',' if index + 1 < len(boxes) else ''))
        lines.append('}')
        MODEL_BOXES.write_text('\n'.join(lines) + '\n', encoding='utf-8')
    count = build(args.source,args.output,args.vanilla_jar,args.world,args.world_data,args.map_id,args.flat_registry)
    print(f'Extracted {count} BiblioCraft variants to {args.output}')
