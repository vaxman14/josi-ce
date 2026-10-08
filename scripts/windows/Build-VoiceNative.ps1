[CmdletBinding()]
param([string]$VisualStudio = 'C:\Program Files\Microsoft Visual Studio\18\Community', [switch]$UseLocalSupplement)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repo = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$base = Join-Path $repo 'artifacts\windows-native'
$pythonRoot = Join-Path $base 'tools\python-3.12.15\python'
$python = Join-Path $pythonRoot 'python.exe'
$cmake = Join-Path $pythonRoot 'Lib\site-packages\cmake\data\bin\cmake.exe'
$ninja = Join-Path $pythonRoot 'Scripts\ninja.exe'
$source = Join-Path $base 'staging\voice-native\ctranslate2'
$build = Join-Path $base 'staging\voice-native\build'
$prefix = Join-Path $base 'tools\ctranslate2-cpu'
$patch=Join-Path $repo 'services\voice-box\ctranslate2-windows-shutdown.patch'
if((Get-FileHash -LiteralPath $patch -Algorithm SHA256).Hash.ToLowerInvariant() -cne 'c523d2157bde1814db0ce3bb3d09296d51e47e3dcf7008f6242ead11b9957a0c'){
    throw 'The reviewed upstream Windows shutdown patch changed'
}
# Backport only the three native source files from upstream commit 639afb3c.
# Git is a build input only; the distributed runtime never invokes it.
$relative='artifacts/windows-native/staging/voice-native/ctranslate2'
$patchArgs=@('apply',"--directory=$relative","--include=$relative/src/cpu/backend.cc","--include=$relative/src/cpu/backend.h","--include=$relative/src/devices.cc")
Push-Location $repo
try {
    & git @patchArgs --check --reverse $patch 2>$null
    if($LASTEXITCODE){
        & git @patchArgs --check $patch
        if($LASTEXITCODE){throw 'Pinned CPU source does not match the reviewed shutdown backport'}
        & git @patchArgs $patch
        if($LASTEXITCODE){throw 'Windows CPU shutdown backport failed'}
    }
} finally {Pop-Location}
$versionFile=Join-Path $source 'python\ctranslate2\version.py'
$versionText=[IO.File]::ReadAllText($versionFile)
if($versionText -notmatch '4\.8\.2\+josi\.windows[12]'){throw 'Unexpected Windows CPU source version'}
[IO.File]::WriteAllText($versionFile,$versionText.Replace('4.8.2+josi.windows1','4.8.2+josi.windows2'),[Text.UTF8Encoding]::new($false))
$env:TEMP = Join-Path $base 'cache'
$env:TMP = $env:TEMP
$env:PIP_CACHE_DIR = Join-Path $base 'cache\pip'
$env:CMAKE_BUILD_PARALLEL_LEVEL = '4'
$env:CTRANSLATE2_ROOT = $prefix
$env:CL='/utf-8'
$compilerOptions=@()
if($UseLocalSupplement){
    # Complete this machine's existing licensed compiler with official pinned
    # header/library packages in the workspace; no elevated installer is needed.
    $supplement=Join-Path $base 'tools\msvc-supplement'
    $vc=Join-Path $VisualStudio 'VC\Tools\MSVC\14.50.35717'
    $compiler=Join-Path $vc 'bin\Hostx64\x64'
    $headers=Join-Path $supplement 'Microsoft.VC.14.50.18.0.CRT.Headers.base\Contents\VC\Tools\MSVC\14.50.35717\include'
    $libraries=Join-Path $supplement 'Microsoft.VC.14.50.18.0.CRT.x64.Desktop.base\Contents\VC\Tools\MSVC\14.50.35717\lib\x64'
    $sdk='C:\Program Files (x86)\Windows Kits\10'
    $sdkVersion='10.0.19041.0'
    foreach($file in @((Join-Path $compiler 'cl.exe'),(Join-Path $headers 'crtdefs.h'),(Join-Path $libraries 'libcmt.lib'),(Join-Path $sdk "Include\$sdkVersion\um\Windows.h"))){
        if(!(Test-Path -LiteralPath $file)){throw 'The pinned local compiler supplement is incomplete'}
    }
    if((Get-AuthenticodeSignature -LiteralPath (Join-Path $compiler 'cl.exe')).Status -ne 'Valid'){throw 'Microsoft compiler signature is invalid'}
    $env:PATH=@($compiler,(Join-Path $sdk "bin\$sdkVersion\x64"),(Split-Path $cmake),(Split-Path $ninja),$pythonRoot,(Join-Path $env:SystemRoot 'System32')) -join ';'
    $env:INCLUDE=@($headers,(Join-Path $sdk "Include\$sdkVersion\ucrt"),(Join-Path $sdk "Include\$sdkVersion\shared"),(Join-Path $sdk "Include\$sdkVersion\um"),(Join-Path $sdk "Include\$sdkVersion\winrt")) -join ';'
    $env:LIB=@($libraries,(Join-Path $vc 'lib\onecore\x64'),(Join-Path $sdk "Lib\$sdkVersion\ucrt\x64"),(Join-Path $sdk "Lib\$sdkVersion\um\x64")) -join ';'
    $env:DISTUTILS_USE_SDK='1'; $env:MSSdk='1'; $env:VSCMD_ARG_TGT_ARCH='x64'; $env:VSCMD_ARG_HOST_ARCH='x64'
    $env:WindowsSdkDir=$sdk+'\'; $env:WindowsSDKVersion=$sdkVersion+'\'; $env:VCINSTALLDIR=(Join-Path $VisualStudio 'VC')+'\'
    $build=Join-Path $base 'staging\voice-native\build-local'
    $compilerOptions=@("-DCMAKE_C_COMPILER=$(Join-Path $compiler 'cl.exe')","-DCMAKE_CXX_COMPILER=$(Join-Path $compiler 'cl.exe')")
}else{
    # Reuse the installed Microsoft compiler; generated outputs stay in workspace.
    & (Join-Path $VisualStudio 'Common7\Tools\Launch-VsDevShell.ps1') -Arch amd64 -HostArch amd64 -SkipAutomaticLocation
}
& $cmake -S $source -B $build -G Ninja "-DCMAKE_MAKE_PROGRAM=$ninja" `
    '-DCMAKE_BUILD_TYPE=Release' "-DCMAKE_INSTALL_PREFIX=$prefix" `
    '-DCMAKE_C_FLAGS=/utf-8' '-DCMAKE_CXX_FLAGS=/utf-8' `
    '-DBUILD_CLI=OFF' '-DBUILD_TESTS=OFF' '-DWITH_MKL=OFF' '-DWITH_DNNL=OFF' `
    '-DWITH_CUDA=OFF' '-DWITH_OPENBLAS=OFF' '-DWITH_RUY=ON' `
    '-DRUY_BUILD_TESTS=OFF' '-DRUY_BUILD_BENCHMARKS=OFF' '-DOPENMP_RUNTIME=COMP' @compilerOptions
if ($LASTEXITCODE) { throw 'Native CPU configuration failed' }
& $cmake --build $build --parallel 4
if ($LASTEXITCODE) { throw 'Native CPU build failed' }
& $cmake --install $build
if ($LASTEXITCODE) { throw 'Native CPU staging failed' }
$dll = Join-Path $prefix 'bin\ctranslate2.dll'
if (!(Test-Path -LiteralPath $dll)) { throw 'Native engine DLL missing from install prefix' }
Copy-Item -LiteralPath $dll -Destination (Join-Path $source 'python\ctranslate2\ctranslate2.dll')
Push-Location (Join-Path $source 'python')
try {
    # Recompile the binding when build flags change, instead of reusing objects
    # from a prior wheel whose source timestamps happen to match.
    & $python setup.py build_ext --force
    if ($LASTEXITCODE) { throw 'Native Python binding build failed' }
} finally { Pop-Location }
& $python -m pip wheel --no-deps --no-build-isolation --wheel-dir (Join-Path $base 'staging\wheels') (Join-Path $source 'python')
if ($LASTEXITCODE) { throw 'Native Python wheel build failed' }
Get-ChildItem -LiteralPath (Join-Path $base 'staging\wheels') -Filter 'ctranslate2-*.whl' | Get-FileHash -Algorithm SHA256
