-- Freeze a product while remote deletion is outside the transaction. The durable
-- marker survives a lost response/restart; a repeat DELETE first rechecks the target.
ALTER TABLE product_tasks ADD COLUMN deletion_intent jsonb;
CREATE FUNCTION product_deletion_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.deletion_intent IS NOT NULL AND
        current_setting('app.deleting_product_task',true) IS DISTINCT FROM OLD.task_id::text THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='product_deletion_in_progress';
    END IF;
    IF TG_OP = 'UPDATE' AND NEW.deletion_intent IS DISTINCT FROM OLD.deletion_intent THEN
        NEW.version := OLD.version + 1;
        NEW.updated_at := clock_timestamp();
    END IF;
    RETURN COALESCE(NEW,OLD);
END;
$$;
CREATE TRIGGER product_tasks_deletion_guard BEFORE UPDATE OR DELETE ON product_tasks
    FOR EACH ROW EXECUTE FUNCTION product_deletion_guard();
CREATE INDEX product_edit_runs_active_task ON product_edit_runs(task_id,node_key,created_at,run_id)
    WHERE status IN ('queued','running');
CREATE INDEX product_edit_runs_initial_progress ON product_edit_runs(task_id,node_key,created_at,run_id)
    WHERE mode='automatic' AND node_key<>'detail_writeback' AND NOT (data ? 'supersededBy');
-- Direct child writes also respect the deletion reservation; row ownership is
-- checked before the write, so drafts/runs cannot appear after deletion admission.
CREATE FUNCTION product_deletion_child_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE deleting jsonb;
BEGIN
    IF TG_OP = 'INSERT' THEN
        -- New child admission serializes with deletion, before a child identity exists.
        SELECT deletion_intent INTO deleting FROM product_tasks WHERE task_id=NEW.task_id FOR UPDATE;
    ELSE
        -- Existing run updates already own the child row. Do not invert the
        -- normal task -> run lock order; admission requires no active children.
        SELECT deletion_intent INTO deleting FROM product_tasks WHERE task_id=NEW.task_id;
    END IF;
    IF deleting IS NOT NULL AND current_setting('app.deleting_product_task',true) IS DISTINCT FROM NEW.task_id::text THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='product_deletion_in_progress';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER task_drafts_deletion_guard BEFORE INSERT ON task_drafts FOR EACH ROW EXECUTE FUNCTION product_deletion_child_guard();
CREATE TRIGGER product_edit_runs_deletion_guard BEFORE INSERT OR UPDATE ON product_edit_runs FOR EACH ROW EXECUTE FUNCTION product_deletion_child_guard();
CREATE TRIGGER task_actions_deletion_guard BEFORE INSERT OR UPDATE ON task_actions FOR EACH ROW EXECUTE FUNCTION product_deletion_child_guard();
CREATE TRIGGER task_continuations_deletion_guard BEFORE INSERT OR UPDATE ON task_continuations FOR EACH ROW EXECUTE FUNCTION product_deletion_child_guard();
CREATE TRIGGER upstream_operations_deletion_guard BEFORE INSERT OR UPDATE ON upstream_operations FOR EACH ROW EXECUTE FUNCTION product_deletion_child_guard();
-- Full run history lookups do not imply mode='automatic' or active status, so
-- neither existing partial index can serve finishing/latest/absence checks.
CREATE INDEX product_edit_runs_task_history ON product_edit_runs(task_id,node_key,created_at DESC,run_id DESC) INCLUDE(status);
