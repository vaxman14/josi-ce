; Private unsigned acceptance installer. Offline component archives are bound
; to the embedded manifest. Public download/signature gates stay separate.
[Setup]
AppId={{2DEB2167-EEA2-4A06-A5B0-45D5198EA8C1}
AppName=Josi CE
AppVersion={#CandidateVersion}
AppVerName=Josi CE {#CandidateVersion} unsigned acceptance candidate
AppPublisher=Josi CE
VersionInfoVersion={#NumericVersion}
VersionInfoDescription=Josi CE Windows installer - unsigned acceptance candidate
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.22000
PrivilegesRequired=admin
; Only the explicitly read-only verifier uses /CURRENTUSER. The setup host
; independently requires administrator rights before any installation mutation.
PrivilegesRequiredOverridesAllowed=commandline
CreateAppDir=no
Uninstallable=no
CreateUninstallRegKey=no
DisableProgramGroupPage=yes
DisableDirPage=yes
DisableReadyPage=yes
DisableWelcomePage=no
RestartIfNeededByRun=no
CloseApplications=no
RestartApplications=no
OutputDir={#OutputRoot}
OutputBaseFilename=Josi-CE-{#CandidateVersion}-Windows-x64-acceptance
Compression=lzma2
SolidCompression=yes
SetupLogging=yes
WizardStyle=modern

[Messages]
FinishedLabel=Installation complete. Finish setting up Josi in your browser.
WelcomeLabel2=This private, unsigned candidate installs or upgrades Josi. Existing accounts, data, configuration and recovery material are preserved. Keep the payloads folder beside this EXE. Windows will request administrator approval. Browser setup opens separately after Josi is ready.

[Files]
Source: "{#KitRoot}\*"; DestDir: "{tmp}\kit"; Flags: dontcopy
Source: "{#ReleaseRoot}\release-manifest.json"; DestDir: "{tmp}"; Flags: dontcopy

[Icons]
Name: "{commonprograms}\Josi"; Filename: "{pf64}\Josi CE Server\versions\{#CandidateVersion}\JosiLauncher.exe"; Check: WasInstalled

[Run]
Filename: "{pf64}\Josi CE Server\versions\{#CandidateVersion}\JosiLauncher.exe"; Flags: nowait runasoriginaluser; Check: WasInstalled

[Code]
var
  VerifyOnly, InstallationComplete: Boolean;

function WasInstalled: Boolean;
begin
  Result := InstallationComplete;
end;

function HostArguments(Operation: String): String;
begin
  Result := '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + ExpandConstant('{tmp}\kit\Invoke-NativeSetup.ps1') +
    '" -KitRoot "' + ExpandConstant('{tmp}\kit') + '" -KitHash {#KitHash} -ManifestHash {#ManifestHash} -Version {#CandidateVersion} -Operation ' + Operation;
end;

function InitializeSetup: Boolean;
var
  I, Code: Integer;
begin
  Result := False;
  VerifyOnly := False;
  for I := 1 to ParamCount do
    if CompareText(ParamStr(I), '/VERIFYONLY') = 0 then VerifyOnly := True;
  ExtractTemporaryFiles('{tmp}\kit\*');
  ExtractTemporaryFile('release-manifest.json');
  if not Exec(ExpandConstant('{sysnative}\WindowsPowerShell\v1.0\powershell.exe'),
      HostArguments('verify-only'), ExpandConstant('{tmp}'), SW_HIDE, ewWaitUntilTerminated, Code) then Exit;
  if Code <> 0 then begin
    if not WizardSilent then MsgBox('Josi installer integrity could not be verified. No installation changes were made.', mbError, MB_OK);
    Exit;
  end;
  Log('Josi embedded kit and manifest verification passed. Read-only verification did not modify the installation.');
  Result := True;
end;

procedure CurStepChanged(Step: TSetupStep);
var
  Code: Integer;
  Arguments: String;
begin
  if (Step = ssInstall) and not VerifyOnly then begin
    WizardForm.StatusLabel.Caption := 'Installing Josi and waiting for its services to be ready…';
    Arguments := HostArguments('install-or-upgrade') + ' -LocalAcceptancePayloads "' + ExpandConstant('{src}\payloads') + '"';
    if not Exec(ExpandConstant('{sysnative}\WindowsPowerShell\v1.0\powershell.exe'), Arguments,
        ExpandConstant('{tmp}'), SW_HIDE, ewWaitUntilTerminated, Code) then
      RaiseException('Josi setup could not start. Existing data is preserved.');
    if Code <> 0 then RaiseException('Josi setup did not finish. Data and recovery material are retained. Review the retained transaction before retrying; no automatic SQL restore occurred.');
    InstallationComplete := True;
  end;
end;

function ShouldSkipPage(PageID: Integer): Boolean;
begin
  Result := VerifyOnly;
end;
