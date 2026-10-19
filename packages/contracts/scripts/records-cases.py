#!/usr/bin/env python3
"""Builds fixtures/records/cases.json (run from packages/contracts). Edit the cases here, then rerun."""
import json, base64, copy
b64=lambda b: base64.urlsafe_b64encode(b).rstrip(b'=').decode()
A='a'*64; B='b'*64; C='c'*64
wi={"hwnd":"132456","pid":"4242","windowClass":"CabinetWClass","processStartTime":"133700000000000000"}
def W(**kw):
  d=dict(wi)
  for k,v in kw.items():
    if v is ...: d.pop(k)
    else: d[k]=v
  return d
cases=[]
def add(t,name,value,valid,schema=None):
  e={"type":t,"name":name,"valid":valid,"value":value}
  if not valid: e["schemaRejects"]=schema
  cases.append(e)
add('WindowIdentity','base',W(),True)
add('WindowIdentity','maximum values',W(hwnd="18446744073709551615",pid="4294967295",processStartTime="9223372036854775807"),True)
add('WindowIdentity','256-unit class',W(windowClass="x"*256),True)
add('WindowIdentity','class with surrogate pairs, 256 units',W(windowClass="\U0001F600"*128),True)
for n,v in [('hwnd "0"',W(hwnd="0")),('zero-padded pid',W(pid="007")),('hwnd as a number',W(hwnd=132456)),
  ('processStartTime as ISO',W(processStartTime="2026-10-19T01:00:00Z")),('signed processStartTime',W(processStartTime="-1")),
  ('pid with a space',W(pid=" 42")),('hwnd with a trailing newline',W(hwnd="12\n")),('empty class',W(windowClass="")),
  ('missing pid',W(pid=...)),('extra title key',dict(W(),title="Documents")),('257-unit class',W(windowClass="x"*257)),('null',None)]:
  add('WindowIdentity',n,v,False,True)
for n,v in [('pid over 2^32-1',W(pid="4294967296")),('hwnd over 2^64-1',W(hwnd="18446744073709551616")),
  ('processStartTime over 2^63-1',W(processStartTime="9223372036854775808")),('258 UTF-16 units in 129 code points',W(windowClass="\U0001F600"*129)),
  ('lone surrogate in class',W(windowClass="\ud800abc"))]:
  add('WindowIdentity',n,v,False,False)
rt={"actionId":A,"parentActionId":B,"recoveryAction":"focus","taskId":"task-1","windowIdentity":W(),"nonce":b64(bytes(range(16))),"mac":b64(bytes(range(32,64)))}
def R(**kw):
  d=copy.deepcopy(rt)
  for k,v in kw.items():
    if v is ...: d.pop(k)
    else: d[k]=v
  return d
add('RecoveryToken','base',R(),True)
add('RecoveryToken','move_to_monitor',R(recoveryAction="move_to_monitor"),True)
for n,v in [('close_window action',R(recoveryAction="close_window")),('padded nonce',R(nonce=rt["nonce"]+"==")),
  ('non-canonical nonce tail',R(nonce=rt["nonce"][:21]+"B")),('hex mac',R(mac="d"*64)),('extra purpose key',dict(R(),purpose="dottie.recoveryToken.v1")),
  ('missing mac',R(mac=...)),('identity hwnd "0"',R(windowIdentity=W(hwnd="0"))),('uppercase actionId',R(actionId="A"*64)),('empty taskId',R(taskId="")),
  ('standard-base64 mac',R(mac=base64.b64encode(bytes([251]*32)).rstrip(b'=').decode()))]:
  add('RecoveryToken',n,v,False,True)
for n,v in [('actionId equals parentActionId',R(actionId=B)),('identity pid overflow',R(windowIdentity=W(pid="4294967296")))]:
  add('RecoveryToken',n,v,False,False)
T="2026-10-19T01:50:00.000-05:00"
env_={"schema":"dottie.audit","version":1,"eventId":"ev-1","correlationId":"corr-1","timestamp":T}
def AR(kind,**kw):
  d=dict(env_,kind=kind)
  for k,v in kw.items():
    if v is ...: d.pop(k)
    else: d[k]=v
  return d
