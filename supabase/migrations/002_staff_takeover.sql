-- Staff takeover: allows staff to take over AI conversation
ALTER TABLE end_users ADD COLUMN is_staff_takeover BOOLEAN NOT NULL DEFAULT false;
