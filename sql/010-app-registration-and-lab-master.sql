ALTER TABLE customers ADD COLUMN IF NOT EXISTS is_app_register boolean NOT NULL DEFAULT false;

UPDATE customer_family_members
SET age = EXTRACT(YEAR FROM age((CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date, date_of_birth))::integer
WHERE date_of_birth IS NOT NULL;

UPDATE labs SET active = (id = 'redcliffe');
