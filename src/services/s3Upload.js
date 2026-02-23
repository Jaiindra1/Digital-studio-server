const { PutObjectCommand } = require("@aws-sdk/client-s3");
const { v4: uuid } = require("uuid");
const s3Client = require("../config/s3");

const BUCKET = process.env.S3_BUCKET_NAME;

exports.uploadProductImage = async (file) => {
    const key = `products/${uuid()}-${file.originalname}`;

    await s3Client.send(
        new PutObjectCommand({
            Bucket: BUCKET,
            Key: key,
            Body: file.buffer,
            ContentType: file.mimetype
        })
    );

    return key; // store only key in DB
};