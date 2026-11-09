// The installer's code, shared by JosiCE.iss and the installer's own UI test.
// Needs the defines KitHash, ManifestHash and CandidateVersion.
//
// Josi's setup host (Invoke-NativeSetup.ps1) does the work and reports each step
// on stdout as "JOSI-PROGRESS|<percent>|<text>". This shows those steps, and lets
// Cancel work until the host starts changing this PC: Cancel leaves a file the
// host checks at every safe point, and while the "Stop?" question is open a hold
// file makes the host wait at its next safe point for the answer. The host prints
// "JOSI-COMMITTING" when it starts changing this PC; from then on Cancel says why
// it can't stop, and a cancel that arrives too late gets "JOSI-NOCANCEL" back.
//
// When Josi CE is already on this PC, a page asks whether to update it or remove
// it (/REMOVE picks removal on the command line). Removal keeps Josi's data.
var
  VerifyOnly, RemoveRequested, InstallationComplete: Boolean;
  CancelRequested, PastCancel, HostCancelled: Boolean;
  ActionPage: TInputOptionWizardPage;

function EnableWindow(hWnd: HWND; bEnable: BOOL): BOOL;
external 'EnableWindow@user32.dll stdcall';

function WasInstalled: Boolean;
begin
  Result := InstallationComplete;
end;

function JosiIsInstalled: Boolean;
begin
#ifdef TestJosiInstalled
  Result := True;
#else
  Result := DirExists(ExpandConstant('{commonpf64}\Josi CE Server')) or DirExists(ExpandConstant('{commonappdata}\Josi CE Server'));
#endif
end;

function Removing: Boolean;
begin
  if ActionPage <> nil then Result := ActionPage.Values[1] else Result := RemoveRequested;
end;

function CancelFile: String;
begin
  Result := ExpandConstant('{tmp}\cancel-request');
end;

function HoldFile: String;
begin
  Result := CancelFile + '.hold';
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
  RemoveRequested := False;
  for I := 1 to ParamCount do begin
    if CompareText(ParamStr(I), '/VERIFYONLY') = 0 then VerifyOnly := True;
    if CompareText(ParamStr(I), '/REMOVE') = 0 then RemoveRequested := True;
  end;
  ExtractTemporaryFiles('{tmp}\kit\*');
  ExtractTemporaryFile('release-manifest.json');
  if not Exec(ExpandConstant('{sysnative}\WindowsPowerShell\v1.0\powershell.exe'),
      HostArguments('verify-only'), ExpandConstant('{tmp}'), SW_HIDE, ewWaitUntilTerminated, Code) then Exit;
  if Code <> 0 then begin
    if not WizardSilent then MsgBox('This copy of the Josi CE installer did not pass its integrity check. Nothing was installed. Download it again from https://get.heyjosi.com.', mbCriticalError, MB_OK);
    Exit;
  end;
  Log('Josi CE kit and manifest verification passed. Read-only verification did not modify the installation.');
  if VerifyOnly then begin
    Result := True;
    Exit;
  end;
  if RemoveRequested and not JosiIsInstalled then begin
    SuppressibleMsgBox('Josi CE isn''t installed on this PC, so there is nothing to remove.', mbInformation, MB_OK, IDOK);
    Exit;
  end;
  Result := True;
end;

procedure UpdateNextButton;
begin
  if (ActionPage <> nil) and (WizardForm.CurPageID = ActionPage.ID) then
    if Removing then WizardForm.NextButton.Caption := 'Remove'
    else WizardForm.NextButton.Caption := SetupMessage(msgButtonInstall);
end;

procedure ActionChanged(Sender: TObject);
begin
  UpdateNextButton;
end;

procedure InitializeWizard;
begin
  if VerifyOnly or not JosiIsInstalled then Exit;
  ActionPage := CreateInputOptionPage(wpWelcome, 'Josi CE is already on this PC', 'What would you like to do?',
    'Your accounts, conversations and settings are kept either way.', True, False);
  ActionPage.Add('Update Josi CE to version {#CandidateVersion}. If this version is already installed, setup repairs it instead, replacing only files that changed.');
  ActionPage.Add('Remove Josi CE from this PC. Its services stop and its program files are deleted; your data stays in ProgramData\Josi CE Server, so installing again picks up where you left off.');
  ActionPage.Values[0] := not RemoveRequested;
  ActionPage.Values[1] := RemoveRequested;
  ActionPage.CheckListBox.OnClickCheck := @ActionChanged;
end;

procedure CurPageChanged(CurPageID: Integer);
begin
  UpdateNextButton;
  if not Removing then Exit;
  if CurPageID = wpInstalling then begin
    WizardForm.PageNameLabel.Caption := 'Removing Josi CE';
    WizardForm.PageDescriptionLabel.Caption := 'Please wait while Josi CE is removed from this PC.';
  end else if CurPageID = wpFinished then begin
    WizardForm.FinishedHeadingLabel.Caption := 'Josi CE is removed';
    WizardForm.FinishedLabel.Caption := 'Josi''s services and program files are gone from this PC. Your accounts, conversations and settings are still in ProgramData\Josi CE Server; run this installer again to bring Josi back.';
  end;
