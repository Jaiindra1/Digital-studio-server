const mysql = require("mysql2/promise");

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 3306,
  timezone: "Z",
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  ssl: {
    rejectUnauthorized: false,
  },
});

function normalizeSql(sql) {
  let out = String(sql || "");

  out = out.replace(/\bINSERT\s+OR\s+IGNORE\s+INTO\b/gi, "INSERT IGNORE INTO");
  out = out.replace(/\bINSERT\s+OR\s+REPLACE\s+INTO\b/gi, "REPLACE INTO");
  out = out.replace(/DATE\s*\(\s*'now'\s*\)/gi, "CURDATE()");
  out = out.replace(
    /ON\s+CONFLICT\s*\(\s*key\s*\)\s*DO\s+UPDATE\s+SET\s+value\s*=\s*excluded\.value/gi,
    "ON DUPLICATE KEY UPDATE value = VALUES(value)"
  );
  out = out.replace(/strftime\(\s*'%Y-%m'\s*,\s*([^)]+?)\s*\)/gi, "DATE_FORMAT($1, '%Y-%m')");
  out = out.replace(/strftime\(\s*'%Y'\s*,\s*([^)]+?)\s*\)/gi, "YEAR($1)");
  out = out.replace(/strftime\(\s*'%m'\s*,\s*([^)]+?)\s*\)/gi, "MONTH($1)");
  out = out.replace(
    /date\(\s*strftime\(\s*'%Y-01-01'\s*,\s*'now'\s*\)\s*\)/gi,
    "DATE_FORMAT(CURDATE(), '%Y-01-01')"
  );

  return out;
}

function parseCallbackArgs(args) {
  const list = Array.from(args);
  const callback = typeof list[list.length - 1] === "function" ? list.pop() : null;

  if (list.length <= 1) {
    return { params: Array.isArray(list[0]) ? list[0] : [], callback };
  }
  if (Array.isArray(list[1])) {
    return { params: list[1], callback };
  }
  return { params: list.slice(1), callback };
}

function parsePreparedArgs(args) {
  const list = Array.from(args);
  const callback = typeof list[list.length - 1] === "function" ? list.pop() : null;
  if (list.length === 1 && Array.isArray(list[0])) {
    return { params: list[0], callback };
  }
  return { params: list, callback };
}

async function execute(sql, params) {
  const [rows] = await pool.query(normalizeSql(sql), params || []);
  if (Array.isArray(rows)) {
    return { rows, lastID: undefined, changes: 0 };
  }
  return {
    rows: [],
    lastID: rows.insertId || undefined,
    changes: typeof rows.affectedRows === "number" ? rows.affectedRows : 0,
  };
}

const db = {
  pool,

  async query(sql, params = []) {
    return execute(sql, params);
  },

  run(sql /* params..., cb */) {
    const { params, callback } = parseCallbackArgs(arguments);
    execute(sql, params)
      .then((result) => {
        if (callback) callback.call({ lastID: result.lastID, changes: result.changes }, null);
      })
      .catch((err) => {
        if (callback) callback(err);
      });
    return this;
  },

  get(sql /* params..., cb */) {
    const { params, callback } = parseCallbackArgs(arguments);
    execute(sql, params)
      .then((result) => {
        const row = result.rows && result.rows.length ? result.rows[0] : undefined;
        if (callback) callback(null, row);
      })
      .catch((err) => {
        if (callback) callback(err);
      });
    return this;
  },

  all(sql /* params..., cb */) {
    const { params, callback } = parseCallbackArgs(arguments);
    execute(sql, params)
      .then((result) => {
        if (callback) callback(null, result.rows || []);
      })
      .catch((err) => {
        if (callback) callback(err);
      });
    return this;
  },

  exec(sql, callback) {
    execute(sql, [])
      .then(() => {
        if (typeof callback === "function") callback(null);
      })
      .catch((err) => {
        if (typeof callback === "function") callback(err);
      });
    return this;
  },

  serialize(fn) {
    if (typeof fn === "function") fn();
    return this;
  },

  prepare(sql) {
    const pending = [];
    const statement = {
      run() {
        const { params, callback } = parsePreparedArgs(arguments);
        const op = execute(sql, params)
          .then((result) => {
            if (callback) callback.call({ lastID: result.lastID, changes: result.changes }, null);
          })
          .catch((err) => {
            if (callback) callback(err);
          });
        pending.push(op);
        return statement;
      },
      finalize(callback) {
        Promise.all(pending)
          .then(() => {
            if (typeof callback === "function") callback(null);
          })
          .catch((err) => {
            if (typeof callback === "function") callback(err);
          });
      },
    };
    return statement;
  },
};

module.exports = db;
