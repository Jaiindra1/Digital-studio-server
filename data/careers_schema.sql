CREATE TABLE IF NOT EXISTS career_openings (
  id INT PRIMARY KEY AUTO_INCREMENT,
  title VARCHAR(255) NOT NULL,
  tags VARCHAR(255) NULL,
  location VARCHAR(255) NULL,
  description TEXT NULL,
  requirements TEXT NULL,
  status ENUM('OPEN','CLOSED') DEFAULT 'OPEN',
  created_by INT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_career_openings_status_created (status, created_at),
  INDEX idx_career_openings_created_by (created_by)
);

CREATE TABLE IF NOT EXISTS career_applications (
  id INT PRIMARY KEY AUTO_INCREMENT,
  opening_id INT NOT NULL,
  full_name VARCHAR(160) NOT NULL,
  email VARCHAR(255) NULL,
  phone VARCHAR(40) NOT NULL,
  message TEXT NULL,
  resume_file_name TEXT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_career_applications_opening (opening_id),
  INDEX idx_career_applications_created (created_at),
  CONSTRAINT fk_career_app_opening
    FOREIGN KEY (opening_id) REFERENCES career_openings(id)
    ON DELETE CASCADE
);

