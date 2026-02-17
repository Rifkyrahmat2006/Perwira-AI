const client = require('../core/whatsapp');
const {
    saveUrgentNote,
    deleteUrgentNote,
    getUrgentNote,
    getMessageBuffer,
    addMessageToBuffer,
    clearMessageBuffer,
    getMessagesByChat,
    clearMessagesByChat,
    addConversationSummary
} = require('../database/db');
const { generateAIResponse, generateGroqSummary, generateVisionResponse, transcribeVoiceNote } = require('../services/aiService');
const { searchRelevantContext } = require('../services/ragService');
const { getSpecialContact, isNumberAllowed, isGroupAllowed } = require('../services/contactService');
const { setBotStatus, getBotStatus } = require('../utils/state');
const { authorize, listUpcomingEvents, listTasks } = require('../services/googleService');
const { parseAndExecuteTool } = require('../services/toolService');

let googleAuthClient = null;
let googleAuthAttempted = false;

const privateMessageQueues = new Map();
const privateDebounceTimers = new Map();
const DEBOUNCE_TIME = 10000; // kumpulkan pesan 15 detik sebelum merespons
const statusCooldowns = new Map();
const COOLDOWN_DURATION = 60 * 60 * 1000;
const summaryTimers = new Map();
const SUMMARY_WINDOW_MS = 60 * 60 * 1000;

function recordIncoming(chatId, senderName, text) {
    addMessageToBuffer({
        chatId,
        text: `[${senderName}]: ${text}`,
        timestamp: Date.now()
    });
}

function buildHistoryLogs(chatId) {
    return getMessageBuffer()
        .filter(item => item.chatId === chatId)
        .slice(-20)
        .map(item => item.text)
        .join('\n');
}

function getMentionedIds(msg) {
    if (Array.isArray(msg.mentionedIds)) {
        return msg.mentionedIds.filter(id => typeof id === 'string');
    }
    if (Array.isArray(msg._data?.mentionedJidList)) {
        return msg._data.mentionedJidList.filter(id => typeof id === 'string');
    }
    if (Array.isArray(msg._data?.contextInfo?.mentionedJidList)) {
        return msg._data.contextInfo.mentionedJidList.filter(id => typeof id === 'string');
    }
    return [];
}

function isBotMentioned(chat, mentionedIds) {
    if (!chat.isGroup) return false;
    const myId = client?.info?.wid?._serialized;
    return !!(myId && mentionedIds.includes(myId));
}

function stripPrefix(messageBody) {
    return messageBody.replace(/^!perwira\s*/i, '').trim();
}

function buildGroupMeta(chat) {
    return {
        name: chat?.name || 'Grup',
        phones: [],
        raw: null,
        senderNumber: chat?.id?._serialized || ''
    };
}

function applyHeader(replyText) {
    const header = '*Perwira (AI Assistant by Rifky)*';
    if (!replyText) return header;
    const trimmed = replyText.trim();
    if (trimmed.startsWith(header)) return trimmed;
    return `${header}\n\n${trimmed}`;
}

function buildContactMeta(specialContact, senderName, senderNumber) {
    const phones = Array.isArray(specialContact?.phone) ? specialContact.phone : [];
    return {
        name: specialContact?.name || senderName || 'Kontak',
        phones,
        raw: specialContact || null,
        senderNumber
    };
}

function scheduleChatSummary(chatId, contactMeta) {
    if (summaryTimers.has(chatId)) {
        clearTimeout(summaryTimers.get(chatId));
    }

    const timer = setTimeout(() => flushChatSummary(chatId, contactMeta), SUMMARY_WINDOW_MS);
    summaryTimers.set(chatId, timer);
}

async function flushChatSummary(chatId, contactMeta) {
    const logs = getMessagesByChat(chatId);
    if (!logs.length) {
        summaryTimers.delete(chatId);
        return;
    }

    const fullLogText = logs.map(item => item.text).join('\n');

    try {
        const summary = await generateGroqSummary(fullLogText);

        addConversationSummary({
            chatId,
            contactName: contactMeta?.name || 'Kontak',
            phones: contactMeta?.phones || [],
            senderNumber: contactMeta?.senderNumber || '',
            timestamp: Date.now(),
            summary
        });
    } catch (err) {
        console.error('Gagal membuat ringkasan dinamis:', err);
    }

    clearMessagesByChat(chatId);
    summaryTimers.delete(chatId);
}

