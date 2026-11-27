"""Check the delivered archives, including Mac executable modes and symlinks."""
import base64
import hashlib
import json
import os
import plistlib
import posixpath
import stat
import struct
import sys
import zipfile
from pathlib import Path, PurePosixPath

archive_path, architecture, version = sys.argv[1:]


def allows_jit(binary):
    offset = 32
    for _ in range(struct.unpack_from('<I', binary, 16)[0]):
        command, size = struct.unpack_from('<II', binary, offset)
        if command == 0x1D:
            start, _ = struct.unpack_from('<II', binary, offset + 8)
            for index in range(struct.unpack_from('>I', binary, start + 8)[0]):
                slot, blob_offset = struct.unpack_from('>II', binary, start + 12 + index * 8)
                if slot == 5:
                    _, length = struct.unpack_from('>II', binary, start + blob_offset)
                    entitlements = plistlib.loads(binary[start + blob_offset + 8:start + blob_offset + length])
                    return entitlements.get('com.apple.security.cs.allow-jit') is True
        offset += size
    return False


with zipfile.ZipFile(archive_path) as archive:
    names = archive.namelist()
    assert len(names) == len(set(names)), 'Duplicate archive entries'
    for name in names:
        path = PurePosixPath(name)
        assert not path.is_absolute() and '..' not in path.parts, 'Unsafe archive path'
        assert not any(part in {'.git', 'node_modules', '.env', '.DS_Store'} for part in path.parts), 'Private or generated files'
        assert path.suffix not in {'.sqlite', '.db', '.p12', '.p8', '.mobileprovision', '.log'}, 'Data or credentials in archive'
    if architecture == 'source':
        expected = {'Source', 'package.json', 'package-lock.json', '.gitignore', '.github', 'README.md', 'RELEASE.md', 'INSTALL.txt', 'src', 'assets', 'scripts', 'tests', 'website', 'website-manifest.json'}
        assert {PurePosixPath(name).parts[0] for name in names} == {'Morse'}
        assert {PurePosixPath(name).parts[1] for name in names} == expected
        assert not any(stat.S_ISLNK(item.external_attr >> 16) for item in archive.infolist())
        result = {'kind': 'source', 'files': len(names), 'contents': 'source, tests, notices and build workflow only'}
    else:
        product = 'Morse Dev' if '-dev.' in version else 'Morse'
        bundle = product + '.app'
        bundle_id = 'digital.kubbur.morse.dev' if '-dev.' in version else 'digital.kubbur.morse'
        assert {PurePosixPath(name).parts[0] for name in names} == {bundle, 'INSTALL.txt'}
        prefix = bundle + '/Contents/'
        info = plistlib.loads(archive.read(prefix + 'Info.plist'))
        assert info['CFBundleIdentifier'] == bundle_id
        assert info['CFBundleName'] == info['CFBundleDisplayName'] == product
        assert info['CFBundleShortVersionString'] == version
        assert info['CFBundleExecutable'] == product
        binary_name = prefix + 'MacOS/' + product
        assert archive.getinfo(binary_name).external_attr >> 16 & stat.S_IXUSR, 'Executable bit lost'
        binary = archive.read(binary_name)
        magic, cpu = struct.unpack_from('<II', binary)
        assert magic == 0xFEEDFACF and cpu == {'arm64': 0x0100000C, 'x64': 0x01000007}[architecture], 'Wrong Mac architecture'
        signatures = 0
        ncmds = struct.unpack_from('<I', binary, 16)[0]
        offset = 32
        for _ in range(ncmds):
            command, size = struct.unpack_from('<II', binary, offset)
            if command == 0x1D:
                data_offset, data_size = struct.unpack_from('<II', binary, offset + 8)
                assert data_size > 0 and data_offset + data_size <= len(binary)
                signature = binary[data_offset:data_offset + data_size]
                magic, length, count = struct.unpack_from('>III', signature)
                assert magic == 0xFADE0CC0 and length <= len(signature)
                code_directories = 0
                jit_allowed = False
                for index in range(count):
                    slot, directory_offset = struct.unpack_from('>II', signature, 12 + index * 8)
                    if slot == 5:
                        _, entitlement_length = struct.unpack_from('>II', signature, directory_offset)
                        entitlements = plistlib.loads(signature[directory_offset + 8:directory_offset + entitlement_length])
                        jit_allowed = entitlements.get('com.apple.security.cs.allow-jit') is True
                    if slot != 0: continue
                    code_directories += 1
                    values = struct.unpack_from('>9I4B', signature, directory_offset)
                    directory_magic, directory_length, _, _, hash_offset, _, _, pages, code_limit, hash_size, hash_type, _, page_power = values
                    assert directory_magic == 0xFADE0C02
                    assert hash_type in {1, 2, 3, 4}, 'Unknown code signature digest'
                    digest = {1: hashlib.sha1, 2: hashlib.sha256, 3: hashlib.sha256, 4: hashlib.sha384}[hash_type]
                    page_size = 1 << page_power
                    assert pages == (code_limit + page_size - 1) // page_size
                    directory = signature[directory_offset:directory_offset + directory_length]
                    for page in range(pages):
                        expected = directory[hash_offset + page * hash_size:hash_offset + (page + 1) * hash_size]
                        assert digest(binary[page * page_size:min((page + 1) * page_size, code_limit)]).digest()[:hash_size] == expected, 'Executable signature does not match code'
                assert code_directories == 1
                assert jit_allowed, 'Electron JIT entitlement missing'
                signatures += 1
            offset += size
        assert signatures == 1, 'Mac code signature missing'
        symlinks = [item for item in archive.infolist() if stat.S_ISLNK(item.external_attr >> 16)]
        assert symlinks, 'Framework symlinks lost'
        links = {item.filename: archive.read(item).decode() for item in symlinks}
        for item in symlinks:
            target = PurePosixPath(links[item.filename])
            assert not target.is_absolute(), 'Absolute framework symlink'
            destination = posixpath.normpath(posixpath.join(posixpath.dirname(item.filename), str(target)))
            # Framework links often traverse Versions/Current, itself a link.
            for _ in range(40):
                parts = PurePosixPath(destination).parts
                assert parts[0] == bundle, 'Framework symlink escapes app'
                for length in range(1, len(parts) + 1):
                    prefix_path = '/'.join(parts[:length])
                    if prefix_path in links:
                        assert not PurePosixPath(links[prefix_path]).is_absolute()
                        destination = posixpath.normpath(posixpath.join(posixpath.dirname(prefix_path), links[prefix_path], *parts[length:]))
                        break
                else: break
            else: raise AssertionError('Cyclic framework symlink')
            assert destination in names or any(name.startswith(destination + '/') for name in names), 'Broken framework symlink'
        assert archive.read(prefix + 'Resources/' + info['CFBundleIconFile']).startswith(b'icns')
        for suffix in ['', ' (Renderer)', ' (GPU)', ' (Plugin)']:
            helper = product + ' Helper' + suffix
            helper_info = plistlib.loads(archive.read(prefix + f'Frameworks/{helper}.app/Contents/Info.plist'))
            assert helper_info['CFBundleIdentifier'] == bundle_id + '.helper'
            helper_name = prefix + f'Frameworks/{helper}.app/Contents/MacOS/{helper}'
            assert archive.getinfo(helper_name).external_attr >> 16 & stat.S_IXUSR
            assert allows_jit(archive.read(helper_name)), 'Electron helper JIT entitlement missing'
        helper = prefix + 'Helpers/MorseKeyer'
        assert info.get('NSMicrophoneUsageDescription') and archive.getinfo(helper).external_attr >> 16 & stat.S_IXUSR
        assert struct.unpack_from('<II',archive.read(helper)) == (0xFEEDFACF,cpu), 'Wrong native paddle architecture'
        assert prefix + '_CodeSignature/CodeResources' in names
        assert prefix + 'Resources/LICENSE.electron.txt' in names
        assert prefix + 'Resources/LICENSES.chromium.html' in names
        result = {'kind': 'app', 'architecture': architecture, 'minimumMacOS': info['LSMinimumSystemVersion'], 'files': len(names), 'frameworkSymlinks': len(symlinks), 'asarSha256': hashlib.sha256(archive.read(prefix + 'Resources/app.asar')).hexdigest(), 'asarHeader': info['ElectronAsarIntegrity']['Resources/app.asar']}
        parts = version.split('.')
        stable = len(parts) == 3 and all(p.isdecimal() for p in parts) and tuple(map(int, parts)) >= (1, 1, 1)
        dev_key = os.environ.get('MORSE_UPDATE_PUBLIC_KEY_FILE') if '-dev.' in version else None
        if stable or dev_key:
            key_path = Path(dev_key) if dev_key else Path(__file__).resolve().parents[1] / 'assets/sparkle-public-key.txt'
            public = key_path.read_text().strip()
            assert info['SUPublicEDKey'] == public and len(base64.b64decode(public, validate=True)) == 32
            feed = 'https://github.com/kubbur/Morse/releases/latest/download/appcast-mac-' + architecture + '.xml'
            assert info['SUFeedURL'] == feed and info['SUVerifyUpdateBeforeExtraction'] is True
            addon = archive.read(prefix + 'Resources/MorseUpdater.node')
            assert struct.unpack_from('<II', addon) == (0xFEEDFACF, cpu), 'Wrong Sparkle module architecture'
            assert prefix + 'Frameworks/Sparkle.framework/Sparkle' in names
            assert prefix + 'Resources/LICENSE.sparkle.txt' in names
            result['sparkleFeed'] = feed
    assert archive.testzip() is None, 'Damaged archive'
print(json.dumps(result))
