ALTER TABLE customer_addresses ADD COLUMN IF NOT EXISTS latitude double precision;
ALTER TABLE customer_addresses ADD COLUMN IF NOT EXISTS longitude double precision;

UPDATE customer_addresses
SET latitude = (location->>'latitude')::double precision,
    longitude = (location->>'longitude')::double precision
WHERE jsonb_typeof(location->'latitude') = 'number'
  AND jsonb_typeof(location->'longitude') = 'number'
  AND (latitude IS NULL OR longitude IS NULL);
