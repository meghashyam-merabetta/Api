import test from 'node:test';
import assert from 'node:assert/strict';
import {amendBooking,editableBooking} from '../src/app/redcliffe-labs/amendment.js';
import {sequelize} from '../src/config/database.js';
import {models} from '../src/models/index.js';
import {env} from '../src/config/env.js';
test('amendment preserves tests, saves new member, blocks assigned bookings and repeated uncertain writes',async()=>{
 const oldQuery=sequelize.query,oldFetch=global.fetch,oldMember=models.customerFamilyMember.findOne,base=env.REDCLIFFE_BASE_URL,key=env.REDCLIFFE_API_KEY;
 let row,posted,fail=false,assigned=false,calls=0;
 const reset=()=>{row={id:'local',member_id:'primary',provider_booking_id:'123',integration_status:'confirmed',payload:{id:'local',status:'Confirmed',total:100,items:[{id:'old',quantity:1,snapshot:{packageCode:'OLD',price:100}}]}};};
 try {
 env.REDCLIFFE_BASE_URL='https://provider.example';env.REDCLIFFE_API_KEY='test';reset();
 sequelize.query=async(sql,opts)=>{
  const r=opts?.replacements;
  if(sql.includes('FROM lab_bookings WHERE') && sql.startsWith('SELECT'))return [structuredClone(row)];
  if(sql.includes('SELECT catalog_data'))return [{catalog_data:{packageCode:'NEW',price:50,name:'New test'}}];
  if(sql.includes("integration_status='updating'")){row.integration_status='updating';row.amendment=JSON.parse(r.amendment);return [{id:'local'}];}
  if(sql.includes("integration_status='update_unknown'"))row.integration_status='update_unknown';
  if(sql.includes("integration_status='confirmed',payload")){row.integration_status='confirmed';row.payload=JSON.parse(r.payload);row.amendment=JSON.parse(r.amendment);}
  return [];
 };
 models.customerFamilyMember.findOne=async()=>({id:'member',name:'Test Member',gender:'Female',dateOfBirth:'1990-01-01'});
 global.fetch=async(url,options)=>{
  if(options.method==='GET')return Response.json({status:'success',data:[{booking_id:123,booking_status:{value:assigned?'Phlebo Assigned':'order booked'}}]});
  calls++;posted=JSON.parse(options.body);if(fail)throw Error('timeout');return Response.json({status:'success',booking_id:123});
 };
 let result;const res={json:value=>{result=value;}};
 const req={credential:{id:'customer'},validatedParams:{id:'local'},validated:{requestKey:'key',testIds:['new']}};
 await amendBooking(req,res);assert.deepEqual(posted.packages,['OLD','NEW']);assert.equal(result.total,150);assert.equal(result.totalEstimated,true);
 await amendBooking(req,res);assert.equal(calls,1);
 reset();await amendBooking({...req,validated:{...req.validated,memberId:'member'}},res);assert.equal(posted.additional_member[0].packages[0],'NEW');assert.equal(result.additionalMembers[0].name,'Test Member');assert.equal(result.items.length,1);
 reset();assigned=true;await assert.rejects(amendBooking(req,res),/before a collection agent/);assigned=false;
 fail=true;await assert.rejects(amendBooking(req,res),/not confirmed/);const previous=calls;await assert.rejects(amendBooking(req,res),/verification/);assert.equal(calls,previous);
 assert.equal(editableBooking({booking_status:'sample collected'}),false);
 }finally{sequelize.query=oldQuery;global.fetch=oldFetch;models.customerFamilyMember.findOne=oldMember;env.REDCLIFFE_BASE_URL=base;env.REDCLIFFE_API_KEY=key;}
});