resolved=AR('approval.resolved',taskId="task-1",actionId=A,argsHash=A,category="local_change",risk="medium",decision="declined",reason="user_declined",wireReply="decline",requestedAt=T,expiresAt="2026-10-19T01:51:00.000-05:00",resolvedAt=T,outcome="reply_sent")
ids=dict(actionId=A,taskId="task-1",toolId="explorer.open_known_folder")
envs={"keptNames":["PATH","SystemRoot"],"removedSensitiveNames":["OPENAI_API_KEY","github_token"],"removedOtherCount":3,"keptCount":2,"removedCount":5,"canary":"not_run"}
def E(**kw):
  d=copy.deepcopy(envs); d.update(kw); return d
revoked=AR('tool_token.revoked',**ids,decision="revoked",reason="superseded",requestedAt=T,expiresAt=T,resolvedAt=T)
fs=dict(taskId="task-1",decision="denied_by_policy",field="retryOfTaskId",sourceChannel="model",reason="untrusted_origin")
valid=[('bridge approval.resolved',resolved),
 ('approval.requested with displayHash',AR('approval.requested',taskId="task-1",actionId=A,argsHash=A,displayHash=B,category="delete",risk="high",requestedAt=T,expiresAt=T,outcome="displayed")),
 ('joined approval.resolved expired (ruling 1k/1m)',dict(resolved,eventId="evt-join-2",joinedTo="evt-first",displayHash=B,decision="expired",reason="timeout",wireReply="decline")),
 ('approval.resolved declined display_unavailable (join (f))',dict(resolved,reason="display_unavailable",displayHash=B)),
 ('input.field_stripped retryOfTaskId from the model',AR('input.field_stripped',**fs)),
 ('input.field_stripped retryOfTaskId from renderer_ipc (ruling 1w)',AR('input.field_stripped',**dict(fs,sourceChannel="renderer_ipc"))),
 ('input.field_stripped possibleRepeat from codex, no taskId',AR('input.field_stripped',decision="denied_by_policy",field="possibleRepeat",sourceChannel="codex",reason="untrusted_origin")),
 ('tool_token.minted minted',AR('tool_token.minted',**ids,decision="approved",outcome="minted")),
 ('tool_token.minted refused expired',AR('tool_token.minted',**ids,decision="expired",reason="expired",outcome="refused")),
 ('tool_token.rejected',AR('tool_token.rejected',**ids,decision="denied_by_policy",reason="wrong_action",outcome="denied")),
 ('policy.denied navigate tool-host call',AR('policy.denied',**ids,decision="denied_by_policy",reason="locked",outcome="denied",category="navigate")),
 ('approval.requested not_displayed locked, no actionId (per-kind ids OPEN)',AR('approval.requested',taskId="task-1",category="delete",risk="high",decision="denied_by_policy",reason="locked",outcome="not_displayed")),
 ('policy.denied credential_access',AR('policy.denied',taskId="task-1",actionId=A,argsHash=A,category="credential_access",risk="critical",decision="denied_by_policy",reason="credential_access",wireReply="decline",outcome="denied")),
 ('approval.revoked already_executed',AR('approval.revoked',taskId="task-1",actionId=A,decision="revoked",reason="panic_stop",wireReply="none",outcome="already_executed",channel="secure_ui")),
 ('tool_token.revoked',revoked),
 ('tool_token.consumed postcondition_unknown',AR('tool_token.consumed',**ids,decision="approved",reason="app_server_restart",outcome="postcondition_unknown")),
 ('toolhost.peer_rejected without ids',AR('toolhost.peer_rejected',decision="denied_by_policy",reason="catalog_mismatch",outcome="denied")),
 ('toolhost.pipe_squatted',AR('toolhost.pipe_squatted',decision="denied_by_policy",reason="name_exists",outcome="refused_start")),
 ('tool_call.host_refused other',AR('tool_call.host_refused',**ids,decision="denied_by_policy",source="host",reason="host_reported_other")),
 ('recovery_token.used',AR('recovery_token.used',actionId=C,parentActionId=A,recoveryAction="restore",taskId="task-1",decision="approved",targetHash=B,outcome="executed")),
 ('recovery_token.rejected any action name',AR('recovery_token.rejected',actionId=C,parentActionId=A,recoveryAction="close_window",taskId="task-1",decision="denied_by_policy",reason="recovery_action_forbidden",targetHash=B,outcome="denied")),
 ('env.scrub ok',AR('env.scrub',env=E(),outcome="ok")),
 ('env.scrub canary present',AR('env.scrub',env=E(canary="present"),outcome="canary_detected")),
 ('server_request.unknown',AR('server_request.unknown',wireReply="error_32601",outcome="rejected",reason="unknown_method")),
 ('auth.url_check rejected',AR('auth.url_check',reason="host",outcome="rejected")),
 ('policy.denied schema_invalid with actionId null (ruling 1e)',AR('policy.denied',taskId="task-1",toolId="explorer.open_known_folder",actionId=None,decision="denied_by_policy",reason="schema_invalid",outcome="denied")),
 ('policy.denied schema_invalid minimal',AR('policy.denied',taskId="task-1",toolId="explorer.open_known_folder",actionId=None,reason="schema_invalid")),
 ('redactor.fallback',{"kind":"redactor.fallback","eventId":"ev-9","error":"TypeError"}),
]
for n,v in valid: add('AuditRecord',n,v,True)
inv=[('version 2',dict(resolved,version=2)),('event schema',dict(resolved,schema="dottie.event")),('unknown kind',AR('approval.granted')),
 ('raw args key',dict(resolved,args={"command":"rm"})),('token key',dict(resolved,token="x")),('policy.denied with reply_sent',AR('policy.denied',decision="denied_by_policy",reason="locked",outcome="reply_sent")),
 ('tool_token.revoked with an outcome',dict(revoked,outcome="denied")),('tool_token.revoked reason lock',dict(revoked,reason="lock")),
 ('tool_token.revoked without resolvedAt',{k:v for k,v in revoked.items() if k!="resolvedAt"}),('tool_token.revoked decision cancelled',dict(revoked,decision="cancelled")),
 ('toolhost taskId null',AR('toolhost.peer_rejected',taskId=None,decision="denied_by_policy",reason="sid_mismatch",outcome="denied")),('toolhost with taskId',AR('toolhost.peer_rejected',taskId="task-1",decision="denied_by_policy",reason="sid_mismatch",outcome="denied")),('toolhost with actionId',AR('toolhost.pipe_squatted',actionId=A,decision="denied_by_policy",reason="name_exists",outcome="refused_start")),
 ('tool_token.minted without toolId',AR('tool_token.minted',actionId=A,taskId="task-1",decision="approved",outcome="minted")),('host_refused without source',AR('tool_call.host_refused',**ids,decision="denied_by_policy",reason="locked")),
 ('host_refused without reason',AR('tool_call.host_refused',**ids,decision="denied_by_policy",source="host")),('host_refused unvalidated reason',AR('tool_call.host_refused',**ids,decision="denied_by_policy",source="host",reason="window_was_gone")),
 ('source on approval.resolved',dict(resolved,source="host")),('parentActionId on approval.resolved',dict(resolved,parentActionId=B)),
 ('recovery_token.used close_window',AR('recovery_token.used',actionId=C,parentActionId=A,recoveryAction="close_window",taskId="task-1",decision="approved",targetHash=B,outcome="executed")),
 ('server_request.unknown decline',AR('server_request.unknown',wireReply="decline",outcome="rejected")),('env on approval.resolved',dict(resolved,env=E())),
 ('env.scrub without env',AR('env.scrub',outcome="ok")),('canary present, outcome ok',AR('env.scrub',env=E(canary="present"),outcome="ok")),
 ('canary absent, outcome canary_detected',AR('env.scrub',env=E(canary="absent"),outcome="canary_detected")),
 ('PATH listed as sensitive',AR('env.scrub',env=E(removedSensitiveNames=["OPENAI_API_KEY","PATH"]),outcome="ok")),
 ('env without canary',AR('env.scrub',env={k:v for k,v in envs.items() if k!="canary"},outcome="ok")),('env values leaked',AR('env.scrub',env=E(values={"PATH":"C:\\x"}),outcome="ok")),
 ('displayHash on policy.denied',AR('policy.denied',**ids,decision="denied_by_policy",reason="display_unavailable",outcome="denied",displayHash=B)),
 ('joinedTo on tool_token.rejected',AR('tool_token.rejected',**ids,decision="denied_by_policy",reason="duplicate_request",outcome="denied",joinedTo="evt-first")),
 ('displayHash uppercase',dict(resolved,displayHash=B.upper())),('joinedTo empty',dict(resolved,joinedTo="")),
 ('reason not snake_case',dict(resolved,reason="UserDeclined")),('decision denied',dict(resolved,decision="denied")),('wireReply acceptForSession',dict(resolved,wireReply="acceptForSession")),
 ('timestamp without offset',dict(resolved,timestamp="2026-10-19T01:50:00")),('act- actionId',dict(resolved,actionId="act-1",argsHash="act-1")),('toolId without area',AR('tool_token.minted',actionId=A,taskId="task-1",toolId="open_known_folder",decision="approved",outcome="minted")),
 ('fallback with message',{"kind":"redactor.fallback","eventId":"ev-9","error":"TypeError","message":"secret"}),('fallback error with text',{"kind":"redactor.fallback","eventId":"ev-9","error":"TypeError: C:\\Users\\gopi"}),
 ('fallback without eventId',{"kind":"redactor.fallback","error":"TypeError"}),('missing correlationId',{k:v for k,v in resolved.items() if k!="correlationId"}),
 ('unknown category',dict(resolved,category="delete_everything")),('unknown channel',dict(resolved,channel="email")),('reason with a trailing newline',dict(resolved,reason="user_declined\n")),('array',[resolved]),
 ('field_stripped with channel',AR('input.field_stripped',**fs,channel="voice")),('field_stripped with actionId',AR('input.field_stripped',**fs,actionId=A)),
 ('field_stripped with toolId',AR('input.field_stripped',**fs,toolId="explorer.open_known_folder")),('field_stripped with outcome',AR('input.field_stripped',**fs,outcome="denied")),
 ('field_stripped with the injected value',AR('input.field_stripped',**fs,value="task_0")),('field_stripped with argsHash',AR('input.field_stripped',**fs,argsHash=A)),
 ('field_stripped without sourceChannel',AR('input.field_stripped',**{k:v for k,v in fs.items() if k!="sourceChannel"})),('field_stripped without field',AR('input.field_stripped',**{k:v for k,v in fs.items() if k!="field"})),
 ('field_stripped field text',AR('input.field_stripped',**dict(fs,field="text"))),('field_stripped sourceChannel renderer',AR('input.field_stripped',**dict(fs,sourceChannel="renderer"))),
 ('field_stripped reason injected',AR('input.field_stripped',**dict(fs,reason="injected"))),('field_stripped without decision',AR('input.field_stripped',**{k:v for k,v in fs.items() if k!="decision"})),
 ('field_stripped decision declined',AR('input.field_stripped',**dict(fs,decision="declined"))),('field on approval.resolved',dict(resolved,field="retryOfTaskId")),
 ('sourceChannel on approval.resolved',dict(resolved,sourceChannel="voice_worker")),
 ('tool_token.minted refused approved',AR('tool_token.minted',**ids,decision="approved",outcome="refused")),('tool_token.minted minted denied',AR('tool_token.minted',**ids,decision="denied_by_policy",outcome="minted")),
 ('tool_token.minted without outcome',AR('tool_token.minted',**ids,decision="approved")),('tool_token.minted refused without decision',AR('tool_token.minted',**ids,outcome="refused")),
 ('tool_token.consumed denied_by_policy',AR('tool_token.consumed',**ids,decision="denied_by_policy",outcome="consumed")),
 ('toolhost without decision',AR('toolhost.peer_rejected',reason="sid_mismatch",outcome="denied")),('host_refused approved',AR('tool_call.host_refused',**ids,decision="approved",source="host",reason="locked")),
 ('decision allowed',dict(resolved,decision="allowed")),
 ('tool-host policy.denied without actionId',AR('policy.denied',taskId="task-1",toolId="explorer.open_known_folder",decision="denied_by_policy",reason="locked",outcome="denied")),
 ('tool-host approval.requested without taskId',AR('approval.requested',actionId=A,toolId="explorer.open_known_folder",outcome="displayed")),
 ('schema_invalid with a hash actionId',AR('policy.denied',taskId="task-1",toolId="explorer.open_known_folder",actionId=A,reason="schema_invalid")),
 ('schema_invalid without actionId',AR('policy.denied',taskId="task-1",toolId="explorer.open_known_folder",reason="schema_invalid")),
 ('schema_invalid without toolId',AR('policy.denied',taskId="task-1",actionId=None,reason="schema_invalid")),
 ('schema_invalid with argsHash',AR('policy.denied',taskId="task-1",toolId="explorer.open_known_folder",actionId=None,argsHash=A,reason="schema_invalid")),
 ('schema_invalid with category',AR('policy.denied',taskId="task-1",toolId="explorer.open_known_folder",actionId=None,category="navigate",reason="schema_invalid")),
 ('policy.denied approved',AR('policy.denied',decision="approved",reason="locked",outcome="denied")),
 ('recovery_token.used without targetHash',AR('recovery_token.used',actionId=C,parentActionId=A,recoveryAction="restore",taskId="task-1",decision="approved",outcome="executed")),
 ('duplicate kept names',AR('env.scrub',env=E(keptNames=["PATH","PATH"],keptCount=2),outcome="ok")),
 ('actionId null on approval.resolved',dict(resolved,actionId=None,argsHash=A)),('actionId null on policy.denied locked',AR('policy.denied',taskId="task-1",actionId=None,decision="denied_by_policy",reason="locked",outcome="denied"))]
