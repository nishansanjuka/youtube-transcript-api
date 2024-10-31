const express = require('express');
const multer = require('multer');
const fs = require('fs').promises;
const fss = require('fs');  // Synchronous fs for streams
const path = require('path');
const mammoth = require('mammoth');
const pdfParse = require('pdf-parse');
const StreamZip = require('node-stream-zip');

const app = express();
const port = 4000;

// Configure multer for file upload
const storage = multer.diskStorage({
    destination: async (req, file, cb) => {
        const uploadDir = 'uploads';
        try {
            await fs.mkdir(uploadDir, { recursive: true });
            cb(null, uploadDir);
        } catch (error) {
            cb(error, null);
        }
    },
    filename: (req, file, cb) => {
        cb(null, Date.now() + '-' + file.originalname);
    }
});

const fileFilter = (req, file, cb) => {
    const allowedTypes = [
        'application/pdf',
        'application/msword',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'text/plain',
        'application/zip'
    ];
    if (allowedTypes.includes(file.mimetype)) {
        cb(null, true);
    } else {
        cb(new Error('Invalid file type. Only PDF, DOCX, TXT, and ZIP files are allowed.'), false);
    }
};

const upload = multer({
    storage: storage,
    fileFilter: fileFilter,
    limits: {
        fileSize: 50 * 1024 * 1024 // 50MB limit for zip files
    }
});

// File content extractors
const extractors = {
    async pdf(filepath) {
        const dataBuffer = await fs.readFile(filepath);
        const data = await pdfParse(dataBuffer);
        return data.text;
    },

    async docx(filepath) {
        const result = await mammoth.extractRawText({ path: filepath });
        return result.value;
    },

    async txt(filepath) {
        const content = await fs.readFile(filepath, 'utf8');
        return content;
    }
};

// Process single file and return content
async function processFile(filepath) {
    const fileExtension = path.extname(filepath).toLowerCase();
    let content;

    switch (fileExtension) {
        case '.pdf':
            content = await extractors.pdf(filepath);
            break;
        case '.docx':
            content = await extractors.docx(filepath);
            break;
        case '.txt':
            content = await extractors.txt(filepath);
            break;
        default:
            throw new Error(`Unsupported file type: ${fileExtension}`);
    }

    return content;
}

// Process ZIP archive
async function processZipFile(zipPath) {
    const zip = new StreamZip.async({ file: zipPath });
    const results = [];
    
    try {
        const entries = await zip.entries();
        
        for (const entry of Object.values(entries)) {
            if (entry.isDirectory) continue;

            const ext = path.extname(entry.name).toLowerCase();
            if (['.pdf', '.docx', '.txt'].includes(ext)) {
                try {
                    // Create temporary file for processing
                    const tempPath = path.join('uploads', `temp_${Date.now()}${ext}`);
                    await zip.extract(entry.name, tempPath);
                    
                    // Process the extracted file
                    const content = await processFile(tempPath);
                    results.push({
                        filename: entry.name,
                        content: content
                    });

                    // Clean up temp file
                    await fs.unlink(tempPath);
                } catch (error) {
                    results.push({
                        filename: entry.name,
                        error: `Failed to process file: ${error.message}`
                    });
                }
            }
        }
    } finally {
        await zip.close();
    }

    return results;
}

// Upload and process endpoint
app.post('/upload', upload.single('document'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }

        const filepath = req.file.path;
        const fileExtension = path.extname(req.file.originalname).toLowerCase();

        let response;
        if (fileExtension === '.zip') {
            // Process ZIP archive
            const results = await processZipFile(filepath);
            response = {
                success: true,
                filename: req.file.originalname,
                files: results
            };
        } else {
            // Process single file
            const content = await processFile(filepath);
            response = {
                success: true,
                filename: req.file.originalname,
                content: content
            };
        }

        // Clean up uploaded file
        await fs.unlink(filepath);

        res.json(response);

    } catch (error) {
        console.error('Error processing file:', error);
        res.status(500).json({
            error: 'Error processing file',
            details: error.message
        });
    }
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ status: 'OK' });
});

// Error handling middleware
app.use((err, req, res, next) => {
    if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
            return res.status(400).json({
                error: 'File size limit exceeded. Maximum size is 50MB.'
            });
        }
    }
    next(err);
});

app.listen(port, () => {
    console.log(`Document parser API running on port ${port}`);
});