"""Pin Electron build scripts/patches and its Chromium FFmpeg revision.
Only source bytes are acquired; nothing is built, installed or executed.
"""
import base64
import hashlib
import json
from pathlib import Path
import re
import sys
import subprocess

CACHE=Path('/Volumes/JosiOS/JosiDrive/Caches/codex-macos-native-20261009/desktop-source-closure')

def fetch(url,path):
    if path.exists():return path.read_bytes()
    subprocess.run(['/usr/bin/curl','--fail','--silent','--show-error','--location','--connect-timeout','20','--max-time','180',url,'-o',str(path)],check=True)
    return path.read_bytes()

out=Path(sys.argv[1])
if not str(out).startswith('/Volumes/JosiOS/JosiDrive/Artifacts/josi-ce-native-macos-arm64-20261009/pkg-candidate-'):raise ValueError('External candidate required')
folder=out/'client-source-closure';folder.mkdir()
deps=fetch('https://raw.githubusercontent.com/electron/electron/v43.2.0/DEPS',folder/'electron-DEPS.txt').decode()
chromium=re.search(r"'chromium_version':\s*'([^']+)'",deps).group(1)
chrome_url='https://chromium.googlesource.com/chromium/src/+/refs/tags/'+chromium+'/DEPS?format=TEXT'
chrome=base64.b64decode(fetch(chrome_url,folder/'chromium-DEPS.base64')).decode()
(folder/'chromium-DEPS.txt').write_text(chrome)
revision=re.search(r"'ffmpeg_revision':\s*'([a-f0-9]{40})'",chrome).group(1)
artifacts=[('electron-v43.2.0.tar.gz','https://codeload.github.com/electron/electron/tar.gz/refs/tags/v43.2.0'),('ffmpeg-'+revision+'.tar.gz','https://chromium.googlesource.com/chromium/third_party/ffmpeg/+archive/'+revision+'.tar.gz')]
records=[]
lock=json.loads((Path(__file__).resolve().parents[2]/'packaging/macos/desktop-sources.lock.json').read_text())
if lock['chromium']!=chromium or lock['ffmpegRevision']!=revision:raise ValueError('Desktop dependency pin changed')
for name,url in artifacts:
    print('Acquiring source '+name,flush=True)
    if (CACHE/name).is_file():
        data=(CACHE/name).read_bytes()
        with (folder/name).open('xb') as stream:stream.write(data)
    else:data=fetch(url,folder/name)
    value={'filename':name,'url':url,'sha256':hashlib.sha256(data).hexdigest(),'size':len(data)}
    if value!=next(x for x in lock['files'] if x['filename']==name):raise ValueError('Desktop corresponding-source hash mismatch')
    records.append(value)
(folder/'source-lock.json').write_text(json.dumps({'electron':'43.2.0','chromium':chromium,'ffmpegRevision':revision,'files':records},indent=2)+'\n')
(folder/'REBUILD.txt').write_text('Electron 43.2.0 source archive includes build scripts and patches. Its DEPS pins Chromium '+chromium+'; Chromium DEPS pins FFmpeg '+revision+'.\nThe desktop client links libffmpeg.dylib separately in Electron Framework.framework/Versions/A/Libraries. The FFmpeg source archive includes Chromium build configurations. Use Electron’s source/build instructions and patches when rebuilding that library. A locally modified desktop app can require local re-signing before macOS opens it. No SOCAL private key is included or required to build source. Josi Server is a separate application.\n')
print(json.dumps({'sourceClosure':str(folder),'ffmpegRevision':revision}),flush=True)
