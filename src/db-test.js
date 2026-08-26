require("dotenv").config();
const express = require("express");
const pool = require("./config/db");

const app = express();

app.get("/db-test", async (req, res) => {
  try {
    const result = await pool.query("SELECT 1 as connected");
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).send("DB FAILED");
  }
});

app.listen(3000, '0.0.0.0', () => console.log("Server running"));
