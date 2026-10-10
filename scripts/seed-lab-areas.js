import { readFileSync } from 'node:fs';
import { sequelize } from '../src/config/database.js';
const areas=JSON.parse(readFileSync(new URL('../seed/lab-service-areas.demo.json',import.meta.url),'utf8'));
try { await sequelize.transaction(async transaction=>{for(const a of areas) await sequelize.query('INSERT INTO lab_service_areas(id,name,city,state,postal_code,lab_ids) VALUES(:id,:name,:city,:state,:postalCode,CAST(:labIds AS jsonb)) ON CONFLICT DO NOTHING',{replacements:{...a,labIds:JSON.stringify(a.labIds)},transaction});}); console.log('Dummy service areas ready.'); } finally {await sequelize.close();}
