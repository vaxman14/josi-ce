; Josi CE for Windows: the public installer (item 34). One signed EXE that
; carries the setup kit and every component archive, installs or upgrades the
; server and the app, and opens Josi at the end. The setup host
; (Invoke-NativeSetup.ps1) does the work; this file only verifies and hands over.
;
; Compiled by scripts\windows\Build-Installer.ps1 with these defines:
;   KitRoot, ReleaseRoot, KitHash, ManifestHash, CandidateVersion, NumericVersion,
;   OutputRoot, AppIcon
[Setup]
AppId={{2DEB2167-EEA2-4A06-A5B0-45D5198EA8C1}
AppName=Josi CE
AppVersion={#CandidateVersion}
AppVerName=Josi CE {#CandidateVersion}
AppPublisher=SOCAL RECEPTIONIST LLC
AppPublisherURL=https://heyjosi.com
AppSupportURL=https://get.heyjosi.com
AppUpdatesURL=https://get.heyjosi.com
VersionInfoVersion={#NumericVersion}
VersionInfoProductName=Josi CE
VersionInfoDescription=Josi CE for Windows installer
VersionInfoCompany=SOCAL RECEPTIONIST LLC
VersionInfoCopyright=SOCAL RECEPTIONIST LLC
SetupIconFile={#AppIcon}
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.22000
PrivilegesRequired=admin
; Only the explicitly read-only verifier uses /CURRENTUSER. The setup host
; independently requires administrator rights before any installation mutation.
PrivilegesRequiredOverridesAllowed=commandline
CreateAppDir=no
; The setup host owns installation, repair and removal (Program Files and
; ProgramData, six services). Removal is offered from inside Josi (Server page).
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
OutputBaseFilename=Josi-CE-{#CandidateVersion}-Windows-x64
; The component archives are already compressed; LZMA on them costs minutes and gains nothing.
Compression=zip
SolidCompression=no
SetupLogging=yes
WizardStyle=modern
ShowLanguageDialog=no

[Messages]
WelcomeLabel1=Install Josi CE
WelcomeLabel2=This installs Josi CE {#CandidateVersion} on this PC, or updates the Josi CE already here. Your accounts, conversations and settings are kept.%n%nWindows will ask for administrator approval. The installer puts Josi in Program Files, keeps your data in ProgramData, and starts Josi's services so your other devices can reach it. When it finishes, Josi opens so you can set up your account.
FinishedHeadingLabel=Josi CE is installed
FinishedLabel=Josi runs on this PC and keeps running when you close its window, so your phone and your other devices can reach it. Josi opens now to finish setting up.
StatusExtractFiles=Unpacking Josi CE…

[Files]
Source: "{#KitRoot}\*"; DestDir: "{tmp}\kit"; Flags: dontcopy
Source: "{#ReleaseRoot}\release-manifest.json"; DestDir: "{tmp}"; Flags: dontcopy
Source: "{#ReleaseRoot}\*.zip"; DestDir: "{tmp}\payloads"; Flags: dontcopy

[Icons]
Name: "{commonprograms}\Josi"; Filename: "{pf64}\Josi CE Server\versions\{#CandidateVersion}\Josi.exe"; Check: WasInstalled

[Run]
Filename: "{pf64}\Josi CE Server\versions\{#CandidateVersion}\Josi.exe"; Flags: nowait runasoriginaluser; Check: WasInstalled

[Code]
#include "JosiSetupCode.iss"
