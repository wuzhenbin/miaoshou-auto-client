ALTER TABLE product_availability_checks DROP CONSTRAINT product_availability_checks_status_check;
ALTER TABLE product_availability_checks ADD CONSTRAINT product_availability_checks_status_check
    CHECK (status IN ('available', 'deleted', 'unbound'));
