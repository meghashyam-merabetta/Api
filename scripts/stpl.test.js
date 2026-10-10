import test from 'node:test';import assert from 'node:assert/strict';
import {env} from '../src/config/env.js';import {sendLoginOtp,stplConfig} from '../src/app/stpl/client.js';
test('STPL form encoding, country code, accepted response and failure handling',async()=>{
 const old={...env};const logs=[];
 try{
 Object.assign(env,{STPL_BASE_URL:'https://sms.example',STPL_USERNAME:'user',STPL_PASSWORD:'secret&value',STPL_SENDER_ID:'MERABT',STPL_TEMPLATE_ID:'template',STPL_DLT_CONTENT_ID:'dlt',STPL_OTP_TEMPLATE:'Your OTP is {otp}. Do not share.',STPL_UNICODE:'false'});
 env.STPL_SENDER_ID='TEST55';
 assert.equal(stplConfig().pathname,'/sms-api/v2/send/');
 env.STPL_SENDER_ID='TEST!5';assert.throws(stplConfig,/configuration/);
 env.STPL_SENDER_ID='TEST55';
 const logCall=async e=>logs.push(e);
 const accepted=await sendLoginOtp('9876543210','123456','test-id',{logCall,fetchImpl:async(url,options)=>{
 assert.equal(url.pathname,'/sms-api/v2/send/');assert.equal(url.search,'');assert.equal(options.redirect,'error');const data=new URLSearchParams(options.body);assert.equal(data.get('from'),'TEST55');assert.equal(data.get('to'),'919876543210');assert.equal(data.get('password'),'secret&value');assert.equal(data.get('text'),'Your OTP is 123456. Do not share.');assert.equal(data.get('dltContentId'),'dlt');
 return Response.json({transactionId:27547042,state:'SUBMIT_ACCEPTED',pdu:1});}});
 assert.equal(accepted.transactionId,'27547042');assert.ok(!JSON.stringify(logs).includes('123456'));assert.ok(!JSON.stringify(logs).includes('secret&value'));
 await assert.rejects(sendLoginOtp('9876543210','123456','test-id',{logCall,fetchImpl:async()=>Response.json({state:'SUBMIT_FAILED'})}),/could not be sent/);
 await assert.rejects(sendLoginOtp('9876543210','123456','test-id',{logCall,fetchImpl:async()=>{throw new DOMException('timeout','TimeoutError');}}),/could not be confirmed/);
 env.STPL_BASE_URL='http://sms.example';assert.throws(stplConfig,/configuration/);
 }finally{Object.assign(env,old);}
});
