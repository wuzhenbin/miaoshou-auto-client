-- Existing product slots become form slots; existing requests are not replayed.
CREATE TABLE product_image_execution_slot (
    slot_id integer PRIMARY KEY CHECK (slot_id > 0),
    task_id uuid UNIQUE REFERENCES product_tasks(task_id) ON DELETE SET NULL,
    source_item_id text UNIQUE,
    run_id uuid REFERENCES product_edit_runs(run_id),
    CHECK ((task_id IS NULL) = (source_item_id IS NULL)),
    CHECK ((task_id IS NULL) = (run_id IS NULL))
);
