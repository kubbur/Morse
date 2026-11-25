"""Build a reviewable website update from trainer source and the deployed Docker build files."""
import sys
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile
import hashlib
import json

root = Path(__file__).resolve().parents[1]
deployed = Path(sys.argv[1])
version = json.loads((root / "package.json").read_text())["version"]
output = root / "dist" / f"Morse-{version}-web.zip"
files = {name: deployed / name for name in ("Dockerfile", "package.json", "package-lock.json")}
files["docs/THIRD-PARTY-LICENSES.md"] = root / "website/THIRD-PARTY-LICENSES.md"
files["server.mjs"] = root / "website/server.mjs"
files["scripts/backup.mjs"] = root / "scripts/backup.mjs"
manifest = json.loads((root / "website-manifest.json").read_text())
for name, expected in manifest.items():
    path = root / "website" / name
    if path.is_symlink() or hashlib.sha256(path.read_bytes()).hexdigest() != expected:
        raise ValueError(f"Website source differs from the reviewed manifest: {name}")
    if name.startswith(("public/", "lib/")):
        files[name] = path
for path in files.values():
    if not path.is_file():
        raise ValueError(f"Missing build input: {path}")
output.parent.mkdir(exist_ok=True)
with ZipFile(output.with_suffix(".partial"), "w", compression=ZIP_DEFLATED) as bundle:
    for name, path in sorted(files.items()):
        bundle.write(path, "Morse-web/" + name)
output.with_suffix(".partial").replace(output)
print(output.name)
