#!/usr/bin/env python3
"""Native GTK setup surface. Service credentials never enter this process."""
import http.cookiejar
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import threading
import time
import urllib.request
import uuid

import gi
gi.require_version('Gdk', '4.0')
gi.require_version('Gtk', '4.0')
from gi.repository import Gdk, GLib, Gtk

PAYLOAD = Path('/usr/lib/josi-ce-server-setup/runtime')
HELPER = '/usr/libexec/josi-ce-setup-helper'
HANDOFF = Path('/var/lib/josi-ce-server/handoff') / str(os.getuid())

def redact(text):
    text = re.sub(r'(?i)(password|token|secret|authorization|master.key)(\s*[=:]\s*)\S+', r'\1\2[redacted]', text)
    text = re.sub(r'(?i)(postgres(?:ql)?://)[^\s]+', r'\1[redacted]', text)
    return re.sub(r'\b[a-fA-F0-9]{64}\b', '[redacted]', text)

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

def browser_target(address, bootstrap):
    if not re.fullmatch(r'[a-f0-9]{64}', bootstrap): raise ValueError('Invalid handoff')
    jar = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar), NoRedirect())
    def request(path, method='GET', headers=None):
        req = urllib.request.Request(address+path, data=b'{}' if method == 'POST' else None,
            method=method, headers=headers or {})
        with opener.open(req, timeout=10) as response:
            data = response.read(8193)
            if len(data) > 8192 or response.status != 200: raise ValueError('Invalid handoff response')
            return json.loads(data)
    state = request('/api/onboarding/state')
    if type(state.get('completed')) is not bool: raise ValueError('Invalid onboarding state')
    if state['completed']: return address+'/'
    csrf = request('/api/auth/csrf').get('csrfToken')
    if not isinstance(csrf,str) or not csrf or len(csrf)>256: raise ValueError('Invalid CSRF response')
    token = request('/api/onboarding/launch','POST',{'Content-Type':'application/json',
        'x-josi-csrf':csrf,'x-josi-setup-token':bootstrap}).get('token')
    if not isinstance(token,str) or not re.fullmatch(r'[a-f0-9]{64}',token): raise ValueError('Invalid one-use handoff')
    return address+'/setup#handoff='+token

