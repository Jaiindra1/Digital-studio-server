PRAGMA foreign_keys=off;

BEGIN TRANSACTION;

CREATE TABLE tasks_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT,
  staff_id INTEGER,
  created_by INTEGER,
  created_by_staff_id INTEGER,
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK(status IN ('PENDING', 'COMPLETED')),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  completed_at DATETIME,
  due_date DATE,
  FOREIGN KEY (staff_id) REFERENCES staff(id),
  FOREIGN KEY (created_by) REFERENCES users(id),
  FOREIGN KEY (created_by_staff_id) REFERENCES staff(id)
);

INSERT INTO tasks_new (id, title, description, staff_id, created_by, status, created_at, completed_at)
SELECT id, title, description, staff_id, created_by, status, created_at, completed_at
FROM tasks;

DROP TABLE tasks;

ALTER TABLE tasks_new RENAME TO tasks;

COMMIT;

PRAGMA foreign_keys=on;