async function handleMessage(msg) {
    if (msg.from.includes('@newsletter') || msg.from === 'status@broadcast' || msg.to === 'status@broadcast') return;

    const chat = await msg.getChat();
    const isGroup = chat.isGroup;
    const messageBody = (msg.body || '').trim();
    const lowerBody = messageBody.toLowerCase();
    const hasPrefix = lowerBody.startsWith('!perwira');
    const senderId = isGroup ? (msg.author || msg.from) : msg.from;
    // WhatsApp sekarang pakai format @lid (Linked ID), bukan @c.us
    // Ambil nomor telepon asli dari Contact object
    let senderNumber = '';
    try {
        const contact = await msg.getContact();
        senderNumber = contact?.number || senderId.replace(/@(c\.us|lid|s\.whatsapp\.net)/g, '');
    } catch (err) {
        senderNumber = senderId.replace(/@(c\.us|lid|s\.whatsapp\.net)/g, '');
    }
    const senderName = msg._data?.notifyName || senderNumber || 'Pengirim';
    const chatIdContext = chat.id._serialized;
    let mentionedIds = getMentionedIds(msg);
    if ((!mentionedIds || mentionedIds.length === 0) && typeof msg.getMentions === 'function') {
        try {
            const contacts = await msg.getMentions();
            mentionedIds = contacts
                .map(c => c?.id?._serialized)
                .filter(id => typeof id === 'string');
        } catch (err) {
            console.error('Gagal mengambil mentions:', err);
            mentionedIds = [];
        }
    }
    if ((!mentionedIds || mentionedIds.length === 0) && typeof msg.getGroupMentions === 'function') {
        try {
            const participants = await msg.getGroupMentions();
            mentionedIds = participants
                .map(p => p?.id?._serialized || p?._serialized)
                .filter(id => typeof id === 'string');
        } catch (err) {
            console.error('Gagal mengambil group mentions:', err);
        }
    }
    const botMentioned = isBotMentioned(chat, mentionedIds);
    const isFromMe = msg.fromMe === true;
    const isVoiceNote = msg.type === 'ptt' || msg._data?.isVoice === true;
    let isReplyToBot = false;

    if (msg.hasQuotedMsg) {
        try {
            const quoted = await msg.getQuotedMessage();
            isReplyToBot = !!quoted?.fromMe;
        } catch (err) {
            console.error('Gagal memeriksa quoted message:', err);
        }
    }

    const specialContact = isGroup ? null : getSpecialContact(senderId, senderName);
    const promptContact = specialContact?.instruction ? specialContact : null;
    const contactMeta = isGroup ? buildGroupMeta(chat) : buildContactMeta(specialContact, senderName, senderNumber);

    // --- WHITELIST CHECK ---
    let isAllowedUser = isFromMe; // Owner always allowed
    if (!isFromMe) {
        if (isGroup) {
            // Check group whitelist
            if (!isGroupAllowed(chatIdContext)) {
                console.log(`[Whitelist] Grup ditolak: "${chat.name}" (ID: ${chatIdContext})`);
                return; // Silently ignore non-whitelisted groups
            }
            isAllowedUser = true; // If group is allowed, anyone inside is "allowed" (contextually)
        } else {
            // Check number whitelist for private chats
            if (isNumberAllowed(senderNumber)) {
                isAllowedUser = true;
            } else {
                console.log(`[Whitelist] Nomor ditolak: ${senderNumber}`);
                return; // Silently ignore non-whitelisted private messages
            }
        }
    }

    // Commands (Owner OR Whitelisted Users)
    if (isAllowedUser) {
        if (lowerBody === '!aktif') {
            setBotStatus(true);
            await msg.reply('Bot diaktifkan.');
            return;
        }

        if (lowerBody === '!mati') {
            setBotStatus(false);
            await msg.reply('Bot dijeda.');
            return;
        }

        if (lowerBody === '!help') {
            const helpText = [
                '*Perwira (AI Assistant by Rifky)*',
                'Daftar perintah:',
                '- !aktif : Mengaktifkan balasan Perwira-AI.',
                '- !mati : Menjeda balasan Perwira-AI.',
                '- !ctt <teks> : Simpan catatan mendesak.',
                '- !hpsctt : Hapus catatan mendesak.',
                '- !cekctt : Lihat catatan mendesak aktif.',
                '- !perwira <pesan> : Paksa Perwira-AI merespons (wajib di grup).'
            ].join('\n');
            await msg.reply(helpText);
            return;
        }

        if (lowerBody.startsWith('!ctt')) {
            const note = messageBody.replace(/^!ctt\s*/i, '').trim();
            if (note) {
                saveUrgentNote(note);
                await msg.reply(`Catatan mendesak disimpan: ${note}`);
            } else {
                await msg.reply('Isi catatan tidak boleh kosong.');
            }
            return;
        }

        if (lowerBody === '!hpsctt') {
            deleteUrgentNote();
            await msg.reply('Catatan mendesak dihapus.');
            return;
        }

        if (lowerBody === '!cekctt') {
            const note = getUrgentNote();
            await msg.reply(note ? `Catatan aktif: ${note}` : 'Tidak ada catatan aktif.');
            return;
        }
    }

    if (!getBotStatus()) return;

    const shouldRespond = isGroup
        ? (botMentioned || isReplyToBot || hasPrefix)
        : (isFromMe ? hasPrefix : true); // fromMe hanya jika pakai !perwira (cegah loop), whitelist user selalu dibalas
    if (!shouldRespond) return;

    const cleanedText = hasPrefix ? stripPrefix(messageBody) : messageBody;
    let userText = cleanedText || (msg.hasMedia ? '[media]' : '');

    // --- HANDLE CONTACT (VCARD) ---
    if (msg.type === 'vcard' || msg.type === 'multi_vcard') {
        const nameMatch = messageBody.match(/FN:(.+)/);
        const contactName = nameMatch ? nameMatch[1].trim() : 'Seseorang';
        
        // Extract number from waid or TEL field
        const waidMatch = messageBody.match(/waid=(\d+)/);
        const telMatch = messageBody.match(/TEL.*:([+\d\s-]+)/);
        const contactNumber = waidMatch ? waidMatch[1] : (telMatch ? telMatch[1].replace(/\D/g, '') : 'Tidak diketahui');

        userText = `[Sistem: User mengirim kontak: "${contactName}" (Nomor: ${contactNumber})]`;
    }

    let downloadedMedia = null;
    if (msg.hasMedia) {
        try {
            const media = await msg.downloadMedia();
            downloadedMedia = media ? { data: media.data, mimetype: media.mimetype } : null;
        } catch (err) {
            console.error('Gagal mengunduh media:', err);
        }
    }

    let mediaData = null;
    if (downloadedMedia) {
        const mimeType = downloadedMedia.mimetype || '';
        const isAudioMedia = mimeType.startsWith('audio/');

        if (isVoiceNote || isAudioMedia) {
            const transcription = await transcribeVoiceNote(downloadedMedia);
            if (transcription) {
                userText = `[Voice Note]\n${transcription}`;
            } else {
                userText = '[Voice Note] (gagal ditranskripsi)';
            }
        } else if (mimeType.startsWith('image/')) {
            mediaData = downloadedMedia;
        }
    }

    recordIncoming(chatIdContext, senderName, userText);
    scheduleChatSummary(chatIdContext, contactMeta);

    const promptSenderName = isGroup ? (chat.name || senderName) : senderName;

    const payload = {
        msgInstance: msg,
        senderName,
        promptSenderName,
        textInput: userText,
        chatIdContext,
        specialContact: promptContact,
        mediaData
    };

    enqueuePrivateMessage(payload);
}

