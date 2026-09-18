ALTER TABLE events
  ADD COLUMN delivery_method VARCHAR(16) NOT NULL DEFAULT 'ONLINE',
  ADD COLUMN delivery_note TEXT NULL,
  ADD COLUMN delivered_at DATETIME NULL,
  ADD COLUMN client_downloaded_at DATETIME NULL,
  ADD COLUMN gallery_removed_at DATETIME NULL;
