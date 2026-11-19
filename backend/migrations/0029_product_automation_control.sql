CREATE TABLE product_automation_control (
    id smallint PRIMARY KEY CHECK (id = 1),
    paused boolean NOT NULL DEFAULT false,
    updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO product_automation_control(id, paused) VALUES (1, false);
