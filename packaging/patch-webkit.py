#!/usr/bin/env python3
# Redirige les chemins libexec/injected-bundle codés en dur dans libwebkit2gtk
# vers un chemin fixe (/tmp/.drssh-wk) que l'AppRun relie à l'AppDir au lancement.
# WebKitGTK >= 2.46 n'offre plus de variable d'environnement pour ce chemin :
# on patche donc la chaîne dans la lib (longueur préservée, complétée par des NUL).
import sys

path = sys.argv[1]
with open(path, "rb") as f:
    data = f.read()

repls = [
    (b"/usr/lib/x86_64-linux-gnu/webkit2gtk-4.1/injected-bundle/",
     b"/tmp/.drssh-wk/webkit2gtk-4.1/injected-bundle/"),
    (b"/usr/lib/x86_64-linux-gnu/webkit2gtk-4.1",
     b"/tmp/.drssh-wk/webkit2gtk-4.1"),
]

total = 0
for old, new in repls:
    assert len(new) <= len(old), (len(new), len(old))
    padded = new + b"\x00" * (len(old) - len(new))
    count = data.count(old)
    data = data.replace(old, padded)
    total += count
    print(f"  {old.decode()!r} -> {new.decode()!r} x{count}")

with open(path, "wb") as f:
    f.write(data)
print(f"patch-webkit: {total} remplacement(s)")
