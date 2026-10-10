import test from 'node:test';
import assert from 'node:assert/strict';
import { sequelize } from '../src/config/database.js';
import { env } from '../src/config/env.js';
import { refreshBooking, cancelBooking } from '../src/app/redcliffe-labs/status.js';
test('status sync matches the provider ID and cancellation uses owned booking and exact payload', async () => {
 const query=sequelize.query, fetchOld=global.fetch, base=env.REDCLIFFE_BASE_URL, key=env.REDCLIFFE_API_KEY;
 const row={id:'local',provider_booking_id:'123',integration_status:'confirmed',payload:{id:'local',status:'Confirmed'}};
 try {
  env.REDCLIFFE_BASE_URL='https://provider.example';env.REDCLIFFE_API_KEY='test';
  sequelize.query=async(sql,options)=> sql.startsWith('SELECT') ? [row] : sql.includes('RETURNING payload') ? [{payload:JSON.parse(options.replacements.payload)}] : [{id:'local'}];
  global.fetch=async(url,_options)=>{assert.equal(url.searchParams.get('booking_id'),'123');return Response.json({status:'Success',data:[{booking_id:999,booking_status:{value:'Wrong'}},{booking_id:123,booking_status:{value:'Phlebo Assigned'}}]});};
  assert.equal((await refreshBooking(row)).status,'Phlebo Assigned');
  global.fetch=async(url,options)=>{assert.deepEqual(JSON.parse(options.body),{booking_id:123,booking_status:'cancelled',remark:'Unavailable'});return Response.json({status:'success',booking_id:123,booking_status:'cancelled'});};
  let result;
  await cancelBooking({credential:{id:'customer'},validatedParams:{id:'local'},validated:{reason:'Unavailable'}},{json:data=>{result=data;}});
  assert.equal(result.status,'Cancelled');
  sequelize.query=async()=>[];
  global.fetch=async()=>{throw Error('Must not contact provider for unowned booking');};
  await assert.rejects(cancelBooking({credential:{id:'other'},validatedParams:{id:'local'}},{}),/Booking not found/);
 } finally {sequelize.query=query;global.fetch=fetchOld;env.REDCLIFFE_BASE_URL=base;env.REDCLIFFE_API_KEY=key;}
});

