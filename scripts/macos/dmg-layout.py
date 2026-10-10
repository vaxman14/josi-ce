"""Finder presentation, using build-only ds_store/mac_alias libraries.
The image is mounted inside the exclusive external candidate directory.
"""
import json
from pathlib import Path
import sys
sys.path.insert(0,str(Path(sys.argv[1])/'build-tools'))
from ds_store import DSStore
from mac_alias import Alias

out=Path(sys.argv[1]);mount=Path(sys.argv[2])
if mount!=out/'dmg-mount' or not str(out).startswith('/Volumes/JosiOS/JosiDrive/Artifacts/'):raise ValueError('Unexpected image location')
background=mount/'.background/background.png'
alias=Alias.for_file(str(background)).to_bytes()
with DSStore.open(str(mount/'.DS_Store'),'w+') as store:
    store['.']['vstl']=('type',b'icnv')
    store['.']['bwsp']={'ShowStatusBar':False,'ShowToolbar':False,'ShowPathbar':False,'ShowSidebar':False,'ContainerShowSidebar':False,'WindowBounds':'{{200, 160}, {720, 440}}'}
    store['.']['icvp']={'viewOptionsVersion':1,'backgroundType':2,'backgroundImageAlias':alias,'iconSize':80.0,'textSize':13.0,'labelOnBottom':True,'arrangeBy':'none','showIconPreview':True,'showItemInfo':False,'gridSpacing':100.0,'gridOffsetX':0.0,'gridOffsetY':0.0,'scrollPositionX':0.0,'scrollPositionY':0.0}
    for name,position in [('Install Josi.pkg',(170,220)),('TEST-ME.txt',(365,220)),('Josi-corresponding-sources.zip',(555,220))]:
        store[name]['Iloc']=position
with DSStore.open(str(mount/'.DS_Store'),'r') as store:
    assert store['.']['icvp']['backgroundType']==2
    assert store['Install Josi.pkg']['Iloc']==(170,220)
print(json.dumps({'backgroundConfigured':True,'packageIconPositioned':True,'dragToApplications':False}))
