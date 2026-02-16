const path = require('path');

function loadContacts() {
    const contactsPath = path.resolve(__dirname, '../data/contacts.json');
    delete require.cache[require.resolve(contactsPath)];
    const data = require(contactsPath);
    return Array.isArray(data) ? data : [];
}

function loadSpecialContacts() {
    try {
        const specialPath = path.resolve(__dirname, '../data/special_contacts.js');
        delete require.cache[require.resolve(specialPath)];
        const data = require(specialPath);
        return Array.isArray(data) ? data : [];
    } catch (err) {
        return [];
    }
}

function loadAllowedNumbers() {
    try {
        const allowedPath = path.resolve(__dirname, '../data/allowed_numbers.json');
        delete require.cache[require.resolve(allowedPath)];
        const data = require(allowedPath);
        return Array.isArray(data) ? data : [];
    } catch (err) {
        console.warn('allowed_numbers.json not found or invalid. No whitelist active.');
        return [];
    }
}

function normalizeNumber(num = '') {
    return (num || '').replace(/\D/g, '');
}

function matchPhone(incomingNumber, contact) {
    const incoming = normalizeNumber(incomingNumber);
    const phones = Array.isArray(contact.phone) ? contact.phone : [];
    return phones.some(p => {
        const normalized = normalizeNumber(p);
        return normalized === incoming || (normalized && incoming.endsWith(normalized)) || (incoming && normalized.endsWith(incoming));
    });
}

/**
 * Check if a number is in the whitelist (allowed_numbers.json).
 * Returns true if the sender is allowed to receive a reply.
 * Owner messages (fromMe) always pass.
 */
function isNumberAllowed(senderNumber) {
    const allowedList = loadAllowedNumbers();
    
    // If whitelist is empty, block everyone (except owner via fromMe check in handler)
    if (!allowedList.length) return false;

    const incoming = normalizeNumber(senderNumber);
    if (!incoming) return false;

    return allowedList.some(entry => {
        const allowed = normalizeNumber(entry.number || '');
        return allowed === incoming || 
               (allowed && incoming.endsWith(allowed)) || 
               (incoming && allowed.endsWith(incoming));
    });
}

function loadAllowedGroups() {
    try {
        const allowedPath = path.resolve(__dirname, '../data/allowed_groups.json');
        delete require.cache[require.resolve(allowedPath)];
        const data = require(allowedPath);
        return Array.isArray(data) ? data : [];
    } catch (err) {
        console.warn('allowed_groups.json not found or invalid. No group whitelist active.');
        return [];
    }
}

/**
 * Check if a group is in the whitelist (allowed_groups.json).
 * Returns true if the group is allowed.
 */
function isGroupAllowed(groupId) {
    const allowedList = loadAllowedGroups();
    
    // If whitelist is empty, block all groups
    if (!allowedList.length) return false;

    return allowedList.some(entry => entry.groupId === groupId);
}

function getSpecialContact(senderNumber, senderName) {
    try {
        const contactsList = [...loadContacts(), ...loadSpecialContacts()];
        const incomingNumber = senderNumber.replace('@c.us', '');

        const specialContact = contactsList.find(c =>
            matchPhone(incomingNumber, c) ||
            (c.name && senderName && senderName.toLowerCase().includes(c.name.toLowerCase()))
        );

        if (specialContact) {
            console.log(`Kontak ditemukan: ${specialContact.name}`);
        }

        return specialContact || null;
    } catch (err) {
        console.error("Error finding special contact:", err);
        return null;
    }
}

module.exports = {
    getSpecialContact,
    isNumberAllowed,
    isGroupAllowed,
    loadContacts,
    loadSpecialContacts
};