end;

procedure OnHostLine(const S: String; const Error, FirstLine: Boolean);
var
  Rest: String;
  P: Integer;
begin
  Log('Setup host: ' + S);
  // Inno disables the wizard while it waits; give the Cancel button back.
  EnableWindow(WizardForm.Handle, True);
  if Copy(S, 1, 14) = 'JOSI-PROGRESS|' then begin
    Rest := Copy(S, 15, Length(S));
    P := Pos('|', Rest);
    if P > 0 then begin
      if not CancelRequested or PastCancel then WizardForm.StatusLabel.Caption := Copy(Rest, P + 1, Length(Rest));
      WizardForm.FilenameLabel.Caption := '';
      WizardForm.ProgressGauge.Min := 0;
      WizardForm.ProgressGauge.Max := 100;
      WizardForm.ProgressGauge.Position := StrToIntDef(Copy(Rest, 1, P - 1), 0);
    end;
  end else if S = 'JOSI-COMMITTING' then
    PastCancel := True
  else if S = 'JOSI-NOCANCEL' then begin
    PastCancel := True;
    WizardForm.StatusLabel.Caption := 'Josi is too far along to stop safely, so setup is finishing.';
  end else if S = 'JOSI-CANCELLED' then
    HostCancelled := True;
end;

procedure CancelButtonClick(CurPageID: Integer; var Cancel, Confirm: Boolean);
var
  Question: String;
begin
  if CurPageID <> wpInstalling then Exit;
  // Setup never stops the host itself; the host stops at a safe point or says it can't.
  Cancel := False;
  Confirm := False;
  if PastCancel then begin
    MsgBox('Josi is too far along to stop safely. Setup will finish on its own; please wait.', mbInformation, MB_OK);
    Exit;
  end;
  if CancelRequested then Exit;
  if Removing then Question := 'Stop removing Josi? Setup stops safely as long as it hasn''t started removing; if it has, it finishes instead.'
  else Question := 'Stop setting up Josi? Setup stops safely as long as it hasn''t started installing; if it has, it finishes instead.';
  // The host keeps running while this question is open, and its output isn't read
  // until it closes. The hold file makes it wait at its next safe point instead of
  // running past the last place it can stop.
  SaveStringToFile(HoldFile, 'hold', False);
  if MsgBox(Question, mbConfirmation, MB_YESNO) = IDYES then begin
    CancelRequested := True;
    SaveStringToFile(CancelFile, 'cancel', False);
    if not PastCancel then WizardForm.StatusLabel.Caption := 'Stopping safely…';
  end;
  DeleteFile(HoldFile);
end;

procedure StopSetup(const Message: String);
begin
  Log(Message);
  SuppressibleMsgBox(Message, mbError, MB_OK, IDOK);
  Abort;
end;

procedure CurStepChanged(Step: TSetupStep);
var
  Code: Integer;
  Operation, Arguments: String;
begin
  if (Step = ssInstall) and not VerifyOnly then begin
    if Removing then begin
      Operation := 'uninstall';
      WizardForm.StatusLabel.Caption := 'Getting ready…';
    end else begin
      Operation := 'install-or-upgrade';
      WizardForm.StatusLabel.Caption := 'Unpacking Josi CE…';
      ExtractTemporaryFiles('{tmp}\payloads\*');
      WizardForm.StatusLabel.Caption := 'Getting ready…';
    end;
    Arguments := HostArguments(Operation) + ' -LocalAcceptancePayloads "' + ExpandConstant('{tmp}\payloads') + '" -CancelPath "' + CancelFile + '"';
    if not ExecAndLogOutput(ExpandConstant('{sysnative}\WindowsPowerShell\v1.0\powershell.exe'), Arguments,
        ExpandConstant('{tmp}'), SW_HIDE, ewWaitUntilTerminated, Code, @OnHostLine) then
      StopSetup('Josi CE setup could not start. Nothing of yours was changed.');
    if HostCancelled or (Code = 3) then StopSetup('Setup was cancelled. Nothing was changed on this PC.');
    if Code <> 0 then begin
      if Removing then StopSetup('Josi CE could not be fully removed. Your data is kept. Run the installer again and choose Remove; if it fails again, send the log from Josi''s Server page.')
      else StopSetup('Josi CE setup did not finish. Your data and the recovery copy are kept. Run the installer again; if it fails again, send the log from Josi''s Server page.');
    end;
    if Removing then DeleteFile(ExpandConstant('{commonprograms}\Josi.lnk'))
    else InstallationComplete := True;
  end;
end;

function ShouldSkipPage(PageID: Integer): Boolean;
begin
  Result := VerifyOnly;
end;
