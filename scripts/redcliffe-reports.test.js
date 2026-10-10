import test from 'node:test';import assert from 'node:assert/strict';
import {reportsFromBooking,downloadReport,reportUrl} from '../src/app/redcliffe-labs/reports.js';import {sequelize} from '../src/config/database.js';
test('owned report download, URL allowlist and PDF validation',async()=>{
 assert.equal(reportUrl('http://127.0.0.1/report.pdf'),null);
 const reports=reportsFromBooking({report:[{report_link:'https://redcliffelabsbackend.s3.amazonaws.com/media/test.pdf',status:'partial'}]});assert.equal(reports[0].label,'Partial report');
 const query=sequelize.query,fetchOld=global.fetch;let owned=true;
 try{sequelize.query=async(sql,opts)=>{if(sql.startsWith('SELECT')){assert.equal(opts.replacements.customer,'owner');return owned?[{payload:{reports}}]:[];}return [];};
 global.fetch=async()=>new Response('%PDF-1.7\nMock report');
 const req={credential:{id:'owner'},validatedParams:{id:'booking',reportId:reports[0].id}};let output;await downloadReport(req,{set(){return this;},json(value){output=value;}});assert.equal(Buffer.from(output.base64,'base64').toString(),'%PDF-1.7\nMock report');
 owned=false;await assert.rejects(downloadReport(req,{}),/not available/);
 owned=true;global.fetch=async()=>new Response('<html>Error</html>');await assert.rejects(downloadReport(req,{}),/valid PDF/);
 }finally{sequelize.query=query;global.fetch=fetchOld;}
});
