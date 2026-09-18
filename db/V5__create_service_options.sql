CREATE TABLE IF NOT EXISTS service_options (
  id INT PRIMARY KEY AUTO_INCREMENT,
  service_name VARCHAR(160) NOT NULL,
  title VARCHAR(160) NOT NULL,
  description TEXT,
  price DECIMAL(10,2) NOT NULL DEFAULT 0,
  image_url TEXT NULL,
  display_order INT NOT NULL DEFAULT 0,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_service_options_public (service_name, status, display_order)
);