for n,v in inv: add('AuditRecord',n,v,False,True)
tsonly=[('argsHash differs from actionId',dict(resolved,argsHash=B)),('impossible date',dict(resolved,timestamp="2026-13-40T01:50:00Z")),
 ('keptNames unsorted',AR('env.scrub',env=E(keptNames=["SystemRoot","PATH"]),outcome="ok")),('keptCount mismatch',AR('env.scrub',env=E(keptCount=5),outcome="ok")),
 ('removedCount mismatch',AR('env.scrub',env=E(removedCount=2),outcome="ok")),('approval token value in a field',dict(resolved,correlationId="k8t1.AAAAAAAAAAAAAAAAAAAAAA.BBBB")),
 ('recovery token value in a field',dict(resolved,eventId="see k8r1.abc.def")),('over 16 KB',dict(resolved,eventId="e"*17000)),('joinedTo names itself',dict(resolved,joinedTo=resolved['eventId']))]
for n,v in tsonly: add('AuditRecord',n,v,False,False)
doc={"_readme":["Differential fixtures for src/records.ts and schemas/*.schema.json (E01 2026-10-19 addition 3).",
 "valid: both the TS validator and the JSON Schema accept. Invalid with schemaRejects:true: both reject.",
 "Invalid with schemaRejects:false: only the TS validator rejects (a rule JSON Schema can't express; see the schema $comment).",
 "Python consumers: scripts/check_records_schemas.py (needs the jsonschema package)."],"cases":cases}
open('fixtures/records/cases.json','w').write(json.dumps(doc,indent=1,ensure_ascii=True)+"\n")
print(len(cases), sum(c['valid'] for c in cases), sum((not c['valid']) and c['schemaRejects'] for c in cases), sum((not c['valid']) and not c['schemaRejects'] for c in cases))
