#!/usr/bin/env python3
"""Narrow supervisor for installer recovery and allowlisted Josi Doctor actions."""
import argparse, datetime, hashlib, ipaddress, json, os, re, secrets, socket, socketserver, ssl, subprocess, threading, time, urllib.request
from http.server import BaseHTTPRequestHandler
from pathlib import Path

HOST=re.compile(r'^[A-Za-z0-9.-]{1,253}$')
VERSION=re.compile(r'^[0-9]+\.[0-9]+\.[0-9]+(?:[.-][0-9A-Za-z][0-9A-Za-z.-]*)?$')
class Manager:
 def __init__(self,root:Path,image:str,uid:int,gid:int,docker_gid:int,project:str='josi-ce'):
  self.root=root.resolve();self.image=image;self.uid=uid;self.gid=gid;self.docker_gid=docker_gid;self.project=project;self.name='josi-ce-maintenance-'+hashlib.sha256(str(self.root).encode()).hexdigest()[:12];self.doctor_lock=threading.Lock();self.update_lock=threading.Lock();self.update_file=self.root/'installer-state'/'update-status.json'
 def launch(self,body):
  host=str(body.get('host','')).strip()
  if not HOST.fullmatch(host): raise ValueError('browser host is invalid')
  state=self.root/'installer-state';state.mkdir(mode=0o700,exist_ok=True);os.chmod(state,0o700);os.chown(state,self.uid,self.gid)
  code='-'.join((secrets.token_hex(2).upper(),secrets.token_hex(2).upper()))
  token=state/'bootstrap-token';token.write_text(code);os.chmod(token,0o600);os.chown(token,self.uid,self.gid)
  key,cert=state/'tls.key',state/'tls.crt'
  if not key.exists() or not cert.exists():
   subprocess.run(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=Josi Local Maintenance','-keyout',str(key),'-out',str(cert)],check=True,timeout=30,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
   for path in (key,cert): os.chmod(path,0o600);os.chown(path,self.uid,self.gid)
  advertised=self.reachable_host(host)
  subprocess.run(['docker','rm','-f',self.name],check=False,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
  args=['docker','run','-d','--name',self.name,'--user',f'{self.uid}:{self.gid}','--group-add',str(self.docker_gid),'--rm','--read-only','--security-opt','no-new-privileges','--cap-drop','ALL','--tmpfs','/tmp:size=32m,mode=1777','-p',f'{advertised}:8080:8080','-v','/var/run/docker.sock:/var/run/docker.sock','-v',f'{self.root}:{self.root}','-w',str(self.root),'-e',f'JOSI_INSTALL_ROOT={self.root}','-e','JOSI_EXISTING_INSTALL=1','-e','JOSI_INSTALLER_PORT=8080','-e',f'JOSI_PROJECT_NAME={self.project}','-e',f'JOSI_INSTALL_UID={self.uid}','-e',f'JOSI_INSTALL_GID={self.gid}','-e','JOSI_APP_GID=1000','-e',f'JOSI_DOCKER_GID={self.docker_gid}','-e',f'JOSI_INSTALLER_IMAGE={self.image}','-e','JOSI_VERSION=maintenance','--entrypoint','python3',self.image,'/opt/josi-installer/controller.py']
  try:
   subprocess.run(args,check=True,timeout=60,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE,text=True)
   self.wait_ready()
  except Exception:
   subprocess.run(['docker','rm','-f',self.name],check=False,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
   token.unlink(missing_ok=True)
   raise RuntimeError('temporary controller failed to start; verify that port 8080 is available') from None
  return {'url':f'https://{advertised}:8080','code':code,'expiresInSeconds':900}
 def reachable_host(self,browser_host):
  # The helper deliberately has no network. Ask Docker for the host route,
  # never advertise the helper/container's private bridge address.
  result=subprocess.run(['docker','run','--rm','--network','host',
   '--entrypoint','python3',self.image,'-c',
   "import socket; s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM); s.connect(('192.0.2.1',9)); print(s.getsockname()[0]); s.close()"],
   check=True,capture_output=True,text=True,timeout=30)
  candidate=result.stdout.strip()
  address=ipaddress.ip_address(candidate)
  if not address.is_private or address.is_loopback: raise RuntimeError('no browser-reachable LAN address was found')
  return candidate
 def wait_ready(self):
  deadline=time.monotonic()+45
  # Probe inside the controller namespace. The supervisor has --network none.
  probe="import json,ssl,urllib.request; r=urllib.request.urlopen('https://127.0.0.1:8080/health',context=ssl._create_unverified_context(),timeout=2); assert r.status==200 and json.load(r).get('ok') is True"
  while time.monotonic()<deadline:
   running=subprocess.run(['docker','inspect','-f','{{.State.Running}}',self.name],capture_output=True,text=True,timeout=5).stdout.strip()
   if running!='true': raise RuntimeError('temporary controller exited before it became ready')
   result=subprocess.run(['docker','exec',self.name,'python3','-c',probe],capture_output=True,timeout=5)
   if result.returncode==0:return
   time.sleep(.5)
  raise RuntimeError('temporary controller readiness timed out')
 def doctor(self,repair=False):
  if repair and not self.doctor_lock.acquire(blocking=False): raise RuntimeError('a repair is already running')
  try:
   report=self.run_doctor(repair)
   if repair and not report.get('healthy'):
    deadline=time.monotonic()+60
    while time.monotonic()<deadline:
     time.sleep(2)
     report=self.run_doctor(False)
     if report.get('healthy'): break
   return report
  finally:
   if repair:self.doctor_lock.release()
 def run_doctor(self,repair=False):
   executable=self.root/'josi'
   if not executable.is_file(): raise RuntimeError('Josi Doctor is unavailable; rerun the installer once')
   command=['bash',str(executable),'--root',str(self.root),'doctor','--json']
   if not repair: command.append('--check-only')
   env={'PATH':'/usr/local/bin:/usr/bin:/bin','HOME':str(self.root),'JOSI_HOME':str(self.root),'JOSI_DOCKER_BIN':'docker','JOSI_DOCTOR_LOCAL_ONLY':'1','COMPOSE_PROJECT_NAME':self.project}
   result=subprocess.run(command,cwd=self.root,env=env,capture_output=True,text=True,timeout=600)
   report=None
   for line in reversed(result.stdout.splitlines()):
    try:
     candidate=json.loads(line)
     if candidate.get('schema')=='josi.doctor.v2': report=candidate;break
    except (json.JSONDecodeError,AttributeError): pass
   if report is None: raise RuntimeError('Josi Doctor did not return a valid report')
   return report
 def now(self): return datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00','Z')
 def current_version(self):
  env=self.root/'.env'
  try:
   for line in env.read_text().splitlines():
    if line.startswith('JOSI_TAG='):
     value=line.split('=',1)[1].strip()
     if VERSION.fullmatch(value): return value
  except OSError: pass
  return '0.1.0'
 def save_update(self,value):
  self.update_file.parent.mkdir(mode=0o700,exist_ok=True);os.chmod(self.update_file.parent,0o700)
  tmp=self.update_file.with_suffix('.tmp');tmp.write_text(json.dumps(value,separators=(',',':')));os.chmod(tmp,0o600);os.replace(tmp,self.update_file)
 def update_status(self):
  try:
   value=json.loads(self.update_file.read_text())
   if isinstance(value,dict) and value.get('state') in {'running','complete','rolled_back','failed'}:
    if value.get('state')=='running' and not self.update_lock.locked():
     value.update(state='failed',currentVersion=self.current_version(),finishedAt=self.now(),message='The updater stopped before it could report completion. The pre-update backup and rollback evidence were preserved.')
     self.save_update(value)
    return value
  except (OSError,json.JSONDecodeError): pass
  return {'state':'idle','currentVersion':self.current_version(),'targetVersion':None,'startedAt':None,'finishedAt':None,'message':'No update is running.'}
 def newer(self,candidate,current):
  def parts(value): return tuple(int(item) for item in value.split('-',1)[0].split('.',2))
  return parts(candidate)>parts(current)
 def start_update(self,body):
  if set(body)!= {'operation','version','confirm'} or body.get('operation')!='update': raise ValueError('unsupported update request')
  version=str(body.get('version','')).strip();confirm=str(body.get('confirm','')).strip()
  if not VERSION.fullmatch(version) or confirm!=f'UPDATE {version}': raise ValueError('approve the exact update version shown in Josi')
  if not self.update_lock.acquire(blocking=False): raise RuntimeError('an update is already running')
  current=self.current_version()
  if not self.newer(version,current): self.update_lock.release();raise ValueError('only a newer release can be installed')
  value={'state':'running','currentVersion':current,'targetVersion':version,'startedAt':self.now(),'finishedAt':None,'message':'Backing up and applying the approved update.'}
  self.save_update(value)
  threading.Thread(target=self.run_update,args=(current,version),daemon=True).start()
  return value
 def run_update(self,current,version):
  try:
   executable=self.root/'josi'
   if not executable.is_file(): raise RuntimeError('updater unavailable')
   env={'PATH':'/usr/local/bin:/usr/bin:/bin','HOME':str(self.root),'JOSI_HOME':str(self.root),'JOSI_DOCKER_BIN':'docker','JOSI_UPDATE_LOCAL_ONLY':'1','COMPOSE_PROJECT_NAME':self.project}
   result=subprocess.run(['bash',str(executable),'--root',str(self.root),'update',version,'--yes'],cwd=self.root,env=env,capture_output=True,text=True,timeout=3600)
   installed=self.current_version();state='complete' if result.returncode==0 and installed==version else 'rolled_back' if installed==current else 'failed'
   message='Update completed and Josi passed its health checks.' if state=='complete' else 'The update failed, so Josi restored the previous version.' if state=='rolled_back' else 'The update failed and needs manual attention. The pre-update backup was preserved.'
   self.save_update({'state':state,'currentVersion':installed,'targetVersion':version,'startedAt':self.update_status().get('startedAt'),'finishedAt':self.now(),'message':message})
  except Exception:
   self.save_update({'state':'failed','currentVersion':self.current_version(),'targetVersion':version,'startedAt':self.update_status().get('startedAt'),'finishedAt':self.now(),'message':'The update could not finish. The pre-update backup and rollback evidence were preserved.'})
  finally:self.update_lock.release()

class Handler(BaseHTTPRequestHandler):
 manager=None
 def do_GET(self):
  if self.path not in {'/doctor/check','/update/status'}: self.send_error(404);return
  try:self.reply(200,self.manager.doctor(False) if self.path=='/doctor/check' else self.manager.update_status())
  except Exception:self.reply(503,{'error':'Josi Doctor is unavailable. Rerun the installer once to refresh its repair helper.'})
 def do_POST(self):
  try:
   size=int(self.headers.get('content-length','0'))
   if size>4096: raise ValueError('request is too large')
   body=json.loads(self.rfile.read(size) or b'{}')
   if self.path=='/launch': self.reply(201,self.manager.launch(body));return
   if self.path=='/doctor/repair':
    if body!={'operation':'safe_repair'}: raise ValueError('unsupported repair operation')
    self.reply(200,self.manager.doctor(True));return
   if self.path=='/update/start': self.reply(202,self.manager.start_update(body));return
   self.send_error(404)
  except ValueError as exc:self.reply(400,{'error':str(exc)})
  except Exception:self.reply(503,{'error':'The maintenance helper could not complete that operation.'})
 def reply(self,status,result):
  data=json.dumps(result).encode();self.send_response(status);self.send_header('content-type','application/json');self.send_header('cache-control','no-store');self.send_header('content-length',str(len(data)));self.end_headers();self.wfile.write(data)
 def log_message(self,*_): pass
def main():
 p=argparse.ArgumentParser();p.add_argument('--root',required=True);p.add_argument('--socket',required=True);p.add_argument('--image',required=True);p.add_argument('--uid',type=int,required=True);p.add_argument('--gid',type=int,required=True);p.add_argument('--docker-gid',type=int,required=True);p.add_argument('--socket-gid',type=int,required=True);p.add_argument('--project',default='josi-ce');a=p.parse_args();Handler.manager=Manager(Path(a.root),a.image,a.uid,a.gid,a.docker_gid,a.project);path=Path(a.socket);path.unlink(missing_ok=True);path.parent.mkdir(parents=True,exist_ok=True)
 class Server(socketserver.ThreadingUnixStreamServer): daemon_threads=True
 with Server(str(path),Handler) as server: os.chmod(path,0o660);os.chown(path,-1,a.socket_gid);server.serve_forever()
if __name__=='__main__': main()
