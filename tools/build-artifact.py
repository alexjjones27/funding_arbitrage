"""Builds one self-contained page (CSS, JS and an embedded snapshot inlined) for hosts that block
network requests, such as a claude.ai artifact.  Usage: python3 tools/build-artifact.py snapshot.json out.html"""
import re
import sys
from pathlib import Path

root = Path(__file__).resolve().parent.parent
snap = Path(sys.argv[1]).read_text()
out = Path(sys.argv[2])
html = (root / 'index.html').read_text()
css = (root / 'css' / 'styles.css').read_text()
# The host supplies the document skeleton and pads :root; fill the frame instead of the viewport.
css = css.replace('  height: 100vh;\n', '  height: 100%;\n') + '\nhtml { height: 100%; }\n'

head = re.search(r'<head>(.*?)</head>', html, re.S).group(1)
title = re.search(r'<title>.*?</title>', head).group(0)
body = re.search(r'<body>(.*?)</body>', html, re.S).group(1)
scripts = re.findall(r'<script src="(js/[^"]+)"></script>', body)
body = re.sub(r'\s*<script src="js/[^"]+"></script>', '', body)

def inline(js):
    return '<script>\n' + js.replace('</script', '<\\/script') + '\n</script>'

parts = [title, '<style>\n' + css + '</style>', body.strip(),
         '<script>window.FAS_SNAPSHOT = ' + snap.replace('</', '<\\/') + ';</script>']
parts += [inline((root / s).read_text()) for s in scripts]
out.write_text('\n'.join(parts) + '\n')
print(f'wrote {out}: {out.stat().st_size / 1e6:.1f} MB')
