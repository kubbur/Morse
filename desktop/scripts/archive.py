"""Make a Mac-compatible zip, retaining executable modes and framework symlinks."""
import os
import stat
import sys
import zipfile
from pathlib import Path

source, destination = Path(sys.argv[1]), Path(sys.argv[2])
with zipfile.ZipFile(destination, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
    for directory, names, files in os.walk(source, followlinks=False):
        names.sort()
        files.sort()
        for name in names + files:
            path = Path(directory) / name
            relative = path.relative_to(source).as_posix()
            mode = path.lstat().st_mode
            if stat.S_ISLNK(mode):
                info = zipfile.ZipInfo(relative)
                info.create_system = 3
                info.external_attr = mode << 16
                archive.writestr(info, os.readlink(path))
            elif path.is_file():
                archive.write(path, relative)
    if len(sys.argv) > 3:
        archive.write(sys.argv[3], 'INSTALL.txt')
