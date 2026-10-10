import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { sequelize } from '../src/config/database.js';
import { models } from '../src/models/index.js';
import { createBooking, listBookings } from '../src/app/bookings/bookings.controller.js';
import { bookingSchema } from '../src/app/bookings/bookings.routes.js';
import { collectionDays } from '../src/app/bookings/collection-slots.js';
const customerId=randomUUID();
let result;
const response={status(){return this;},json(value){result=value;}};
try {
 await models.customer.create({id:customerId,firstName:'Booking test',lastName:'Temporary'});
 const member=await models.customerFamilyMember.create({customerId,name:'Temporary patient',relationship:'Self',dateOfBirth:'1990-01-01',gender:'Other',age:36});
 const body={requestKey:'integration-'+randomUUID(),memberId:member.id,address:{line1:'10 Test Street',line2:'',state:'Maharashtra',city:'Pune',postalCode:'411045'},collectionDate:collectionDays()[1].date,slotId:'07-09',items:[{id:'l1',quantity:1}]};
 const req={credential:{id:customerId},validated:bookingSchema.parse(body)};
 assert.equal(bookingSchema.safeParse({...body,items:[body.items[0],body.items[0]]}).success,false);
 await createBooking(req,response); const first=result;
 assert.equal(first.kind,'labs');assert.equal(first.status,'Booking created');assert.equal(first.total,999);
 await createBooking(req,response);assert.equal(result.id,first.id);
 await listBookings({credential:{id:customerId}},response);assert.equal(result.data.length,1);
 await listBookings({credential:{id:randomUUID()}},response);assert.equal(result.data.length,0);
 await createBooking({...req,validated:{...req.validated,requestKey:randomUUID(),address:{...req.validated.address,city:'Mumbai',postalCode:'400001'}}},response);
 assert.ok(result.address.includes('Mumbai'));assert.ok(result.address.includes('400001'));
 assert.equal(result.items[0].area,undefined);
 assert.equal(result.collectionDate,body.collectionDate);
 assert.equal(result.slotId,'07-09');
 assert.equal(bookingSchema.safeParse({...body,address:{...body.address,postalCode:'123'}}).success,false);
 await assert.rejects(createBooking({...req,validated:{...req.validated,requestKey:randomUUID(),memberId:randomUUID()}},response),/saved family member/);
 console.log('PASS: bookings without serviceability, persistence, retry idempotency, collection schedule, address validation, ownership, duplicate item rejection.');
} finally {
 await sequelize.query('DELETE FROM lab_bookings WHERE customer_id=:id',{replacements:{id:customerId}});
 await models.customerFamilyMember.destroy({where:{customerId},force:true});
 await models.customer.destroy({where:{id:customerId},force:true});
 await sequelize.close();
}
