CREATE TABLE IF NOT EXISTS attendance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  staff_id INTEGER NOT NULL,
  date DATE NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('present', 'absent', 'leave')),
  request_status TEXT NOT NULL DEFAULT 'approved'
    CHECK(request_status IN ('pending', 'approved', 'cancelled')),
  notes TEXT,
  reviewed_by INTEGER,
  reviewed_at DATETIME,
  review_notes TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (staff_id) REFERENCES staff(id),
  FOREIGN KEY (reviewed_by) REFERENCES users(id)
);
