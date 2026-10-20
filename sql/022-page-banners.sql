CREATE TABLE IF NOT EXISTS page_banners (
 banner_key varchar(100) PRIMARY KEY,
 page_name varchar(100) NOT NULL,
 banner_name varchar(150) NOT NULL,
 image_path text NOT NULL,
 width_px integer NOT NULL CHECK(width_px BETWEEN 1 AND 10000),
 height_px integer NOT NULL CHECK(height_px BETWEEN 1 AND 10000),
 is_active boolean NOT NULL DEFAULT true
);
INSERT INTO page_banners(banner_key,page_name,banner_name,image_path,width_px,height_px) VALUES
 ('home-family','Home','Family care','campaign/family-care.png',1774,887),
 ('home-labs','Home','Home testing','campaign/home-testing.png',1774,887),
 ('home-essentials','Home','Everyday essentials','campaign/essentials.png',1774,887),
 ('labs-list','Labs','Lab listing','campaign/home-testing.png',1774,887),
 ('categories','Categories','Category essentials','campaign/essentials.png',1774,887),
 ('products-list','Products','Product offers','campaign/essentials.png',1774,887),
 ('lab-details','Lab Tests','Merabetta lab banner','campaign/home-testing.png',1774,887),
 ('booked-together','Frequently Booked Together','Explore lab tests','campaign/home-testing.png',1774,887)
ON CONFLICT(banner_key) DO NOTHING;
