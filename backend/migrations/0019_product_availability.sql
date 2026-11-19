CREATE TABLE product_availability_checks (
    task_id uuid PRIMARY KEY REFERENCES product_tasks(task_id) ON DELETE CASCADE,
    temu_detail_id text NOT NULL,
    shop_id text NOT NULL,
    status text NOT NULL CHECK (status IN ('available', 'deleted')),
    checked_at timestamptz NOT NULL DEFAULT now()
);
