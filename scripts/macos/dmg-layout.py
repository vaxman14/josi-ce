"""Finder presentation, using build-only ds_store/mac_alias libraries.
The image is mounted inside the exclusive external candidate directory.
"""
import json
import plistlib
from pathlib import Path
import subprocess
import sys
sys.path.insert(0,str(Path(sys.argv[1])/'build-tools'))
from ds_store import DSStore
from mac_alias import Alias, Bookmark

out=Path(sys.argv[1]);mount=Path(sys.argv[2])
if not str(out).startswith('/Volumes/JosiOS/JosiDrive/Artifacts/'):raise ValueError('Unexpected image location')
if sys.argv[3:]==['--standard-mount']:
    images=plistlib.loads(subprocess.check_output(['/usr/bin/hdiutil','info','-plist']))['images']
    if mount.parent!=Path('/Volumes') or not any(Path(x['image-path']).parent==out and Path(x['image-path']).name.startswith('Josi-Server-layout') and any(e.get('mount-point')==str(mount) for e in x['system-entities']) for x in images):raise ValueError('Mount is not the candidate image')
elif sys.argv[3:] or mount!=out/'dmg-mount':raise ValueError('Unexpected image location')
background=mount/'.background/background.png'
alias=Alias.for_file(str(background)).to_bytes()
with DSStore.open(str(mount/'.DS_Store'),'w+') as store:
    store['.']['vSrn']=('long',1)
    store['.']['icvl']=('type',b'icnv')
    store['.']['vstl']=('type',b'icnv')
    store['.']['pBBk']=Bookmark.for_file(str(background))
    store['.']['bwsp']={'ShowStatusBar':False,'ShowTabView':False,'ShowToolbar':False,'ShowPathbar':False,'ShowSidebar':False,'ContainerShowSidebar':False,'PreviewPaneVisibility':False,'SidebarWidth':0,'WindowBounds':'{{200, 160}, {720, 440}}'}
    store['.']['icvp']={'viewOptionsVersion':1,'backgroundType':2,'backgroundColorRed':1.0,'backgroundColorGreen':1.0,'backgroundColorBlue':1.0,'backgroundImageAlias':alias,'iconSize':80.0,'textSize':13.0,'labelOnBottom':True,'arrangeBy':'none','showIconPreview':True,'showItemInfo':False,'gridSpacing':100.0,'gridOffsetX':0.0,'gridOffsetY':0.0,'scrollPositionX':0.0,'scrollPositionY':0.0}
    for name,position in [('Install Josi.pkg',(170,220)),('TEST-ME.txt',(365,220)),('Licenses and Sources',(555,220))]:
        store[name]['Iloc']=position
with DSStore.open(str(mount/'.DS_Store'),'r') as store:
    assert store['.']['icvp']['backgroundType']==2
    assert store['.']['icvl'][1]==b'icnv'
    assert store['Install Josi.pkg']['Iloc']==(170,220)
print(json.dumps({'backgroundConfigured':True,'packageIconPositioned':True,'dragToApplications':False}))
