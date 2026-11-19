-- Null means a legacy batch, not an invitation to bind the latest catalog.
ALTER TABLE task_batches ADD COLUMN autofill_binding jsonb
    CHECK (autofill_binding IS NULL OR COALESCE((
        jsonb_typeof(autofill_binding) = 'object'
        AND autofill_binding ?& ARRAY['status', 'catalog', 'hash']
        AND autofill_binding->>'status' IN ('bound', 'empty')
        AND (autofill_binding->>'hash') ~ '^[0-9a-f]{64}$'
        AND ((autofill_binding->>'status' = 'empty' AND autofill_binding->'catalog' = 'null'::jsonb)
             OR (autofill_binding->>'status' = 'bound' AND jsonb_typeof(autofill_binding->'catalog') = 'object'))
    ), false));
CREATE FUNCTION product_autofill_binding_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.autofill_binding IS DISTINCT FROM OLD.autofill_binding THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'product_autofill_binding_immutable';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER product_autofill_binding_immutable BEFORE UPDATE ON task_batches
    FOR EACH ROW EXECUTE FUNCTION product_autofill_binding_immutable();
