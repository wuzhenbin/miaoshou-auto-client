-- A revision belongs to each run; it does not acquire a parent-task row lock.
CREATE SEQUENCE product_execution_revision_seq;
ALTER TABLE product_edit_runs ADD COLUMN execution_revision bigint NOT NULL DEFAULT nextval('product_execution_revision_seq');
CREATE FUNCTION update_product_execution_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    NEW.execution_revision := nextval('product_execution_revision_seq');
    RETURN NEW;
END;
$$;
CREATE TRIGGER product_edit_run_revision BEFORE UPDATE ON product_edit_runs
    FOR EACH ROW EXECUTE FUNCTION update_product_execution_revision();
CREATE INDEX product_edit_runs_task_revision ON product_edit_runs(task_id, execution_revision DESC) WHERE NOT (data ? 'supersededBy');
CREATE INDEX product_edit_runs_task_latest ON product_edit_runs(task_id, node_key, created_at DESC, run_id DESC) WHERE NOT (data ? 'supersededBy');
