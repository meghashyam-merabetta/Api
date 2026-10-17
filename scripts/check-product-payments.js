import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {models} from '../src/models/index.js';
import {sequelize} from '../src/config/database.js';
import {env} from '../src/config/env.js';
import {createOrder,findOrder,syncOrder,paise,verifiedStatus} from '../src/app/orders/orders.controller.js';
import {paymentWebhook} from '../src/app/hdfc/callbacks.js';
const couponCode="CHECK_"+randomUUID().replaceAll("-", "").toUpperCase();
const customerId=randomUUID();const saved={...env};const original=global.fetch;let id,calls=0,amount;
try{
 Object.assign(env,{HDFC_ENVIRONMENT:'sandbox',HDFC_API_KEY:'mocksecret',HDFC_MERCHANT_ID:'mockmerchant',HDFC_CLIENT_ID:'hdfcmaster',HDFC_RETURN_URL:'https://merchant.example/api/payments/hdfc/return',HDFC_WEBHOOK_USER:'hook',HDFC_WEBHOOK_PASSWORD:'secret'});
 const customer=await models.customer.create({id:customerId,firstName:'Payment',lastName:'Test',phone:'9876543210',email:'test@example.com'});
 global.fetch=async(url,options)=>{
 assert.equal(options.headers.Authorization,'Basic '+Buffer.from('mocksecret').toString('base64'));
 if(options.method==='POST'){calls++;const b=JSON.parse(options.body);id=b.order_id;amount=b.amount;assert.equal(b.currency,'INR');return Response.json({order_id:id,payment_links:{web:'https://smartgateway.hdfcuat.bank.in/payment-page/mock'}});}
 return Response.json({order_id:id,merchant_id:'mockmerchant',currency:'INR',amount,status:'CHARGED',txn_id:'mocktxn'});
 };
 const req={credential:customer.get({plain:true}),validated:{requestKey:randomUUID(),items:[{id:'p1',quantity:2}],address:{line1:'House 2 Test Road',city:'Pune',state:'Maharashtra',postalCode:'411001'},notes:'',coupon:false}};
 let result;const res={status(){return this;},json(value){result=value;}};
 await createOrder(req,res);assert.equal(result.paymentStatus,'Pending');assert.equal(result.total,144);assert.ok(result.paymentUrl);
 await createOrder(req,res);assert.equal(calls,1);
 await createOrder({...req,validated:{...req.validated,requestKey:randomUUID()}},res);assert.equal(calls,1);
 const [details]=await sequelize.query('SELECT * FROM order_details WHERE order_id=:id',{replacements:{id}});assert.equal(details.length,1);assert.equal(details[0].quantity,2);
 const before=await findOrder(id,customerId);
 assert.throws(()=>verifiedStatus(before,{order_id:id,merchant_id:'mockmerchant',currency:'INR',amount:'1',status:'CHARGED'}),/could not be verified/);
 assert.equal(paise('100.15'),10015);assert.throws(()=>paise('1.001'));
 await assert.rejects(findOrder(id,randomUUID()),/not found/);
 await assert.rejects(paymentWebhook({get:()=>'',body:{}},res),/Invalid webhook/);
 const paid=await syncOrder(before);assert.equal(paid.payment_status,'CHARGED');assert.equal(paid.payload.status,'Processing');assert.equal(paid.payload.paymentStatus,'Paid');
 await paymentWebhook({get:()=> 'Basic '+Buffer.from('hook:secret').toString('base64'),body:{content:{order:{order_id:id,status:'FAILED'}}}},res);
 assert.equal((await findOrder(id)).payment_status,'CHARGED');
 await sequelize.query("INSERT INTO coupons(code,scope,percent,max_discount_paise,active) VALUES(:code,'both',10,10000,true)",{replacements:{code:couponCode}});
 await createOrder({...req,validated:{...req.validated,requestKey:randomUUID(),couponCode}},res);
 assert.equal(result.discount,10.4);assert.equal(result.total,133.6);assert.equal(amount,'133.60');assert.equal(result.couponCode,couponCode);
 console.log('PASS: DB order/details, server pricing, session idempotency, amount verification, ownership, webhook authentication, paid-state protection. No real payments sent.');
}finally{
 global.fetch=original;Object.assign(env,saved);
 await sequelize.query('DELETE FROM order_details WHERE order_id IN (SELECT id FROM orders WHERE customer_id=:id)',{replacements:{id:customerId}});
 await sequelize.query('DELETE FROM orders WHERE customer_id=:id',{replacements:{id:customerId}});
 await models.customer.destroy({where:{id:customerId},force:true});await sequelize.query('DELETE FROM coupons WHERE code=:code',{replacements:{code:couponCode}});await sequelize.close();
}
