const db = require('../db/db');
const { uploadProductImage } = require('../services/s3Upload');
const { GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const s3Client = require("../config/s3");

const BUCKET = process.env.S3_BUCKET_NAME;

////////////////////////////////////////////////////
// Helper → Convert text specs to JSON
////////////////////////////////////////////////////
function parseSpecifications(text = "") {
    const obj = {};
    text.split("\n").forEach(line => {
        const [k, v] = line.split(":");
        if (k && v) obj[k.trim()] = v.trim();
    });
    return obj;
}

////////////////////////////////////////////////////
// Helper → Attach signed S3 URL
////////////////////////////////////////////////////
async function attachSignedUrl(product) {
    if (!product.image_url) return product;

    try {
        const cmd = new GetObjectCommand({
            Bucket: BUCKET,
            Key: product.image_url
        });

        const signed = await getSignedUrl(s3Client, cmd, { expiresIn: 3600 });

        return {
            ...product,
            specs: JSON.parse(product.specs || "{}"),
            display_url: signed
        };
    } catch (err) {
        console.error("Signed URL error:", err.message);
        return {
            ...product,
            specs: JSON.parse(product.specs || "{}"),
            display_url: null
        };
    }
}

////////////////////////////////////////////////////
// GET ALL PRODUCTS (Public)
////////////////////////////////////////////////////
exports.getAllProducts = async (req, res) => {
    const { category, orientation } = req.query;

    let query = `SELECT * FROM products`;
    let params = [];

    if (category) {
        query += ` AND category=?`;
        params.push(category);
    }

    if (orientation) {
        query += ` AND orientation=?`;
        params.push(orientation);
    }

    db.all(query, params, async (err, rows) => {
        if (err) return res.status(500).json(err);

        const products = await Promise.all(rows.map(attachSignedUrl));
        res.json(products);
    });
};

////////////////////////////////////////////////////
// GET SINGLE PRODUCT
////////////////////////////////////////////////////
exports.getProductById = (req, res) => {
    const { id } = req.params;

    db.get(`SELECT * FROM products WHERE id=? AND status='active'`, [id], async (err, product) => {
        if (err) return res.status(500).json(err);
        if (!product) return res.status(404).json({ message: "Product not found" });

        const result = await attachSignedUrl(product);
        res.json(result);
    });
};

////////////////////////////////////////////////////
// CREATE PRODUCT (ADMIN)
////////////////////////////////////////////////////
exports.createProduct = async (req, res) => {
    try {
        const { name, category, orientation, price, specifications } = req.body;

        if (!name || !category || !price)
            return res.status(400).json({ message: "Missing required fields" });

        if (!req.file)
            return res.status(400).json({ message: "Image required" });

        // Upload to S3
        const imageKey = await uploadProductImage(req.file);

        // Parse specs
        const specsObject = parseSpecifications(specifications);

        db.run(
            `INSERT INTO products (name, category, orientation, price, image_url, specs)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [name, category, orientation, price, imageKey, JSON.stringify(specsObject)],
            function (err) {
                if (err) return res.status(500).json(err);

                res.status(201).json({
                    message: "Product created successfully",
                    product_id: this.lastID
                });
            }
        );

    } catch (err) {
        console.error(err);
        res.status(500).json({ message: "Upload failed" });
    }
};

////////////////////////////////////////////////////
// UPDATE PRODUCT (ADMIN) (supports image replace)
////////////////////////////////////////////////////
exports.updateProduct = async (req, res) => {
    try {
        const { id } = req.params;
        const { name, category, orientation, price, specifications, status } = req.body;

        let imageKey = null;

        // If new image uploaded
        if (req.file) {
            imageKey = await uploadProductImage(req.file);
        }

        const specsObject = parseSpecifications(specifications);

        db.run(
            `UPDATE products
             SET name=?, category=?, orientation=?, price=?, 
                 image_url=COALESCE(?, image_url),
                 specs=?, status=?
             WHERE id=?`,
            [
                name,
                category,
                orientation,
                price,
                imageKey,
                JSON.stringify(specsObject),
                status || 'active',
                id
            ],
            function (err) {
                if (err) return res.status(500).json(err);
                if (this.changes === 0)
                    return res.status(404).json({ message: "Product not found" });

                res.json({ message: "Product updated successfully" });
            }
        );

    } catch (err) {
        console.error(err);
        res.status(500).json({ message: "Update failed" });
    }
};

////////////////////////////////////////////////////
// DELETE PRODUCT (ADMIN) (SOFT DELETE)
////////////////////////////////////////////////////
exports.deleteProduct = (req, res) => {
    const { id } = req.params;

    db.run(`UPDATE products SET status='inactive' WHERE id=?`, [id], function (err) {
        if (err) return res.status(500).json(err);
        if (this.changes === 0)
            return res.status(404).json({ message: "Product not found" });

        res.json({ message: "Product deleted successfully" });
    });
};

////////////////////////////////////////////////////
// REstore Product
///////////////////////////////////////////////////
exports.restoreProduct = (req, res) => {
    const { id } = req.params;

    db.run(`UPDATE products SET status='active' WHERE id=?`, [id], function (err) {
        if (err) return res.status(500).json(err);
        if (this.changes === 0)
            return res.status(404).json({ message: "Product not found" });

        res.json({ message: "Product restored successfully" });
    });
};