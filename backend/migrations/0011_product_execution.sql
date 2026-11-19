ALTER TABLE product_tasks ADD COLUMN automatic_finished_at timestamptz;
CREATE TABLE product_execution_slot (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    task_id uuid REFERENCES product_tasks(task_id) ON DELETE SET NULL
);
INSERT INTO product_execution_slot(singleton) VALUES (true);
CREATE TABLE product_edit_runs (
    run_id uuid PRIMARY KEY,
    task_id uuid NOT NULL REFERENCES product_tasks(task_id) ON DELETE CASCADE,
    node_key text NOT NULL CHECK (node_key IN ('initial_fill','attribute_fill','product_info_fill','sales_fill','images')),
    mode text NOT NULL CHECK (mode IN ('automatic','manual')),
    status text NOT NULL CHECK (status IN ('queued','running','succeeded','failed')),
    input_draft_version integer,
    output_draft_version integer,
    data jsonb NOT NULL DEFAULT '{}',
    error text,
    created_at timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz
);
CREATE UNIQUE INDEX product_edit_runs_active ON product_edit_runs(task_id,node_key) WHERE status IN ('queued','running');
CREATE UNIQUE INDEX product_edit_runs_automatic ON product_edit_runs(task_id,node_key) WHERE mode='automatic';
