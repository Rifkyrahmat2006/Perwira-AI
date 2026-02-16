const { authorize, getRawUpcomingEvents } = require('./googleService');
require('dotenv').config();

const REMINDER_INTERVAL_MS = 60 * 1000; // Cek setiap 1 menit
const REMINDER_WINDOW_MINUTES = 15; // Ingatkan 15 menit sebelum acara
const remindedEventIds = new Set(); // Cache ID event yang sudah diingatkan

async function checkAndSendReminders(client) {
    try {
        const auth = await authorize();
        if (!auth) {
            console.warn('[Reminder] Google Auth belum tersedia, skip cek jadwal.');
            return;
        }

        const events = await getRawUpcomingEvents(auth, REMINDER_WINDOW_MINUTES);
        
        if (!events || events.length === 0) return;

        const ownerNumber = process.env.OWNER_NUMBER;
        if (!ownerNumber) {
            console.error('[Reminder] OWNER_NUMBER tidak ditemukan di .env');
            return;
        }

        // Format nomor untuk WhatsApp: pastikan berakhiran @c.us jika belum
        let targetId = ownerNumber;
        if (!targetId.includes('@')) {
            targetId = `${targetId}@c.us`;
        }

        for (const event of events) {
            if (remindedEventIds.has(event.id)) continue;

            const startTime = new Date(event.start.dateTime || event.start.date);
            const timeString = startTime.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
            
            const message = `⏰ *PENGINGAT ACARA*\n\n"${event.summary}"\n\nAkan dimulai pukul ${timeString} (±${REMINDER_WINDOW_MINUTES} menit lagi).\nSiap-siap ya! 🚀`;

            try {
                // Send to owner
                await client.sendMessage(targetId, message);
                console.log(`[Reminder] Terkirim: ${event.summary}`);
                
                // Tandai sudah diingatkan
                remindedEventIds.add(event.id);
            } catch (error) {
                console.error(`[Reminder] Gagal mengirim pesan ke ${targetId}:`, error);
            }
        }

        // Opsional: Bersihkan cache ID yang acaranya sudah lewat (biar memori nggak bocor)
        // Tapi untuk MVP, Set string ID tidak akan memakan banyak memori kecuali ada ribuan event.
        
    } catch (error) {
        console.error('[Reminder] Error checking reminders:', error);
    }
}

function startReminderCron(client) {
    console.log('[Reminder] Service dimulai. Cek setiap 1 menit.');
    // Cek langsung saat start
    checkAndSendReminders(client);
    
    // Lalu loop
    setInterval(() => {
        checkAndSendReminders(client);
    }, REMINDER_INTERVAL_MS);
}

module.exports = { startReminderCron };
