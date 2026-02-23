const db = require('../db/db');

/*
Assumption:
req.user.id exists (from auth middleware)
If not, replace with req.body.user_id
*/

//////////////////////////////
// Helper: Get or Create Cart
//////////////////////////////
const getOrCreateCart = (userId) => {
    return new Promise((resolve, reject) => {
        db.get(
            `SELECT * FROM cart WHERE user_id = ? AND status = 'active'`,
            [userId],
            (err, cart) => {
                if (err) return reject(err);

                if (cart) return resolve(cart.id);

                db.run(
                    `INSERT INTO cart (user_id) VALUES (?)`,
                    [userId],
                    function (err) {
                        if (err) return reject(err);
                        resolve(this.lastID);
                    }
                );
            }
        );
    });
};

//////////////////////////////
// 1. ADD TO CART
//////////////////////////////
exports.addToCart = async (req, res) => {
    try {
        const userId = req.user.id;
        const { product_id, quantity, price } = req.body;

        if (!product_id || !quantity || quantity <= 0)
            return res.status(400).json({ message: "Invalid data" });

        const cartId = await getOrCreateCart(userId);

        // Check if product already in cart
        db.get(
            `SELECT * FROM cart_items WHERE cart_id = ? AND product_id = ?`,
            [cartId, product_id],
            (err, item) => {
                if (err) return res.status(500).json(err);

                if (item) {
                    // Update quantity
                    db.run(
                        `UPDATE cart_items 
                         SET quantity = quantity + ? 
                         WHERE id = ?`,
                        [quantity, item.id],
                        () => res.json({ message: "Cart updated" })
                    );
                } else {
                    // Insert new item
                    db.run(
                        `INSERT INTO cart_items (cart_id, product_id, quantity, price)
                         VALUES (?, ?, ?, ?)`,
                        [cartId, product_id, quantity, price],
                        () => res.json({ message: "Item added to cart" })
                    );
                }
            }
        );
    } catch (err) {
        res.status(500).json(err);
    }
};

//////////////////////////////
// 2. GET CART
//////////////////////////////
exports.getCart = (req, res) => {
    const userId = req.user.id;

    db.get(
        `SELECT * FROM cart WHERE user_id = ? AND status='active'`,
        [userId],
        (err, cart) => {
            if (err) return res.status(500).json(err);
            if (!cart) return res.json({ items: [], total: 0 });

            db.all(
                `SELECT ci.*, p.name
                 FROM cart_items ci
                 JOIN products p ON p.id = ci.product_id
                 WHERE ci.cart_id = ?`,
                [cart.id],
                (err, items) => {
                    if (err) return res.status(500).json(err);

                    const total = items.reduce(
                        (sum, i) => sum + i.quantity * i.price,
                        0
                    );

                    res.json({ cart_id: cart.id, items, total });
                }
            );
        }
    );
};

//////////////////////////////
// 3. CART BADGE COUNT
//////////////////////////////
exports.getCartCount = (req, res) => {
    const userId = req.user.id;

    db.get(
        `SELECT id FROM cart WHERE user_id = ? AND status='active'`,
        [userId],
        (err, cart) => {
            if (!cart) return res.json({ count: 0 });

            db.get(
                `SELECT SUM(quantity) as count FROM cart_items WHERE cart_id=?`,
                [cart.id],
                (err, row) => res.json({ count: row.count || 0 })
            );
        }
    );
};

//////////////////////////////
// 4. CHECKOUT (CREATE ORDER)
//////////////////////////////
exports.checkout = (req, res) => {
    const userId = req.user.id;

    db.serialize(() => {

        // Start transaction
        db.run("BEGIN TRANSACTION");

        // 1. Find active cart
        db.get(
            `SELECT * FROM cart WHERE user_id=? AND status='active'`,
            [userId],
            (err, cart) => {
                if (!cart) {
                    db.run("ROLLBACK");
                    return res.status(400).json({ message: "Cart empty" });
                }

                // 2. Get cart items
                db.all(
                    `SELECT * FROM cart_items WHERE cart_id=?`,
                    [cart.id],
                    (err, items) => {

                        if (!items || items.length === 0) {
                            db.run("ROLLBACK");
                            return res.status(400).json({ message: "Cart empty" });
                        }

                        const total = items.reduce(
                            (sum, i) => sum + i.quantity * i.price,
                            0
                        );

                        // 3. Create order
                        db.run(
                            `INSERT INTO orders (user_id, cart_id, total)
                             VALUES (?, ?, ?)`,
                            [userId, cart.id, total],
                            function (err) {

                                const orderId = this.lastID;

                                // 4. Copy items to order_items
                                const stmt = db.prepare(
                                    `INSERT INTO order_items 
                                     (order_id, product_id, quantity, price)
                                     VALUES (?, ?, ?, ?)`
                                );

                                items.forEach(item => {
                                    stmt.run(orderId, item.product_id, item.quantity, item.price);
                                });

                                stmt.finalize();

                                // 5. Close cart
                                db.run(`UPDATE cart SET status='checked_out' WHERE id=?`, [cart.id]);

                                // 6. Clear cart items
                                db.run(`DELETE FROM cart_items WHERE cart_id=?`, [cart.id]);

                                db.run("COMMIT");

                                res.json({
                                    message: "Order placed successfully",
                                    order_id: orderId,
                                    total
                                });
                            }
                        );
                    }
                );
            }
        );
    });
};