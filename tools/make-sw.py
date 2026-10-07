#!/usr/bin/env python3
"""יוצר את sw.js עם רשימת הקבצים לשמירה במטמון. להריץ מתיקיית הפרויקט אחרי שינוי קבצים:  python3 tools/make-sw.py"""
import os, re, sys
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
version = sys.argv[1] if len(sys.argv) > 1 else '1.0.0'
open(os.path.join(root, 'js', 'version.js'), 'w').write("export const APP_VERSION = '%s';\n" % version)
core, extra = ['./', 'index.html', 'manifest.webmanifest'], []
for base, _, files in os.walk(root):
    for f in sorted(files):
        p = os.path.relpath(os.path.join(base, f), root).replace(os.sep, '/')
        if p.startswith('tools/') or p in ('sw.js', 'README.md', 'index.html', 'manifest.webmanifest') or p.startswith('lib/ocr/') or p.endswith('.map') or f.startswith('.'):
            continue
        if p.startswith('lib/pdfjs/standard_fonts/') or p.startswith('lib/pdfjs/wasm/') or p.startswith('lib/pdfjs/iccs/'):
            extra.append(p)
        else:
            core.append(p)
core.sort(); extra.sort()
tpl = open(os.path.join(root, 'tools', 'sw.template.js'), encoding='utf-8').read()
out = tpl.replace('__VERSION__', version).replace('__CORE__', ',\n  '.join(repr(x).replace("'", '"') for x in core)).replace('__EXTRA__', ',\n  '.join(repr(x).replace("'", '"') for x in extra))
open(os.path.join(root, 'sw.js'), 'w', encoding='utf-8').write(out)
print('sw.js נוצר:', len(core), 'קבצי ליבה,', len(extra), 'קבצים נוספים, גרסה', version)
