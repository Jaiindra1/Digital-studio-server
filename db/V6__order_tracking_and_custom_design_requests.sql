ALTER TABLE client_orders MODIFY status VARCHAR(32) NOT NULL DEFAULT 'new';

CREATE TABLE IF NOT EXISTS client_order_status_history (
  id INT PRIMARY KEY AUTO_INCREMENT,
  order_id INT NOT NULL,
  status VARCHAR(32) NOT NULL,
  note TEXT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (order_id) REFERENCES client_orders(id),
  INDEX idx_order_status_history (order_id, created_at)
);

CREATE TABLE IF NOT EXISTS custom_design_requests (
  id INT PRIMARY KEY AUTO_INCREMENT,
  name VARCHAR(120) NOT NULL,
  email VARCHAR(160) NOT NULL,
  phone VARCHAR(30) NULL,
  product_type VARCHAR(120) NOT NULL,
  requested_size VARCHAR(100) NULL,
  material VARCHAR(120) NULL,
  quantity INT NOT NULL DEFAULT 1,
  budget DECIMAL(10,2) NULL,
  notes TEXT NOT NULL,
  reference_image_url TEXT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'new',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_custom_design_status (status, created_at)
);
