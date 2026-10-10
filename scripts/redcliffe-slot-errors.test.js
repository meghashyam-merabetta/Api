import test from 'node:test';
import assert from 'node:assert/strict';
import { env } from '../src/config/env.js';
import { providerRequest, paths } from '../src/app/redcliffe-labs/client.js';
import { normalizeSlots } from '../src/app/redcliffe-labs/slots.js';
test('non-serviceable slot responses open the serviceability flow for success and error shapes', () => {
 for (const body of [
  {status:'success',message:'Location is not serviceable',results:[]},
  {status:'failure',error:'Location is unserviceable'},
  {status:'failure',detail:'Location is non-serviceable'},
  {status:'success',is_serviceable:false,results:[]},
  {status:'failure',data:{message:'Location not servicable'}},
 ]) assert.equal(normalizeSlots(body,'2026-10-08').serviceable,false);
});
test('slot errors retain provider message and HTTP status, HTML gateway errors have readable fallback', async () => {
 const base=env.REDCLIFFE_BASE_URL,key=env.REDCLIFFE_API_KEY;
 try {
 env.REDCLIFFE_BASE_URL='https://provider.example';env.REDCLIFFE_API_KEY='private-test-key';
 await assert.rejects(providerRequest(paths.slots,{fetchImpl:async()=>Response.json({message:'Slots temporarily unavailable'},{status:504})}),e=>e.status===504 && e.message==='Slots temporarily unavailable');
 await assert.rejects(providerRequest(paths.slots,{fetchImpl:async()=>new Response('<html>Gateway Timeout</html>',{status:504})}),e=>e.status===504 && e.message==='504 Gateway Timeout');
 } finally {env.REDCLIFFE_BASE_URL=base;env.REDCLIFFE_API_KEY=key;}
});
