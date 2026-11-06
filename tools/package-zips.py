from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED

root = Path(__file__).resolve().parents[1]
outdir = root.parent
packages = [
    (outdir / "otto-chrome-extension-v0.3.0.zip", [root / "extension"]),
    (outdir / "otto-chrome-bridge-source-v0.3.0.zip", [
        root / "README.md", root / "LICENSE", root / "bridge", root / "extension",
        root / "install.sh", root / "test", root / "tools"
    ])
]
for archive, items in packages:
    with ZipFile(archive, "w", ZIP_DEFLATED) as z:
        for item in items:
            if not item.exists():
                continue
            paths = [item] if item.is_file() else item.rglob("*")
            for path in paths:
                if not path.is_file() or ".git" in path.parts or "node_modules" in path.parts:
                    continue
                z.write(path, path.relative_to(root.parent))
    print(f"{archive.name}: {archive.stat().st_size} bytes")
