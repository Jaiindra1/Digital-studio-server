require("dotenv").config();
const db = require("../config/db");
const s3Client = require("../config/s3");
const { PutObjectCommand , GetObjectCommand ,DeleteObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const BUCKET = process.env.S3_BUCKET_NAME;

// Promise helpers for sqlite
const dbGet = (sql, params = []) => new Promise((resolve, reject) => {
  db.get(sql, params, (err, row) => err ? reject(err) : resolve(row));
});

const dbRun = (sql, params = []) => new Promise((resolve, reject) => {
  db.run(sql, params, function (err) {
    if (err) return reject(err);
    resolve(this);
  });
});

exports.createStudioProfile = async (req, res) => {
  try {
    const {
      studio_name,
      description,
      address,
      phone,
      email,
      website,
      instagram
    } = req.body;

    if (!studio_name) {
      return res.status(400).json({ message: "Studio name is required" });
    }

    let image_key = null;

    // Upload image to S3
    if (req.file) {
      const file = req.file;
      image_key = `studio/${Date.now()}-${file.originalname}`;

      const uploadParams = {
        Bucket: BUCKET,
        Key: image_key,
        Body: file.buffer,
        ContentType: file.mimetype
      };

      await s3Client.send(new PutObjectCommand(uploadParams));
    }

    await dbRun(
      `INSERT OR REPLACE INTO studio_profile
       (id, studio_name, description, image_url, address, phone, email, website, instagram, updated_at)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
      [
        studio_name,
        description || null,
        image_key,
        address || null,
        phone || null,
        email || null,
        website || null,
        instagram || null
      ]
    );

    const saved = await dbGet(`SELECT * FROM studio_profile WHERE id = 1`);

    return res.status(201).json({
      message: "Studio profile created successfully",
      data: saved
    });

  } catch (error) {
    console.error("Create Studio Error:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

exports.getStudioProfileById = async (req, res) => {
  try {

    const studio = await dbGet("SELECT * FROM studio_profile WHERE id = 1");

    if (!studio) {
      return res.status(404).json({ message: "Studio not found" });
    }

    // Generate signed URL if image exists
    if (studio.image_url) {
      const command = new GetObjectCommand({
        Bucket: BUCKET,
        Key: studio.image_url
      });

      studio.image_url = await getSignedUrl(s3Client, command, {
        expiresIn: 3600 // 1 hour
      });
    }

    const normalizedStudio = {
      ...studio,
      studioName: studio.studio_name || null,
      logo_url: studio.image_url || null,
      logo: studio.image_url || null
    };

    return res.status(200).json(normalizedStudio);

  } catch (error) {
    console.error("Get Studio Error:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

exports.updateStudioProfile = async (req, res) => {
  try {
    const {
      studio_name,
      description,
      address,
      phone,
      email,
      website,
      instagram
    } = req.body;

    // Fetch existing studio (singleton)
    const existingStudio = await dbGet("SELECT * FROM studio_profile WHERE id = 1");

    if (!existingStudio) {
      return res.status(404).json({
        message: "Studio profile not found. Create it first."
      });
    }

    let newImageKey = existingStudio.image_url;

    // If new image uploaded → replace
    if (req.file) {
      const file = req.file;
      newImageKey = `studio/${Date.now()}-${file.originalname}`;

      // Upload new image
      await s3Client.send(
        new PutObjectCommand({
          Bucket: BUCKET,
          Key: newImageKey,
          Body: file.buffer,
          ContentType: file.mimetype,
        })
      );

      // Delete old image if exists
      if (existingStudio.image_url) {
        await s3Client.send(
          new DeleteObjectCommand({
            Bucket: BUCKET,
            Key: existingStudio.image_url,
          })
        );
      }
    }

    await dbRun(
      `UPDATE studio_profile
       SET
         studio_name = COALESCE(?, studio_name),
         description = COALESCE(?, description),
         image_url = ?,
         address = COALESCE(?, address),
         phone = COALESCE(?, phone),
         email = COALESCE(?, email),
         website = COALESCE(?, website),
         instagram = COALESCE(?, instagram),
         updated_at = CURRENT_TIMESTAMP
       WHERE id = 1`,
      [
        studio_name,
        description,
        newImageKey,
        address,
        phone,
        email,
        website,
        instagram,
      ]
    );

    const updated = await dbGet(`SELECT * FROM studio_profile WHERE id = 1`);

    return res.status(200).json({
      message: "Studio profile updated successfully",
      data: updated,
    });

  } catch (error) {
    console.error("Update Studio Error:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};
