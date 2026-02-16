// FILE: index.js
// Ini adalah file UTAMA untuk menjalankan bot.

const qrcode = require('qrcode-terminal');
const client = require('./src/core/whatsapp');
const handleMessage = require('./src/handlers/messageHandler');
const handleIncomingCall = require('./src/handlers/callHandler');
const { initializeKnowledgeBase } = require('./src/services/ragService');
const { startReminderCron } = require('./src/services/reminderService');

// --- EVENT HANDLERS ---

client.on('qr', (qr) => {
    qrcode.generate(qr, { small: true });
    console.log('SCAN QR CODE DI ATAS DENGAN WHATSAPP!');
});

client.on('ready', async () => {
    console.log('Bot Perwira-AI siap! Ketik "!aktif" di WA untuk menyalakan.');
    await initializeKnowledgeBase();
    startReminderCron(client);
});

client.on('auth_failure', (msg) => {
    console.error('Autentikasi gagal:', msg);
    console.log('Hapus folder .wwebjs_auth dan jalankan ulang untuk scan QR baru.');
});

client.on('disconnected', (reason) => {
    console.warn('Bot terputus:', reason);
    console.log('Mencoba reconnect...');
    client.initialize();
});

client.on('message_create', handleMessage);

client.on('incoming_call', handleIncomingCall);

// Tangkap error global agar bot tidak crash
process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection:', reason);
});

client.initialize();
