ALTER TABLE product_edit_runs DROP CONSTRAINT product_edit_runs_node_key_check;
ALTER TABLE product_edit_runs ADD CONSTRAINT product_edit_runs_node_key_check
    CHECK (node_key IN ('category_check','initial_fill','attribute_fill','product_info_fill','sales_fill','images','size_image','detail_writeback'));
