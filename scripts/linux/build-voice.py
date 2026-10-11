"""Build the pinned CPU speech dependency closure into the private Python."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

REPO=Path(__file__).resolve().parents[2]
BASE=Path('/home/roman/JosiDrive/BuildTemp/josi-ce-native-linux-20261010')
CACHE=Path('/home/roman/JosiDrive/Caches/codex-linux-native-20261010')
PYTHON=BASE/'prefix/python/bin/python3'
SOURCE=BASE/'native-build';SYSROOT=BASE/'openblas-root';CT2=BASE/'prefix/ctranslate2'

def run(arguments,**kwargs):
    env={**os.environ,'TMPDIR':str(BASE/'tmp'),'PIP_CACHE_DIR':str(CACHE/'pip'),'CMAKE_BUILD_PARALLEL_LEVEL':str(min(os.cpu_count() or 4,8)),**kwargs.pop('env',{})}
    subprocess.run([str(value) for value in arguments],env=env,check=True,**kwargs)

def main():
    if os.uname().machine!='x86_64':raise ValueError('This acceptance build currently has an x86_64 Python/OpenBLAS lock')
    if not PYTHON.exists():raise ValueError('Run build-base.sh python first')
    portable=os.environ.get('JOSI_PORTABLE_BUILD')=='1'
    if not portable and not SYSROOT.exists():
        SYSROOT.mkdir(parents=True);run(['bsdtar','-xf',CACHE/'openblas-0.3.34-1-x86_64.pkg.tar.zst','-C',SYSROOT])
    if SOURCE.exists():shutil.rmtree(SOURCE)
    if CT2.exists():shutil.rmtree(CT2)
    native_sources=CACHE/'native-sources';native_sources.mkdir(parents=True,exist_ok=True)
    # prepare_native expects the lock-relative paths under one source root.
    run([PYTHON,REPO/'services/voice-box/prepare_native.py','--root',SOURCE,'--sources',native_sources,
         '--lock',REPO/'services/voice-box/sources.lock.json'])
    run([PYTHON,'-m','pip','install','--no-compile','--no-deps','--require-hashes','-r',REPO/'services/voice-box/requirements-build.lock'])
    build=SOURCE/'ctranslate2/build'
    cmake=['cmake','-S',SOURCE/'ctranslate2','-B',build,'-DCMAKE_BUILD_TYPE=Release','-DCMAKE_INSTALL_PREFIX='+str(CT2),
         '-DCMAKE_POLICY_VERSION_MINIMUM=3.5']
    if not portable:cmake.extend(['-DCMAKE_PREFIX_PATH='+str(SYSROOT/'usr'),'-DOPENBLAS_INCLUDE_DIR='+str(SYSROOT/'usr/include/openblas'),'-DOPENBLAS_LIBRARY='+str(SYSROOT/'usr/lib/libopenblas.so')])
    cmake.extend(['-DBUILD_CLI=OFF','-DBUILD_TESTS=OFF',
         '-DWITH_MKL=OFF','-DWITH_DNNL=OFF','-DWITH_CUDA=OFF','-DWITH_OPENBLAS=ON','-DWITH_RUY=ON',
         '-DRUY_BUILD_TESTS=OFF','-DRUY_BUILD_BENCHMARKS=OFF','-DOPENMP_RUNTIME=COMP'])
    run(cmake)
    run(['cmake','--build',build,'--parallel',str(min(os.cpu_count() or 4,8))]);run(['cmake','--install',build])
    wheels=BASE/'wheels';wheels.mkdir(exist_ok=True)
    run([PYTHON,'-m','pip','wheel','--no-deps','--no-build-isolation','--wheel-dir',wheels,SOURCE/'ctranslate2/python'],
        env={**os.environ,'CC':'gcc','CXX':'g++','LDSHARED':'gcc -shared','CTRANSLATE2_ROOT':str(CT2),'TMPDIR':str(BASE/'tmp'),'PIP_CACHE_DIR':str(CACHE/'pip')})
    run([PYTHON,'-m','pip','install','--no-cache-dir','--no-compile','--no-build-isolation','--no-deps','--require-hashes',
         '-r',REPO/'services/voice-box/requirements.lock'])
    wheel=next(wheels.glob('ctranslate2-*.whl'));run([PYTHON,'-m','pip','install','--force-reinstall','--no-deps',wheel])
    run([PYTHON,REPO/'services/voice-box/patch_whisper.py'])
    library=BASE/'prefix/python/lib/libopenblas.so.0';library.parent.mkdir(parents=True,exist_ok=True)
    openblas=Path('/usr/lib/x86_64-linux-gnu/openblas-pthread/libopenblas.so.0') if portable else SYSROOT/'usr/lib/libopenblas.so.0'
    shutil.copy2(openblas,library)
    if portable:
        for name in ('libgfortran.so.5','libquadmath.so.0','libgomp.so.1'):
            shutil.copy2(Path('/usr/lib/x86_64-linux-gnu')/name,library.parent/name)
    for shared in (CT2/'lib').glob('libctranslate2.so*'):shutil.copy2(shared,library.parent/shared.name)
    run([PYTHON,'-m','pip','check'])
    run([PYTHON,'-c','import ctranslate2,numpy,onnxruntime; print(ctranslate2.__version__,numpy.__version__,onnxruntime.__version__)'],
        env={'LD_LIBRARY_PATH':str(library.parent)})

if __name__=='__main__':main()
