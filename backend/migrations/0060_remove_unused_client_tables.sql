-- Retired tables must be empty before removal; older client databases may retain history.
DO $$
DECLARE
    table_name text;
    has_rows boolean;
BEGIN
    FOREACH table_name IN ARRAY ARRAY[
        'online_client_result_receipts',
        'size_template_command_progress',
        'product_size_image_cache',
        'product_source_attribute_cache',
        'product_attribute_fill_runs'
    ] LOOP
        IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = table_name) THEN
            EXECUTE format('SELECT EXISTS (SELECT 1 FROM public.%I)', table_name) INTO has_rows;
            IF has_rows THEN
                RAISE EXCEPTION 'retired_client_table_not_empty: %', table_name;
            END IF;
        END IF;
    END LOOP;
END;
$$;

DROP TABLE IF EXISTS online_client_result_receipts;
DROP TABLE IF EXISTS size_template_command_progress;
DROP TABLE IF EXISTS product_size_image_cache;
DROP TABLE IF EXISTS product_source_attribute_cache;
DROP TABLE IF EXISTS product_attribute_fill_runs;
DROP FUNCTION IF EXISTS product_attribute_fill_immutable();
