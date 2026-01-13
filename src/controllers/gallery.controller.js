const db = require("../db/db");

/**
 * GET DISTINCT CATEGORIES
 */
exports.getCategories = (req, res) => {
  db.all(
    `SELECT DISTINCT category FROM gallery ORDER BY category`,
    [],
    (err, rows) => {
      if (err) return res.status(500).json({ message: "Failed to fetch categories" });
      res.json(rows.map(r => r.category));
    }
  );
};

/**
 * GET LABELS BY CATEGORY
 */
exports.getLabelsByCategory = (req, res) => {
  const { category } = req.params;

  db.all(
    `SELECT id, name FROM gallery WHERE category = ? ORDER BY name`,
    [category],
    (err, rows) => {
      if (err) return res.status(500).json({ message: "Failed to fetch labels" });
      res.json(rows);
    }
  );
};
