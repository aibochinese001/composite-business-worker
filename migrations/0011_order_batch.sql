-- 合并下单：子订单关联主订单号
ALTER TABLE product_orders ADD COLUMN batch_no TEXT DEFAULT '';
