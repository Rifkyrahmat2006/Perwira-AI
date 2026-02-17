const { 
    createEvent, createTask, deleteEvent, updateEvent, 
    deleteTask, updateTask 
} = require('./googleService');
const { saveUrgentNote, deleteUrgentNote } = require('../database/db');
const { 
    addAllowedNumber, removeAllowedNumber, 
    addAllowedGroup, removeAllowedGroup 
} = require('./contactService');

async function executeToolAction(jsonString, googleAuthClient) {
    try {
        const actionData = JSON.parse(jsonString);
        
        if (!actionData || !actionData.action) return null;

        console.log(`Executing Tool Action: ${actionData.action}`);

        switch (actionData.action) {
            case 'create_event':
                return await createEvent(googleAuthClient, actionData.summary, actionData.startTime, actionData.endTime);
            case 'edit_event':
                return await updateEvent(googleAuthClient, actionData.eventId, actionData.summary, actionData.startTime, actionData.endTime);
            case 'delete_event':
                return await deleteEvent(googleAuthClient, actionData.eventId);
                
            case 'create_task':
                return await createTask(googleAuthClient, actionData.title, actionData.dueDate);
            case 'edit_task':
                return await updateTask(googleAuthClient, actionData.taskId, actionData.title, actionData.dueDate);
            case 'delete_task':
                return await deleteTask(googleAuthClient, actionData.taskId);
                
            case 'add_note':
            case 'edit_note': // edit = overwrite
                saveUrgentNote(actionData.content);
                return `Catatan disimpan: "${actionData.content}"`;
            case 'delete_note':
                deleteUrgentNote();
                return "Catatan dihapus.";

            case 'add_allowed_number':
            case 'edit_allowed_number':
                return addAllowedNumber(actionData.number, actionData.label);
            case 'remove_allowed_number':
                return removeAllowedNumber(actionData.number);
                
            case 'add_allowed_group':
            case 'edit_allowed_group':
                return addAllowedGroup(actionData.groupId, actionData.label);
            case 'remove_allowed_group':
                return removeAllowedGroup(actionData.groupId);
                
            default:
                return null;
        }
    } catch (err) {
        console.error('Tool execution failed:', err);
        return null;
    }
}

async function parseAndExecuteTool(fullResponse, googleAuthClient) {
    // Strip markdown code blocks first: ```json {...} ``` → {...}
    let processed = fullResponse;
    
    // Coba extract JSON dari dalam code block dulu
    const codeBlockMatch = processed.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
    let jsonCandidate = null;
    let originalMatch = null;

    if (codeBlockMatch) {
        jsonCandidate = codeBlockMatch[1];
        originalMatch = codeBlockMatch[0]; // termasuk ```json ... ```
    } else {
        // Fallback: cari JSON di akhir string
        const jsonMatch = processed.match(/(\{[\s\S]*\})$/);
        if (jsonMatch) {
            jsonCandidate = jsonMatch[0];
            originalMatch = jsonMatch[0];
        } else {
            // Relaxed: cari JSON dimanapun
            const relaxedMatch = processed.match(/(\{[\s\S]*\})/);
            if (relaxedMatch) {
                try {
                    JSON.parse(relaxedMatch[0]);
                    jsonCandidate = relaxedMatch[0];
                    originalMatch = relaxedMatch[0];
                } catch (e) {
                    // Bukan valid JSON
                }
            }
        }
    }

    if (!jsonCandidate) {
        return { cleanReply: fullResponse, actionResult: null };
    }

    try {
        JSON.parse(jsonCandidate);
    } catch (e) {
        return { cleanReply: fullResponse, actionResult: null };
    }

    const actionResult = await executeToolAction(jsonCandidate, googleAuthClient);
    
    let cleanReply = fullResponse;
    
    // Cleanup Logic:
    // 1. If action executed -> Remove JSON.
    // 2. If JSON is empty object {} (AI hallucination) -> Remove JSON.
    
    let shouldStrip = false;
    if (actionResult) {
        shouldStrip = true;
    } else {
        // Cek jika objek kosong {}
        try {
            const obj = JSON.parse(jsonCandidate);
            if (obj && Object.keys(obj).length === 0) {
                shouldStrip = true;
            }
        } catch(e) {}
    }

    if (shouldStrip && originalMatch) {
        // Hapus seluruh blok (termasuk ```json ... ```)
        cleanReply = cleanReply.replace(originalMatch, '').trim();
        // Bersihkan sisa code block kosong yang mungkin tertinggal
        cleanReply = cleanReply.replace(/```(?:json)?\s*```/g, '').trim();
    }
    
    return { cleanReply, actionResult };
}

module.exports = { parseAndExecuteTool };
