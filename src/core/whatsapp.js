const path = require('path');
const { Client, LocalAuth } = require('whatsapp-web.js');

const client = new Client({
    authStrategy: new LocalAuth(),
    markOnlineAvailable: false,
    authTimeoutMs: 0, // Disable auth timeout — tunggu sampai QR di-scan
    qrMaxRetries: 5,
    puppeteer: {
        headless: true,
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
        timeout: 0, // No timeout for browser launch
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu'
        ]
    }
});

module.exports = client;