class Setup(Gtk.Application):
    def __init__(self):
        super().__init__(application_id='com.heyjosi.ce.server.setup')
        self.busy=False; self.started=None; self.log=None; self.installing=False
    def do_activate(self):
        window=Gtk.ApplicationWindow(application=self,title='Josi CE Server Setup',default_width=680,default_height=390)
        box=Gtk.Box(orientation=Gtk.Orientation.VERTICAL,spacing=14,margin_top=24,margin_bottom=24,margin_start=24,margin_end=24)
        title=Gtk.Label(label='Josi CE Server for Linux',xalign=0); title.add_css_class('title-1'); box.append(title)
        copy=Gtk.Label(label='Installation may take several minutes. Keep this window open while Josi verifies its files, prepares PostgreSQL, applies migrations and starts each protected service. Existing data is preserved. Document ingestion stays blocked until a supported scanner is configured and healthy; no scanner is bundled.',wrap=True,xalign=0)
        box.append(copy)
        self.phase=Gtk.Label(label='Ready to verify the offline Linux package',wrap=True,xalign=0); box.append(self.phase)
        activity=Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL,spacing=12)
        self.spinner=Gtk.Spinner(); self.elapsed=Gtk.Label(xalign=0); activity.append(self.spinner); activity.append(self.elapsed); box.append(activity)
        buttons=Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL,spacing=10)
        self.verify=Gtk.Button(label='Verify package'); self.verify.connect('clicked',lambda *_:self.begin(False))
        self.install=Gtk.Button(label='Install Josi CE Server…'); self.install.set_sensitive(False); self.install.connect('clicked',lambda *_:self.begin(True))
        self.open=Gtk.Button(label='Open Josi'); self.open.set_sensitive(False); self.open.connect('clicked',self.open_josi)
        for button in (self.verify,self.install,self.open): buttons.append(button)
        box.append(buttons)
        self.log_label=Gtk.Label(wrap=True,selectable=True,xalign=0); box.append(self.log_label)
        self.copy=Gtk.Button(label='Copy diagnostic log path'); self.copy.set_sensitive(False); self.copy.connect('clicked',self.copy_path); box.append(self.copy)
        window.set_child(box); window.connect('close-request',self.close_request); window.present()
        GLib.timeout_add(500,self.tick)
    def close_request(self,*_):
        return self.busy
    def tick(self):
        if self.started:
            seconds=int(time.monotonic()-self.started); self.elapsed.set_text(f'{seconds//60}:{seconds%60:02d} elapsed')
        return True
    def diagnostic(self,operation):
        directory=Path.home()/'.local/state/josi-ce-server-setup'
        directory.mkdir(mode=0o700,parents=True,exist_ok=True); os.chmod(directory,0o700)
        info=directory.stat()
        if info.st_uid!=os.getuid() or info.st_mode&0o077: raise PermissionError('Diagnostic folder is not private')
        path=directory/(operation+'-'+uuid.uuid4().hex+'.log')
        descriptor=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
        parent=os.open(directory,os.O_RDONLY|os.O_DIRECTORY)
        try:os.fsync(parent)
        finally:os.close(parent)
        return path,descriptor
    def append(self,descriptor,text):
        os.write(descriptor,redact(text).encode('utf-8','replace')); os.fsync(descriptor)
    def begin(self,installing):
        if self.busy:return
        try:self.log,self.descriptor=self.diagnostic('installation' if installing else 'verification')
        except Exception:
            self.phase.set_text('Cannot create a private diagnostic log. Check your home folder permissions before retrying.');return
        self.installing=installing; self.busy=True; self.started=time.monotonic(); self.spinner.start()
        self.verify.set_sensitive(False); self.install.set_sensitive(False); self.open.set_sensitive(False)
        self.log_label.set_text('Diagnostic log: '+str(self.log)); self.copy.set_sensitive(True)
        self.phase.set_text('Waiting for administrator authorization' if installing else 'Verifying every packaged file and pinned inventory')
        args=['pkexec',HELPER,'install',str(os.getuid())] if installing else [str(PAYLOAD/'python/bin/python3.12'),'-I','-B',str(PAYLOAD/'app/native/lifecycle.py'),'verify']
        threading.Thread(target=self.run_operation,args=(args,),daemon=True).start()
    def run_operation(self,args):
        passed=False
        try:
            process=subprocess.Popen(args,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,
                env={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','LANG':'C.UTF-8'},text=True)
            for line in process.stdout:
                self.append(self.descriptor,line)
                try:
                    event=json.loads(line)
                    status=' · '.join(str(event[key]) for key in ('phase','service') if event.get(key))
                    if status:GLib.idle_add(self.phase.set_text,status)
                except Exception:pass
            status=process.wait(); self.append(self.descriptor,f'Process exit status: {status}\n'); passed=status==0
        except Exception as error:
            self.append(self.descriptor,'Operation error: '+type(error).__name__+'\n')
        finally:
            os.close(self.descriptor); GLib.idle_add(self.finished,passed)
    def finished(self,passed):
        self.busy=False; self.started=None; self.spinner.stop(); self.elapsed.set_text('Completed' if passed else 'Stopped')
        if passed and self.installing:self.phase.set_text('Josi is ready. Click Open Josi to finish setup.')
        elif passed:self.phase.set_text('Josi’s installation files passed verification.')
        else:self.phase.set_text(('Installation' if self.installing else 'Verification')+' failed. Details are saved in the private diagnostic log shown below. Existing data was not deleted.')
        self.verify.set_sensitive(True); self.install.set_sensitive(passed or self.installing); self.open.set_sensitive(passed and self.installing)
        return False
    def copy_path(self,*_):
        if self.log:Gdk.Display.get_default().get_clipboard().set(str(self.log))
    def open_josi(self,*_):
        try:
            record=json.loads((HANDOFF/'bootstrap.json').read_text())
            token,port=record['token'],record['port']
            if not re.fullmatch(r'[a-f0-9]{64}',token) or type(port) is not int or not 1024<=port<=65535:raise ValueError()
            address=f'http://localhost:{port}'
            target=browser_target(address,token)
            page=HANDOFF/('Open-Josi-'+uuid.uuid4().hex+'.html')
            html='<!doctype html><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>Open Josi</title><script>location.replace('+json.dumps(target)+')</script>Opening Josi…'
            descriptor=os.open(page,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
            with os.fdopen(descriptor,'w') as stream:stream.write(html);stream.flush();os.fsync(stream.fileno())
            subprocess.Popen(['xdg-open',str(page)],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,close_fds=True)
            self.phase.set_text('Browser opened. Complete setup there; the one-use link expires shortly.')
        except Exception:
            self.phase.set_text('Browser handoff unavailable. Wait for readiness, then click Open Josi to retry.')

if __name__=='__main__':
    raise SystemExit(Setup().run(sys.argv))
