CREATE TABLE IF NOT EXISTS customer_cart_items (
 customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
 item_id varchar(100) NOT NULL,
 quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 99),
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(customer_id,item_id)
);
CREATE TABLE IF NOT EXISTS customer_wishlist_items (
 customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
 item_id varchar(100) NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(customer_id,item_id)
);
