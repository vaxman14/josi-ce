# Developer-only native dependency spike. Not an installer or release lock.
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repo = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$base = Join-Path $repo 'artifacts\windows-native'
$cache = Join-Path $base 'cache'
$runtime = Join-Path $base 'tools\python-3.12.15'
$env:TEMP = $cache
$env:TMP = $cache
$env:PIP_CACHE_DIR = Join-Path $cache 'pip'
$env:PIP_DISABLE_PIP_VERSION_CHECK = '1'
$env:PYTHONDONTWRITEBYTECODE = '1'

function Get-VerifiedSpikeFile([string]$Url, [string]$Name, [long]$Size, [string]$Hash) {
    $target = Join-Path $cache $Name
    if (!(Test-Path -LiteralPath $target)) {
        Invoke-WebRequest -Uri $Url -OutFile ($target + '.partial') -TimeoutSec 180
        if ((Get-Item -LiteralPath ($target + '.partial')).Length -ne $Size -or
            (Get-FileHash -LiteralPath ($target + '.partial') -Algorithm SHA256).Hash -ne $Hash) {
            throw "Artifact verification failed: $Name"
        }
        Move-Item -LiteralPath ($target + '.partial') -Destination $target
    }
    if ((Get-Item -LiteralPath $target).Length -ne $Size -or
        (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash -ne $Hash) {
        throw "Cached artifact verification failed: $Name"
    }
    return $target
}

New-Item -ItemType Directory -Path $cache, $runtime -Force | Out-Null
$pythonArchive = Get-VerifiedSpikeFile 'https://github.com/astral-sh/python-build-standalone/releases/download/20261003/cpython-3.12.15%2B20261003-x86_64-pc-windows-msvc-install_only.tar.gz' 'cpython-3.12.15-20261003-windows-x64.tar.gz' 46509797 '4b6f0beebbb695a0f3ea237b8c3eaa5bd424f47a7bc25b2fbe3a43390c770f08'
if (!(Test-Path -LiteralPath (Join-Path $runtime 'python\python.exe'))) {
    & tar.exe -xzf $pythonArchive -C $runtime
    if ($LASTEXITCODE) { throw 'Python archive extraction failed' }
}
$runtime = Join-Path $runtime 'python'
$python = Join-Path $runtime 'python.exe'
$pipWheel = Get-VerifiedSpikeFile 'https://files.pythonhosted.org/packages/62/36/a3aed958d60531cb442b7ab4596cda7b3621cfb916f8ae1d6769795c7dc1/pip-26.2-py3-none-any.whl' 'pip-26.2-py3-none-any.whl' 1816475 '931c303696af6fa3417112103b1cad26890e5a07eccb5b99783700e33f2b8aad'
if (!(Test-Path -LiteralPath (Join-Path $runtime 'Lib\site-packages\pip'))) {
    & $python -c 'import sys,zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])' $pipWheel (Join-Path $runtime 'Lib\site-packages')
    if ($LASTEXITCODE) { throw 'pip bootstrap failed' }
}
& $python -m pip install --no-deps --require-hashes -r (Join-Path $repo 'services\voice-box\requirements-build.lock')
if ($LASTEXITCODE) { throw 'Pinned build dependencies failed' }
& $python -m pip install --no-build-isolation --no-deps --require-hashes -r (Join-Path $repo 'services\voice-box\requirements.lock')
if ($LASTEXITCODE) { throw 'Pinned voice dependencies failed' }
& $python -m pip install --no-deps --require-hashes -r (Join-Path $repo 'services\voice-box\requirements-windows.lock')
if ($LASTEXITCODE) { throw 'Pinned Windows dependencies failed' }
# Upstream binary is ONLY for execution feasibility. It is not approved for
# redistribution: the release must audit bundled native code or build CPU source.
$ctWheel = Get-VerifiedSpikeFile 'https://files.pythonhosted.org/packages/4e/23/e3b5322ff7368fcbed181ea4c209149416e7940b5b04971d5ee4084afe1a/ctranslate2-4.8.2-cp312-cp312-win_amd64.whl' 'ctranslate2-4.8.2-cp312-cp312-win_amd64.whl' 19222069 'd94421d565d0de61c032998f737a18942b0f2bef40c0424b1846ec6f67300105'
& $python -m pip install --no-index --no-deps $ctWheel
if ($LASTEXITCODE) { throw 'CTranslate2 spike dependency failed' }
& $python (Join-Path $repo 'services\voice-box\patch_whisper.py')
if ($LASTEXITCODE) { throw 'Reviewed PCM adaptation failed' }
& $python (Join-Path $repo 'services\voice-box\download_models.py') (Join-Path $base 'cache\voice-models')
if ($LASTEXITCODE) { throw 'Pinned models failed verification' }
Write-Output 'Native voice spike dependencies prepared; redistribution review still required.'
