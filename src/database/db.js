const fs = require('fs');
const path = require('path');

const DB_FILE = path.resolve(__dirname, '../data/database.json');
const NOTE_FILE = path.resolve(__dirname, '../data/urgent_note.txt');
const REMINDERS_FILE = path.resolve(__dirname, '../data/reminders.json');

let messageBuffer = [];
let conversationSummaries = [];
let urgentNote = "";

// Load Catatan Mendesak
if (fs.existsSync(NOTE_FILE)) {
    urgentNote = fs.readFileSync(NOTE_FILE, 'utf8');
    console.log(`dY", Catatan Mendesak Dimuat: "${urgentNote}"`);
}

// Load History Chat (Ingatan Abadi) + Summaries
if (fs.existsSync(DB_FILE)) {
    try {
        const rawData = fs.readFileSync(DB_FILE, 'utf8');
        const parsed = JSON.parse(rawData);

        if (Array.isArray(parsed)) {
            messageBuffer = parsed;
        } else {
            messageBuffer = Array.isArray(parsed.messages) ? parsed.messages : [];
            conversationSummaries = Array.isArray(parsed.summaries) ? parsed.summaries : [];
        }

        console.log(`dY", Database Dimuat: ${messageBuffer.length} item ingatan.`);
    } catch (err) {
        console.error("Gagal memuat database:", err);
        messageBuffer = [];
        conversationSummaries = [];
    }
}

function saveDatabase() {
    try {
        const dataToSave = {
            messages: messageBuffer.slice(-1000),
            summaries: conversationSummaries.slice(-500)
        };
        fs.writeFileSync(DB_FILE, JSON.stringify(dataToSave, null, 2));
    } catch (err) {
        console.error("Gagal menyimpan database:", err);
    }
}

function saveUrgentNote(note) {
    urgentNote = note;
    fs.writeFileSync(NOTE_FILE, urgentNote);
}

function deleteUrgentNote() {
    urgentNote = "";
    if (fs.existsSync(NOTE_FILE)) fs.unlinkSync(NOTE_FILE);
}

function getUrgentNote() {
    return urgentNote;
}

function getMessageBuffer() {
    return messageBuffer;
}

function addMessageToBuffer(message) {
    messageBuffer.push(message);
    saveDatabase();
}

function clearMessageBuffer() {
    messageBuffer = [];
    saveDatabase();
}

function getMessagesByChat(chatId) {
    return messageBuffer.filter(item => item.chatId === chatId);
}

function clearMessagesByChat(chatId) {
    messageBuffer = messageBuffer.filter(item => item.chatId !== chatId);
    saveDatabase();
}

function addConversationSummary(summary) {
    conversationSummaries.push(summary);
    saveDatabase();
}

function getConversationSummaries() {
    return conversationSummaries;
}

// === CUSTOM REMINDERS ===

function loadReminders() {
    try {
        if (fs.existsSync(REMINDERS_FILE)) {
            const raw = fs.readFileSync(REMINDERS_FILE, 'utf8');
            return JSON.parse(raw);
        }
    } catch (err) {
        console.error('Gagal memuat reminders:', err);
    }
    return [];
}

function saveReminders(list) {
    try {
        fs.writeFileSync(REMINDERS_FILE, JSON.stringify(list, null, 2));
    } catch (err) {
        console.error('Gagal menyimpan reminders:', err);
    }
}

function addReminder(reminder) {
    const list = loadReminders();
    const newReminder = {
        id: `rem_${Date.now()}`,
        message: reminder.message,
        dateTime: reminder.dateTime,
        targets: reminder.targets || [],
        targetLabels: reminder.targetLabels || [],
        sent: false,
        createdAt: Date.now()
    };
    list.push(newReminder);
    saveReminders(list);
    return newReminder;
}

function deleteReminder(id) {
    const list = loadReminders();
    const initialLen = list.length;
    const filtered = list.filter(r => r.id !== id);
    if (filtered.length === initialLen) return null;
    saveReminders(filtered);
    return id;
}

function getReminders() {
    return loadReminders();
}

function markReminderSent(id) {
    const list = loadReminders();
    const reminder = list.find(r => r.id === id);
    if (reminder) {
        reminder.sent = true;
        saveReminders(list);
    }
}

module.exports = {
    saveDatabase,
    saveUrgentNote,
    deleteUrgentNote,
    getUrgentNote,
    getMessageBuffer,
    addMessageToBuffer,
    clearMessageBuffer,
    getMessagesByChat,
    clearMessagesByChat,
    addConversationSummary,
    getConversationSummaries,
    addReminder,
    deleteReminder,
    getReminders,
    markReminderSent
};
