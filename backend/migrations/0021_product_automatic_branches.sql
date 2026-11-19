CREATE TABLE product_automatic_branches (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    form boolean NOT NULL DEFAULT true,
    images boolean NOT NULL DEFAULT false
);
INSERT INTO product_automatic_branches(singleton) VALUES (true);
