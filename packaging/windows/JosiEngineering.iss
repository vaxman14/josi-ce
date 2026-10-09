; The current engineering preview verifies its embedded kit and manifest.
; It cannot install, repair, uninstall, elevate, or change the live product.
; A production bootstrap needs the remaining release and physical gates first.
#ifndef KitRoot
  #error KitRoot must identify the locally verified embedded installer kit
#endif
#ifndef ReleaseRoot
  #error ReleaseRoot must identify the locally verified release manifest
#endif

[Setup]
AppId={{2DEB2167-EEA2-4A06-A5B0-45D5198EA8C1}
AppName=Josi CE Windows engineering preview
AppVersion={#CandidateVersion}
AppVerName=Josi CE {#CandidateVersion} engineering preview
AppPublisher=Josi CE
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.22000
PrivilegesRequired=lowest
CreateAppDir=no
Uninstallable=no
CreateUninstallRegKey=no
DisableProgramGroupPage=yes
DisableReadyPage=yes
DisableWelcomePage=yes
DisableFinishedPage=yes
RestartIfNeededByRun=no
CloseApplications=no
RestartApplications=no
OutputDir={#OutputRoot}
OutputBaseFilename=Josi-CE-{#CandidateVersion}-Windows-x64-engineering
Compression=lzma2
SolidCompression=yes
SetupLogging=yes
WizardStyle=modern

[Files]
Source: "{#KitRoot}\*"; DestDir: "{tmp}\kit"; Flags: dontcopy
Source: "{#ReleaseRoot}\release-manifest.json"; DestDir: "{tmp}"; Flags: dontcopy
Source: "{#ReleaseRoot}\release-manifest.cat"; DestDir: "{tmp}"; Flags: dontcopy

[Code]
var
  VerificationPassed: Boolean;

function InitializeSetup: Boolean;
var
  I, ExitCode: Integer;
  Requested: Boolean;
  Arguments: String;
  Evidence: AnsiString;
begin
  Result := False;
  Requested := False;
  for I := 1 to ParamCount do
    if CompareText(ParamStr(I), '/VERIFYONLY') = 0 then Requested := True;
  if not Requested then begin
    if not WizardSilent then
      MsgBox('This engineering preview is not ready to install. License/source closure and final installer acceptance are unfinished. Your existing Josi installation has not been changed.', mbInformation, MB_OK);
    Log('Release gates unfinished; installation blocked before elevation or product changes.');
    Exit;
  end;
  ExtractTemporaryFiles('{tmp}\kit\*');
  ExtractTemporaryFile('release-manifest.json');
  ExtractTemporaryFile('release-manifest.cat');
  Arguments := '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + ExpandConstant('{tmp}\kit\Invoke-NativeSetup.ps1') +
    '" -KitRoot "' + ExpandConstant('{tmp}\kit') + '" -KitHash {#KitHash} -ManifestHash {#ManifestHash} -Version {#CandidateVersion} -Operation verify-only';
  { The pinned Inno bootstrap is a 32-bit process; explicitly launch the native
    64-bit OS shell even before the installation step. }
  if not Exec(ExpandConstant('{sysnative}\WindowsPowerShell\v1.0\powershell.exe'), Arguments, ExpandConstant('{tmp}'), SW_HIDE, ewWaitUntilTerminated, ExitCode) then Exit;
  if ExitCode <> 0 then begin
    Log('Embedded integrity verification failed.');
    Exit;
  end;
  if not LoadStringFromFile(ExpandConstant('{tmp}\verification-result.json'), Evidence) then Exit;
  Log('Josi verification result: ' + String(Evidence));
  VerificationPassed := True;
  Result := True;
end;

function ShouldSkipPage(PageID: Integer): Boolean;
begin
  Result := VerificationPassed;
end;

function GetCustomSetupExitCode: Integer;
begin
  if VerificationPassed then Result := 0 else Result := 1;
end;
