"""Supplementary hosted proof only; never shipped with the candidate."""
import hashlib,json,os,pathlib,re,subprocess,sys,time
root=pathlib.Path(sys.argv[1]).resolve();expected=sys.argv[2];dashboard=root/'gui';target=dashboard/'tests/usage-custom-range.test.tsx'
assert subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip()==expected
assert subprocess.check_output(['bun','--version'],text=True).strip()=='1.4.0'
original=target.read_bytes();original_hash=hashlib.sha256(original).hexdigest();source=original.decode();rows=[]
name='^America/Santiago midnight DST retains final-day activity and tooltip$'
env0=dict(os.environ);env0.pop('OCX_USAGE_SANTIAGO_CHILD',None)
def run(label,tz,focused=False,fail=False,timeout_control=False):
 env=env0.copy()
 if tz is None:env.pop('TZ',None)
 else:env['TZ']=tz
 args=['bun','test','--isolate','./tests/usage-custom-range.test.tsx']
 if focused:args+=['-t',name]
 start=time.monotonic()
 p=subprocess.run(args,cwd=dashboard,env=env,capture_output=True,text=True,timeout=50)
 elapsed=time.monotonic()-start;output=re.sub(r'\x1b\[[0-9;]*m','',p.stdout+'\n'+p.stderr)
 print('===',label,'TZ requested',repr(tz),'exit',p.returncode,'seconds',round(elapsed,2),flush=True)
 print(output,flush=True)
 if fail:
  assert p.returncode!=0,(label,'negative control was accepted')
  assert '(fail) America/Santiago midnight DST retains final-day activity and tooltip' in output,(label,'target test did not fail')
  assert not re.search(r'SyntaxError|Cannot find module|ModuleNotFoundError|Unhandled error between tests',output),(label,'unrelated load/parse failure')
  required={
   'missing completion marker':['OCX_MARKER_OMITTED','OCX_SANTIAGO_CASE_COMPLETED','toContain'],
   'child assertion failure':['OCX_CHILD_EXPECTED','OCX_CHILD_ACTUAL','Expected:','Received:'],
   'malformed child timezone':['America/Santiago','Etc/UTC','Expected:','Received:'],
   'test filter miss':['OCX_INTENTIONAL_FILTER_MISS'],
   'bounded child timeout':['exitedDueToTimeout','OCX_PROBE_CHILD_PID='],
  }[label]
  assert all(token in output for token in required),(label,'expected diagnostic missing',required)
  if label=='test filter miss':assert re.search(r'filtered|matched|No tests|0 pass',output,re.I),(label,'no filter-miss evidence')
  if timeout_control:
   assert elapsed>=10 and elapsed<45,(label,elapsed)
   pids=set(re.findall(r'OCX_PROBE_CHILD_PID=(\d+)',output));assert pids,'timeout child identity missing'
   for pid in pids:
    if os.name=='nt':
     info=subprocess.run(['tasklist','/FI','PID eq '+pid,'/FO','CSV','/NH'],capture_output=True,text=True,timeout=10)
     assert info.returncode==0 and not re.search(r'"'+pid+r'"',info.stdout),'child still alive'
    else:
     try:os.kill(int(pid),0)
     except ProcessLookupError:pass
     else:raise AssertionError('child still alive: '+pid)
 else:
  assert p.returncode==0,(label,p.returncode)
  assert re.search(r'\b[1-9]\d* pass\b',output),('no test pass evidence',label)
  assert re.search(r'\b0 fail\b',output),('no zero-failure summary',label)
 rows.append({'case':label,'requestedTZ':tz,'exit':p.returncode,'seconds':round(elapsed,3),'expectedFailure':fail})
def mutate(label,old,new,timeout_control=False):
 assert source.count(old)==1,(label,'ambiguous mutation')
 try:
  target.write_text(source.replace(old,new,1))
  run(label,'Etc/UTC',focused=True,fail=True,timeout_control=timeout_control)
 finally:target.write_bytes(original)
 assert hashlib.sha256(target.read_bytes()).hexdigest()==original_hash
try:
 for tz in [None,'Etc/UTC','Asia/Seoul','America/Santiago']:run('positive-'+str(tz),tz)
 mutate('missing completion marker','console.log("OCX_SANTIAGO_CASE_COMPLETED")','console.log("OCX_MARKER_OMITTED")')
 mutate('child assertion failure','expect(process.env.TZ).toBe("America/Santiago");','expect(process.env.TZ).toBe("America/Santiago");\n  expect("OCX_CHILD_ACTUAL").toBe("OCX_CHILD_EXPECTED");')
 mutate('malformed child timezone','TZ: "America/Santiago", OCX_USAGE_SANTIAGO_CHILD: "1"','TZ: "Etc/UTC", OCX_USAGE_SANTIAGO_CHILD: "1"')
 mutate('test filter miss','"-t", "'+name+'"','"-t", "^OCX_INTENTIONAL_FILTER_MISS$"')
 mutate('bounded child timeout','expect(process.env.TZ).toBe("America/Santiago");','console.log(`OCX_PROBE_CHILD_PID=${process.pid}`);\n  while (true) {}\n  expect(process.env.TZ).toBe("America/Santiago");',timeout_control=True)
 run('restored final candidate','Etc/UTC')
finally:
 target.write_bytes(original)
 assert hashlib.sha256(target.read_bytes()).hexdigest()==original_hash
 assert subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip()==expected
 assert not subprocess.check_output(['git','diff','--name-only','--','gui/tests/usage-custom-range.test.tsx'],cwd=root,text=True).strip()
print('EVIDENCE_JSON='+json.dumps({'candidate':expected,'sourceSha256':original_hash,'platform':sys.platform,'bun':'1.4.0','cases':rows,'restored':True}),flush=True)
