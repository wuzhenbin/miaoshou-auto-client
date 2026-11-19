-- Preserve the existing owner as slot 1; no work or external request is replayed.
ALTER TABLE product_execution_slot DROP CONSTRAINT product_execution_slot_pkey;
ALTER TABLE product_execution_slot DROP COLUMN singleton;
ALTER TABLE product_execution_slot ADD COLUMN slot_id integer NOT NULL DEFAULT 1;
ALTER TABLE product_execution_slot ADD PRIMARY KEY (slot_id);
ALTER TABLE product_execution_slot ADD CHECK (slot_id > 0);
ALTER TABLE product_execution_slot ADD UNIQUE (task_id);
INSERT INTO product_execution_slot(slot_id) VALUES (2),(3);
