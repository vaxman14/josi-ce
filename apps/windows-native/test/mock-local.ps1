# Test helper: a throwaway development-server folder that makes Josi treat
# test/mock-server.mjs on -Port as the server on this PC, so tests reach it
# with "Open Josi". Prints the folder; the caller sets JOSI_SERVER_DATA to it
# and deletes it afterwards. -Setup adds the first-run handoff file.
param([Parameter(Mandatory)][int]$Port, [switch]$Setup)
$data = Join-Path ([IO.Path]::GetTempPath()) ('josi-mock-local-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force (Join-Path $data 'config') | Out-Null
Set-Content (Join-Path $data 'config\runtime.json') ('{"schemaVersion":1,"version":"test","publicUrl":"http://localhost:' + $Port + '"}')
if ($Setup) {
  New-Item -ItemType Directory -Force (Join-Path $data 'first-run') | Out-Null
  Set-Content (Join-Path $data 'first-run\bootstrap.json') ('{"schemaVersion":1,"port":' + $Port + ',"token":"' + ('a' * 64) + '"}')
}
$data
