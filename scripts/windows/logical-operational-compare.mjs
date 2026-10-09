import assert from 'node:assert/strict';
import { compare, normalize } from './logical-dump-compare.mjs';

export function compareScheduler(before, after) {
  const a=normalize(before),b=normalize(after);
  const prior=a.tables.get('public.job_queue'),current=b.tables.get('public.job_queue');
  assert.equal(prior.columns,current.columns);
  const columns=prior.columns.split(', '),id=columns.indexOf('id'),kind=columns.indexOf('kind'),payload=columns.indexOf('payload');
  assert.ok(id>=0&&kind>=0&&payload>=0);
  const oldRows=new Set(prior.rows),newRows=new Set(current.rows);
  assert.equal(oldRows.size,prior.rows.length);assert.equal(newRows.size,current.rows.length);
  assert.ok(prior.rows.every(row=>newRows.has(row)),'An existing queue row was removed or changed');
  const added=current.rows.filter(row=>!oldRows.has(row));
  const knownJobs=new Set(prior.rows.map(row=>{const fields=row.split('\t');return JSON.stringify([fields[kind],fields[payload]]);}));
  assert.ok(added.every(row=>{const fields=row.split('\t');return knownJobs.has(JSON.stringify([fields[kind],fields[payload]]));}),'New jobs do not match existing scheduler housekeeping');
  const pattern=/^SELECT pg_catalog\.setval\('public\.job_queue_id_seq', (\d+), true\);\r?$/gm;
  const oldState=[...before.toString().matchAll(pattern)],newState=[...after.toString().matchAll(pattern)];
  assert.equal(oldState.length,1);assert.equal(newState.length,1);
  const oldSequence=BigInt(oldState[0][1]),newSequence=BigInt(newState[0][1]);
  assert.equal(newSequence-oldSequence,BigInt(added.length),'Queue sequence does not match the new jobs');
  const newIds=new Set(added.map(row=>row.split('\t')[id]));
  assert.equal(newIds.size,added.length);
  for(let value=oldSequence+1n;value<=newSequence;value++)assert.ok(newIds.has(String(value)),'Queue sequence skipped an unaccounted job');
  const scheduleBefore=a.tables.get('public.schedules'),scheduleAfter=b.tables.get('public.schedules');
  assert.equal(scheduleBefore.columns,scheduleAfter.columns);assert.equal(scheduleBefore.rows.length,scheduleAfter.rows.length);
  const scheduleColumns=scheduleBefore.columns.split(', '),scheduleId=scheduleColumns.indexOf('id'),next=scheduleColumns.indexOf('next_run_at');
  assert.ok(scheduleId>=0&&next>=0);
  const originals=new Map(scheduleBefore.rows.map(row=>{const fields=row.split('\t');return[fields[scheduleId],fields];}));
  assert.equal(originals.size,scheduleBefore.rows.length);
  const seen=new Set();let schedulesAdvanced=0;
  for(const row of scheduleAfter.rows){
    const fields=row.split('\t'),original=originals.get(fields[scheduleId]);assert.ok(original);assert.ok(!seen.has(fields[scheduleId]));seen.add(fields[scheduleId]);
    assert.ok(fields[next]>=original[next],'A schedule time moved backwards');
    if(fields[next]!==original[next])schedulesAdvanced++;
    fields[next]=original[next];assert.deepEqual(fields,original,'A schedule field other than its next run time changed');
  }
  const canonical=Buffer.from(after.toString().replace(pattern,oldState[0][0]));
  const comparison=compare(before,canonical);
  assert.ok(comparison.schemaAndOtherSqlMatch,'Schema or another sequence changed');
  assert.ok(comparison.differences.every(item=>['public.job_queue','public.schedules'].includes(item.table)&&!item.columnsChanged),'Non-scheduler data changed');
  return {...comparison,passed:true,expectedOperationalChanges:true,existingQueueRowsUnchanged:true,newHousekeepingJobs:added.length,schedulesAdvanced,queueSequenceBefore:String(oldSequence),queueSequenceAfter:String(newSequence)};
}
