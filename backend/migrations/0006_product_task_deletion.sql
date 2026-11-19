CREATE OR REPLACE FUNCTION product_draft_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' AND current_setting('app.deleting_product_task', true) = OLD.task_id::text THEN
        RETURN OLD;
    END IF;
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'product_draft_immutable';
END;
$$;

CREATE OR REPLACE FUNCTION product_operation_lock() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF current_setting('app.deleting_product_task', true) = OLD.task_id::text THEN
            PERFORM 1 FROM product_tasks WHERE task_id = OLD.task_id FOR UPDATE;
            RETURN OLD;
        END IF;
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'product_operation_history_required';
    END IF;
    IF TG_OP = 'UPDATE' AND (NEW.task_id, NEW.operation_id) IS DISTINCT FROM (OLD.task_id, OLD.operation_id) THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'product_operation_identity_immutable';
    END IF;
    PERFORM 1 FROM product_tasks WHERE task_id = NEW.task_id FOR UPDATE;
    RETURN NEW;
END;
$$;