function enqueuePrivateMessage(payload) {
    const queue = privateMessageQueues.get(payload.chatIdContext) || [];
    queue.push(payload);
    privateMessageQueues.set(payload.chatIdContext, queue);

    if (privateDebounceTimers.has(payload.chatIdContext)) {
        clearTimeout(privateDebounceTimers.get(payload.chatIdContext));
    }

    const timer = setTimeout(() => flushPrivateQueue(payload.chatIdContext), DEBOUNCE_TIME);
    privateDebounceTimers.set(payload.chatIdContext, timer);
}

async function flushPrivateQueue(chatId) {
    const queue = privateMessageQueues.get(chatId) || [];
    privateMessageQueues.delete(chatId);

    if (privateDebounceTimers.has(chatId)) {
        clearTimeout(privateDebounceTimers.get(chatId));
        privateDebounceTimers.delete(chatId);
    }

    if (!queue.length) return;

    const latest = queue[queue.length - 1];
    const combinedText = queue.map(item => item.textInput).filter(Boolean).join('\n');
    const mediaData = queue.map(item => item.mediaData).find(Boolean) || null;

    await processAIResponse(
        latest.msgInstance,
        latest.promptSenderName,
        combinedText || (mediaData ? '[media]' : ''),
        chatId,
        latest.specialContact,
        mediaData
    );
}

