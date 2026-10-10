import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { models } from '../src/models/index.js';
import { sequelize } from '../src/config/database.js';
import { createCustomerSession } from '../src/shared/customer-session.js';
const id=randomUUID();
try {
 await models.customer.create({id,firstName:'Temporary schema check'});
 const token=await createCustomerSession(id,{validated:{},get:()=>'',ip:'127.0.0.1'});
 const headers={'Content-Type':'application/json','X-App-Client':'native',Authorization:'Bearer '+token};
 const payload={name:'Temporary Member',relationship:'Mother',phone:'',dateOfBirth:'1961-01-01',gender:'Female'};
 const response=await fetch('http://localhost:3000/api/app/customers/me/family-members',{method:'POST',headers,body:JSON.stringify(payload)});
 const data=await response.json();
 if(response.status!==201){console.log('Create status:',response.status,'Error:',data.error,JSON.stringify(data.details));process.exitCode=1;}
 else {
 const member=data.members.find(m=>m.name===payload.name);
 assert.equal(member.dateOfBirth,payload.dateOfBirth);assert.equal(member.gender,'Female');assert.equal(typeof member.age,'number');
 const edited=await fetch('http://localhost:3000/api/app/customers/me/family-members/'+member.id,{method:'PUT',headers,body:JSON.stringify({...payload,dateOfBirth:'1962-02-03',gender:'Other'})});
 assert.equal(edited.status,200);const updated=(await edited.json()).members.find(m=>m.id===member.id);assert.equal(updated.dateOfBirth,'1962-02-03');assert.equal(updated.gender,'Other');
 console.log('PASS: live API adds and edits family members with birthdate, gender and calculated age.');
 }
} finally {
 await models.customerFamilyMember.destroy({where:{customerId:id},force:true});
 await models.customerLoginLog.destroy({where:{customerId:id},force:true});
 await models.customer.destroy({where:{id},force:true});
 await sequelize.close();
}
