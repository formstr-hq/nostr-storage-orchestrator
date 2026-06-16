const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const checkDiskSpace = require('check-disk-space').default;

const app = express();

const NODE_ID = process.env.NODE_ID || 'unknown';

app.use(express.raw({ type: 'application/octet-stream' }));
app.use(cors());

if (!fs.existsSync('uploads')) {
  fs.mkdirSync('uploads');
}

/* Health Endpoint */
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    nodeId: NODE_ID
  });
});

/* Storage Endpoint */
app.get('/storage', async (req, res) => {
  try {
    const disk = await checkDiskSpace('/');

    res.json({
      nodeId: NODE_ID,
      totalBytes: disk.size,
      freeBytes: disk.free,
      usedBytes: disk.size - disk.free
    });
  } catch (err) {
    res.status(500).json({
      error: err.message
    });
  }
});

/* Upload */
app.post('/upload', (req, res) => {
  const data = req.body;

  if (!Buffer.isBuffer(data)) {
    return res.status(400).json({
      error: 'Invalid upload body'
    });
  }

  const hash = crypto
    .createHash('sha256')
    .update(data)
    .digest('hex');

  const finalPath = path.join('uploads', hash);

  fs.writeFileSync(finalPath, data);

  res.json({
    hash,
    url: `/blob/${hash}`
  });
});

/* Download */
app.get('/blob/:hash', (req, res) => {
  const filePath = path.join('uploads', req.params.hash);

  if (!fs.existsSync(filePath)) {
    return res.status(404).send('Not found');
  }

  res.sendFile(path.resolve(filePath));
});

/* Delete */
app.delete('/blob/:hash', (req, res) => {
  const filePath = path.join('uploads', req.params.hash);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({
      error: 'Blob not found'
    });
  }

  fs.unlinkSync(filePath);

  res.json({
    success: true,
    hash: req.params.hash
  });
});

app.listen(3000, '0.0.0.0', () => {
  console.log('Blossom-like blob server running on port 3000');
});