async function processAIResponse(msgInstance, promptSenderName, textInput, chatIdContext, specialContact, mediaData) {
    const chat = await msgInstance.getChat();
    const historyLogs = buildHistoryLogs(chatIdContext);
    const retrievedContext = await searchRelevantContext(textInput);

    // Delay sebelum reply (natural feel, tanpa typing indicator)
    await new Promise(resolve => setTimeout(resolve, mediaData ? 3000 : 2000));

    // --- GOOGLE INTEGRATION (Opsional) ---
    if (!googleAuthClient && !googleAuthAttempted) {
        googleAuthAttempted = true;
        try {
            googleAuthClient = await authorize();
            if (googleAuthClient) {
                console.log('Google Auth berhasil.');
            } else {
                console.warn('Google Auth tidak tersedia. Bot tetap jalan tanpa Google Calendar/Tasks.');
            }
        } catch (err) {
            console.warn('Google Auth gagal:', err.message || err);
            console.warn('Bot tetap jalan tanpa Google Calendar/Tasks.');
            googleAuthClient = null;
        }
    }
    
    // Fetch real-time data (returns fallback strings if auth is null)
    let dailyAgenda = 'Google Calendar tidak tersedia.';
    let pendingTasks = 'Google Tasks tidak tersedia.';
    if (googleAuthClient) {
        try {
            [dailyAgenda, pendingTasks] = await Promise.all([
                listUpcomingEvents(googleAuthClient),
                listTasks(googleAuthClient)
            ]);
        } catch (err) {
            console.warn('Gagal mengambil data Google:', err.message);
        }
    }

    let fullResponse;
    if (mediaData) {
        fullResponse = await generateVisionResponse(
            promptSenderName,
            textInput,
            historyLogs,
            specialContact,
            getUrgentNote(),
            retrievedContext,
            mediaData,
            dailyAgenda,
            pendingTasks,
            chatIdContext
        );
    } else {
        fullResponse = await generateAIResponse(
            promptSenderName, 
            textInput, 
            historyLogs, 
            specialContact, 
            getUrgentNote(), 
            retrievedContext, 
            dailyAgenda, 
            pendingTasks,
            chatIdContext
        );
    }

    // --- HANDLE TOOL CALLS (JSON) ---
    // Refactored to toolService.js
    const { cleanReply: processedReply, actionResult } = await parseAndExecuteTool(fullResponse, googleAuthClient);
    
    const parts = typeof processedReply === 'string' ? processedReply.split('|||') : [''];
    let chatReply = applyHeader(parts[0] ? parts[0].trim() : '');

    // Append action result to reply
    if (actionResult) {
        chatReply += `\n\n[Sistem]: ${actionResult}`;
    }

    if (chatReply) {
        const logName = promptSenderName || (msgInstance._data?.notifyName) || chatIdContext;
        try {
            await msgInstance.reply(chatReply);
            console.log(`Perwira-AI membalas ke ${logName}: "${chatReply.substring(0, 50)}..."`);
        } catch (err) {
            console.error('Gagal mengirim balasan:', err);
        }
    }


    if (parts.length > 1) {
        const chatId = msgInstance.from;
        const now = Date.now();
        const lastSentTime = statusCooldowns.get(chatId) || 0;

        if (now - lastSentTime > COOLDOWN_DURATION) {
            const infoStatus = parts[1].trim();
            try {
                await new Promise(resolve => setTimeout(resolve, 1000));
                await client.sendMessage(chatId, infoStatus);
                statusCooldowns.set(chatId, now);
                console.log(`Info status dikirim ke ${senderName}`);
            } catch (err) {
                console.error('Gagal mengirim status tambahan:', err);
            }
        }
    }

    if (chatReply) {
        addMessageToBuffer({
            chatId: chatIdContext,
            text: `[Perwira-AI]: ${chatReply}`,
            timestamp: Date.now()
        });
    }
}

module.exports = handleMessage;
