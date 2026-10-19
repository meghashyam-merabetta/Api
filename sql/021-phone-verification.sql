CREATE TABLE IF NOT EXISTS customer_phone_verifications (
 challenge_id uuid PRIMARY KEY REFERENCES customer_otp_challenges(id),
 customer_id uuid NOT NULL REFERENCES customers(id)
);
