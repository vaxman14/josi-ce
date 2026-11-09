; Josi Client for Windows: the app alone, for people connecting to a server that
; runs somewhere else. Installs for the current Windows account, with no
; administrator prompt. Running a newer installer updates it in place: AppId stays
; the same, so it replaces the app and leaves the person's sign-ins alone.
;
; Compiled by scripts\windows\Build-ClientInstaller.ps1 with these defines:
;   AppVersionText, NumericVersion, SourceExe, OutputRoot, AppIcon
[Setup]
AppId={{6F3C2A44-8E1B-4F7D-9C55-1B7E0A2D4C61}
AppName=Josi Client
AppVersion={#AppVersionText}
AppVerName=Josi Client {#AppVersionText}
AppPublisher=SOCAL RECEPTIONIST LLC
AppPublisherURL=https://heyjosi.com
AppSupportURL=https://get.heyjosi.com
AppUpdatesURL=https://get.heyjosi.com
VersionInfoVersion={#NumericVersion}
VersionInfoProductName=Josi Client
VersionInfoDescription=Josi Client for Windows installer
VersionInfoCompany=SOCAL RECEPTIONIST LLC
VersionInfoCopyright=SOCAL RECEPTIONIST LLC
SetupIconFile={#AppIcon}
UninstallDisplayIcon={app}\Josi Client.exe
UninstallDisplayName=Josi Client
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.19041
PrivilegesRequired=lowest
DefaultDirName={localappdata}\Programs\Josi Client
DisableDirPage=yes
DisableProgramGroupPage=yes
DisableReadyPage=yes
CloseApplications=yes
RestartApplications=no
OutputDir={#OutputRoot}
OutputBaseFilename=Josi-Client-{#AppVersionText}-Windows-x64
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
ShowLanguageDialog=no

[Messages]
WelcomeLabel1=Install Josi Client
WelcomeLabel2=This installs Josi Client {#AppVersionText} on this PC, or updates the one already here. It connects to a Josi server that runs somewhere else.
FinishedHeadingLabel=Josi Client is installed

[Files]
Source: "{#SourceExe}"; DestDir: "{app}"; DestName: "Josi Client.exe"; Flags: ignoreversion

[Icons]
Name: "{userprograms}\Josi Client"; Filename: "{app}\Josi Client.exe"

[Run]
Filename: "{app}\Josi Client.exe"; Description: "Open Josi Client"; Flags: nowait postinstall skipifsilent
