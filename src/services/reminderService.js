const { authorize, getRawUpcomingEvents } = require('./googleService');
const { getReminders, markReminderSent } = require('../database/db');
require('dotenv').config();

const REMINDER_INTERVAL_MS = 60 * 1000; // Cek setiap 1 menit
const REMINDER_WINDOW_MINUTES = 15; // Ingatkan 15 menit sebelum acara
const remindedEventIds = new Set(); // Cache ID event yang sudah diingatkan

async function checkAndSendCalendarReminders(client) {
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
        
    } catch (error) {
        console.error('[Reminder] Error checking calendar reminders:', error);
    }
}

async function checkAndSendCustomReminders(client) {
    try {
        const reminders = getReminders();
        if (!reminders || reminders.length === 0) return;

        const now = new Date();

        for (const reminder of reminders) {
            if (reminder.sent) continue;

            const reminderTime = new Date(reminder.dateTime);
            
            // Kirim jika waktu reminder sudah lewat atau dalam 1 menit ke depan
            if (reminderTime <= new Date(now.getTime() + 60 * 1000)) {
                const targetLabels = (reminder.targetLabels || []).join(', ') || 'Penerima';
                const message = `🔔 *PENGINGAT KUSTOM*\n\n${reminder.message}\n\n_Dijadwalkan untuk: ${reminderTime.toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' })}_`;

                let allSent = true;
                for (const target of reminder.targets) {
                    try {
                        await client.sendMessage(target, message);
                        console.log(`[CustomReminder] Terkirim ke ${target}: "${reminder.message.substring(0, 40)}..."`);
                    } catch (error) {
                        console.error(`[CustomReminder] Gagal mengirim ke ${target}:`, error);
                        allSent = false;
                    }
                }

                if (allSent) {
                    markReminderSent(reminder.id);
                    console.log(`[CustomReminder] Reminder ${reminder.id} ditandai selesai.`);
                }
            }
        }
    } catch (error) {
        console.error('[CustomReminder] Error checking custom reminders:', error);
    }
}

function startReminderCron(client) {
    console.log('[Reminder] Service dimulai. Cek setiap 1 menit.');
    // Cek langsung saat start
    checkAndSendCalendarReminders(client);
    checkAndSendCustomReminders(client);
    
    // Lalu loop
    setInterval(() => {
        checkAndSendCalendarReminders(client);
        checkAndSendCustomReminders(client);
    }, REMINDER_INTERVAL_MS);
}

module.exports = { startReminderCron };
