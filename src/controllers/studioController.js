require("dotenv").config();
const db = require("../db/db");
const s3Client = require("../config/s3");
const { PutObjectCommand , GetObjectCommand ,DeleteObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const BUCKET = process.env.S3_BUCKET_NAME;

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

    const query = `
      INSERT INTO studio_profile
      (studio_name, description, image_url, address, phone, email, website, instagram)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      RETURNING *;
    `;

    const values = [
      studio_name,
      description || null,
      image_key, // store KEY only
      address || null,
      phone || null,
      email || null,
      website || null,
      instagram || null
    ];

    const { rows } = await db.query(query, values);

    return res.status(201).json({
      message: "Studio profile created successfully",
      data: rows[0]
    });

  } catch (error) {
    console.error("Create Studio Error:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

exports.getStudioProfileById = async (req, res) => {
  try {

    const result = await db.query(
      "SELECT * FROM studio_profile WHERE id = 1"
      
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: "Studio not found" });
    }

    const studio = result.rows[0];

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

    return res.status(200).json(studio);

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
    const existingResult = await db.query(
      "SELECT * FROM studio_profile WHERE id = 1"
    );

    if (existingResult.rows.length === 0) {
      return res.status(404).json({
        message: "Studio profile not found. Create it first."
      });
    }

    const existingStudio = existingResult.rows[0];

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

        const updateQuery = `
      UPDATE studio_profile
      SET
        studio_name = COALESCE($1, studio_name),
        description = COALESCE($2, description),
          image_url = $3,
          address = COALESCE($4, address),
          phone = COALESCE($5, phone),
          email = COALESCE($6, email),
          website = COALESCE($7, website),
          instagram = COALESCE($8, instagram),
          updated_at = CURRENT_TIMESTAMP
        WHERE id = 1
        RETURNING *;
      `;


    const values = [
      studio_name,
      description,
      newImageKey,
      address,
      phone,
      email,
      website,
      instagram,
    ];

    const { rows } = await db.query(updateQuery, values);

    return res.status(200).json({
      message: "Studio profile updated successfully",
      data: rows[0],
    });

  } catch (error) {
    console.error("Update Studio Error:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};
