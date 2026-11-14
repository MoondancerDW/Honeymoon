"""Extract the two original RedPower shaped-lamp meshes and texture atlas."""
import argparse
from contextlib import ExitStack
from pathlib import Path
import json

from textures import DEFAULT_SOURCE, TextureAtlas


def read_model(text):
    positions, texture, faces = [], [], []
    group = 0
    for line in text.splitlines():
        fields = line.split()
        if not fields:
            continue
        tag, *values = fields
        if tag == 'v':
            positions.append(list(map(float, values)))
        elif tag in ('vt', 'vtc'):
            u, v = map(float, values[:2]); texture.append([u, 1 - v])
        elif tag == 'g':
            group = int(values[0])
        elif tag == 'f':
            quad = [tuple(int(index) - 1 for index in pair.split('/')) for pair in values]
            if len(quad) != 4:
                raise ValueError(f'Expected a RedPower surface quad: {line}')
            faces.append({'group': group, 'positions': [xyz for vertex, _ in quad for xyz in positions[vertex]],
                          'uv': [uv for _, uv_index in quad for uv in texture[uv_index]]})
    return faces


def extract(source, output):
    with ExitStack() as stack:
        atlas = TextureAtlas(source, stack)
        resource = atlas.resolve('eloraam/lighting/lighting1.png', 'digital')
        archive = atlas.open_archive('digital')
        lamps = [read_model(archive.read(f'eloraam/lighting/shlamp{i}.obj').decode('ascii')) for i in (1, 2)]
        output.mkdir(parents=True, exist_ok=True)
        resource.save(output / 'redpower.png')
        (output / 'redpower.json').write_text(json.dumps({'lamps': lamps}, separators=(',', ':')) + '\n', encoding='utf-8')
    print(f'Extracted {sum(map(len, lamps))} RedPower shaped-lamp surfaces')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, default=DEFAULT_SOURCE)
    parser.add_argument('--output', type=Path, default=Path(__file__).resolve().parent.parent / 'generated' / 'models')
    args = parser.parse_args()
    extract(args.source, args.output)
