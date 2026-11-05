"""Read the Merabetta column-based workbook using only Python's standard library.
Writes JSON to stdout, never extracts arbitrary ZIP paths or modifies the workbook.
"""
import base64
import hashlib
import json
import posixpath
import re
import sys
import zipfile
import xml.etree.ElementTree as ET

S = '{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'
R = '{http://schemas.openxmlformats.org/officeDocument/2006/relationships}'
D = '{http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing}'
A = '{http://schemas.openxmlformats.org/drawingml/2006/main}'


def extract(filename):
    with zipfile.ZipFile(filename) as archive:
        if sum(item.file_size for item in archive.infolist()) > 25 * 1024 * 1024:
            raise ValueError('Workbook expands beyond 25 MiB')
        def xml(name):
            payload = archive.read(name)
            if b'<!DOCTYPE' in payload or b'<!ENTITY' in payload:
                raise ValueError('XML entity declarations are not supported')
            return ET.fromstring(payload)
        def relationships(source):
            folder, name = posixpath.split(source)
            relfile = posixpath.join(folder, '_rels', name + '.rels')
            if relfile not in archive.namelist():
                return {}
            result = {}
            for item in xml(relfile):
                if item.get('TargetMode') == 'External':
                    continue
                target = item.get('Target', '')
                resolved = posixpath.normpath(target.lstrip('/') if target.startswith('/') else posixpath.join(folder, target))
                if not resolved.startswith('xl/') or resolved not in archive.namelist():
                    raise ValueError('Invalid workbook relationship')
                result[item.get('Id')] = resolved
            return result
        strings = []
        if 'xl/sharedStrings.xml' in archive.namelist():
            strings = [''.join(t.text or '' for t in item.iter(S + 't')) for item in xml('xl/sharedStrings.xml')]
        book = xml('xl/workbook.xml')
        sheets = book.find(S + 'sheets')
        if sheets is None or len(sheets) != 1:
            raise ValueError('Expected exactly one category worksheet')
        sheet = sheets[0]
        sheetfile = relationships('xl/workbook.xml')[sheet.get(R + 'id')]
        worksheet = xml(sheetfile)
        cells = {}
        for cell in worksheet.iter(S + 'c'):
            if cell.find(S + 'f') is not None:
                raise ValueError('Formula cells must be converted to literal values before import')
            value = cell.find(S + 'v')
            text = value.text or '' if value is not None else ''
            if cell.get('t') == 's':
                text = strings[int(text)]
            elif cell.get('t') == 'inlineStr':
                text = ''.join(t.text or '' for t in cell.iter(S + 't'))
            if text.strip():
                cells[cell.get('r')] = re.sub(r'\s+', ' ', text).strip()
        drawing = worksheet.find(S + 'drawing')
        if drawing is None:
            raise ValueError('No embedded category images found')
        drawingfile = relationships(sheetfile)[drawing.get(R + 'id')]
        media = relationships(drawingfile)
        images = {}
        for anchor in xml(drawingfile):
            start = anchor.find(D + 'from')
            blip = anchor.find('.//' + A + 'blip')
            if start is None or blip is None:
                raise ValueError('Unsupported image anchor')
            col = int(start.find(D + 'col').text)
            if col > 25 or int(start.find(D + 'row').text) != 0 or col in images:
                raise ValueError('Expected one category image per column in row 1')
            key = media[blip.get(R + 'embed')]
            payload = archive.read(key)
            images[col] = (key, payload)
        categories = []
        warnings = []
        for col, (mediafile, payload) in sorted(images.items()):
            letter = chr(65 + col)
            header = letter + '3'
            name = cells.get(header)
            if not name or name.startswith(('https://', 'http://')):
                raise ValueError('Missing category heading at ' + header)
            children = []
            for ref, value in cells.items():
                if re.fullmatch(letter + r'\d+', ref) and int(ref[len(letter):]) >= 4:
                    children.append({'name': value, 'cell': ref})
            children.sort(key=lambda item: int(item['cell'][len(letter):]))
            for item in children:
                if re.match(r'Class [ABCD] \(', item['name']):
                    warnings.append({'code': 'REVIEW_PLACEMENT', 'category': name, **item,
                                     'message': 'Medical-device risk classification appears under Food; retained as written.'})
            slug = re.sub(r'[^a-z0-9]+', '-', name.lower()).strip('-')
            extension = posixpath.splitext(mediafile)[1].lower()
            if extension not in ('.png', '.jpeg', '.jpg', '.webp'):
                raise ValueError('Unsupported image format')
            categories.append({'name': name, 'cell': header, 'image_file': 'assets/' + slug + extension,
                               'image_base64': base64.b64encode(payload).decode(),
                               'image_sha256': hashlib.sha256(payload).hexdigest(),
                               'media_file': mediafile, 'subcategories': children})
        ignored = [{'cell': ref, 'value': value} for ref, value in cells.items()
                   if re.match(r'^[I-Z]', ref)]
        return {'source': posixpath.basename(filename), 'sheet': sheet.get('name'),
                'source_sha256': hashlib.sha256(open(filename, 'rb').read()).hexdigest(),
                'layout': 'category headings row 3; subcategories row 4 onward; embedded images row 1',
                'categories': categories, 'warnings': warnings, 'non_catalog_cells': ignored}


if __name__ == '__main__':
    try:
        print(json.dumps(extract(sys.argv[1]), ensure_ascii=False))
    except (ValueError, KeyError, IndexError, ET.ParseError, zipfile.BadZipFile, OSError) as error:
        print('Category workbook extraction failed: ' + str(error), file=sys.stderr)
        sys.exit(1)
